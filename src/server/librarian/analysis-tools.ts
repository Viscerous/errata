import { createHash } from 'node:crypto'
import { tool, jsonSchema, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { suggestionDirectionSchema, type SuggestionDirection } from '../directions/schema'
import { getFragment, listFragments } from '../fragments/storage'
import { FragmentIdSchema, type Fragment } from '@/contracts/story'
import { numberSentences, resolveSegments, segmentText, type TextSegment } from '../llm/segments'
import type {
  LibrarianAnalysis,
  LibrarianAnalysisProgress,
  LibrarianAnalysisProgressStage,
  LibrarianFragmentChangeProposal,
  LibrarianMention,
} from './storage'
import {
  CharacterLiveStateInputSchema,
  EntityLiveStateInputSchema,
  NarrativeDurationInputSchema,
  NarrativeTimeInputSchema,
  SceneLocationInputSchema,
  type CharacterLiveState,
  type CharacterLiveStateInput,
  type CitedEvidence,
  type ContinuityProjection,
  type ContinuityRegistry,
  type EntityLiveState,
  type EntityLiveStateInput,
  type KnowledgeOperation,
  type RegistryEntry,
  type SceneUpdate,
  type StateOperation,
  type ThreadFocus,
  type ThreadOperation,
} from '@/contracts/continuity'
import { normalizeContinuityKey, scopedContinuityIdentity } from '@/lib/continuity-keys'
import { createFragmentTools } from '../llm/tools'
import {
  createFragmentOperationSchema,
  type FragmentChangeOperation,
  type OperationValidation,
  operationEchoFields,
  validateOperations,
} from '../fragments/change-operations'

const mentionTextSchema = z.string().trim().min(1).max(120).describe('The exact name, title, or key term as it appears in the prose, copied verbatim — no added quotes, no paraphrase')

/**
 * Anchor a reported mention to the prose it annotates: the highlight regex can
 * only bind text that actually occurs in the passage (case-insensitive).
 */
export function anchorMentionText(text: string, proseLower: string): string | null {
  const raw = text.trim()
  return raw && proseLower.includes(raw.toLowerCase()) ? raw : null
}

export const mentionInputSchema = z.object({
  fragmentId: FragmentIdSchema.describe('The ID of the mentioned catalog fragment from the catalog (e.g. "kn-bakagu", "ch-buguzi")'),
  text: mentionTextSchema,
})

/** Map collected mentions to the prose annotation shape used for highlighting. */
export function toMentionAnnotations(mentions: LibrarianMention[]) {
  return mentions.map(m => ({ type: 'mention' as const, fragmentId: m.fragmentId, text: m.text }))
}

// --- Collector ---

export interface AnalysisCollector {
  summaryUpdate: string
  /** What happened, one bullet each. Positioned into a timeline by the frame. */
  events: string[]
  mentions: LibrarianMention[]
  candidateFragmentIds: string[]
  contradictions: Array<{
    description: string
    recordCorrectionReason?: string
    fragmentIds: string[]
    sourceSegments?: number[]
    sourceEvidenceText?: string
    conflictingEvidence?: Array<{ fragmentId: string; segments: number[]; evidenceText: string }>
  }>
  fragmentChangeProposals: LibrarianFragmentChangeProposal[]
  continuityProjection: ContinuityProjection
  directions: SuggestionDirection[]
}

export function createEmptyCollector(): AnalysisCollector {
  return {
    summaryUpdate: '',
    events: [],
    mentions: [],
    candidateFragmentIds: [],
    contradictions: [],
    fragmentChangeProposals: [],
    continuityProjection: {
      version: 2,
      scene: { transition: 'uncertain' },
      stateOperations: [],
      threadOperations: [],
      threadFocus: [],
      knowledgeOperations: [],
    },
    directions: [],
  }
}

/**
 * Analyze is given the prose chain and the rolling summary in its context, so
 * these two would only offer a second copy of what it is already looking at.
 * They go unused, and an unused tool is still schema the model reads past.
 * listFragmentTypes stays: proposeNewRecords takes a free-string `type` and this
 * is where the valid ones are named.
 */
const READ_TOOLS_ALREADY_IN_ANALYZE_CONTEXT = ['readProseChain', 'readStorySummary']

/**
 * Where a passage sits relative to the narrative present is a property of the
 * passage, not of each event in it, so the frame positions them all. A per-event
 * field mostly sat empty and otherwise restated the frame, and where the two
 * disagreed it was the model reading `during` as "during another event here"
 * rather than in the frame's sense.
 */
export function timelineEventsFor(
  events: string[],
  scene: ContinuityProjection['scene'],
  summary?: string,
): LibrarianAnalysis['timelineEvents'] {
  const position = scene.line === 'flashback' ? 'before' : 'after'
  if (events && events.length > 0) {
    return events.map((event) => ({ event, position }))
  }
  if (summary && summary.trim().length > 0) {
    return [{ event: summary.trim(), position }]
  }
  return []
}

/**
 * Evidence is a citation, not a quotation. The passage is presented with
 * numbered sentences, so pointing at them is exact by construction and costs
 * one integer rather than a few hundred output characters. Quoted evidence lost
 * whole proposal calls whenever the model could not reproduce the span exactly;
 * there is nothing to mis-transcribe here.
 */
export function forgivingArray<T extends z.ZodTypeAny>(
  elementSchema: T,
  options?: { min?: number; max?: number },
) {
  let arr = z.array(elementSchema)
  if (options?.min !== undefined) arr = arr.min(options.min)
  if (options?.max !== undefined) arr = arr.max(options.max)

  return z.preprocess((val) => {
    if (val === null || val === undefined) return []
    if (Array.isArray(val)) return val
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'n/a') return []
      return [trimmed]
    }
    if (typeof val === 'object') return [val]
    return []
  }, arr)
}

export function forgivingNumberArray<T extends z.ZodType<number> = z.ZodNumber>(
  elementSchema?: T,
  options?: { min?: number; max?: number },
) {
  const schema = elementSchema ?? (z.number().int().positive() as unknown as T)
  let arr = z.array(schema)
  if (options?.min !== undefined) arr = arr.min(options.min)
  if (options?.max !== undefined) arr = arr.max(options.max)

  return z.preprocess((val) => {
    if (val === null || val === undefined) return []
    if (Array.isArray(val)) {
      return val
        .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN))
        .filter((n) => Number.isInteger(n) && n > 0)
    }
    if (typeof val === 'number' && Number.isInteger(val) && val > 0) return [val]
    if (typeof val === 'string') {
      const parsed = parseInt(val, 10)
      if (Number.isInteger(parsed) && parsed > 0) return [parsed]
    }
    return []
  }, arr)
}

const proseCitationSchema = forgivingNumberArray(undefined, { max: 24 })
  .describe('New-prose sentence numbers.')

// This is intentionally a forgiving, default-heavy LLM input schema. The
// normalized result is typed by, and storage-validates against, the strict
// persisted schema; exposing that strict schema to the model would add ceremony
// without adding information.
const sceneSchema = z.object({
  transition: z.preprocess((val) => {
    if (val === 'shift') return 'advance'
    if (val === 'same' || val === 'same-scene') return 'continue'
    if (val === 'flashback') return 'enter-flashback'
    if (val === 'flash-forward') return 'enter-flash-forward'
    return val
  }, z.enum([
    'continue', 'advance', 'cut', 'enter-flashback', 'enter-flash-forward', 'return', 'uncertain',
  ])).default('uncertain')
    .describe('Scene relation: cut starts a new scene on the same line; enter opens a time overlay; return resumes it.'),
  line: z.enum(['present', 'flashback', 'flash-forward', 'uncertain']).optional()
    .describe('Resulting narrative line when established or changed; otherwise omit.'),
  location: SceneLocationInputSchema.optional()
    .describe('Resulting place when established or changed; otherwise omit.'),
  time: NarrativeTimeInputSchema.optional()
    .describe('Resulting story time when established or changed; otherwise omit.'),
  elapsed: NarrativeDurationInputSchema.optional()
    .describe('Elapsed story time for advance; never infer it from passage length.'),
  evidenceSegments: proseCitationSchema
    .describe('Sentence numbers establishing any place, time, or transition change.'),
}).default({ transition: 'uncertain', evidenceSegments: [] })

type SceneInput = z.infer<typeof sceneSchema>
/** Scene claims that must be grounded in the prose rather than inherited. */
function sceneNeedsEvidence(scene: SceneInput): boolean {
  return (scene.transition !== 'continue' && scene.transition !== 'uncertain')
    || (scene.line !== undefined && scene.line !== 'uncertain')
    || scene.location !== undefined
    || scene.time !== undefined
    || scene.elapsed !== undefined
}

/** The current live registry; model-facing entry numbers come directly from it. */
export type ContinuityKeyRegistry = Partial<ContinuityRegistry>

function completeRegistry(registry: ContinuityKeyRegistry): ContinuityRegistry {
  return {
    state: registry.state ?? [],
    thread: registry.thread ?? [],
    knowledge: registry.knowledge ?? [],
  }
}

/** Entries a scoped lane may address; knowledge keys belong to one character. */
function inScope(entries: RegistryEntry[], scope?: string): RegistryEntry[] {
  return entries.filter((entry) => !entry.scope || !scope || entry.scope === scope)
}

const EMPTY_REGISTRY: ContinuityRegistry = { state: [], thread: [], knowledge: [] }

/**
 * A continuity key is only an identity if two observations of the same thing
 * land on the same key. Asking for a free string and describing the rule did not
 * achieve that on its own: a model asked for a free key opens a fresh one per
 * fact, many carrying an invented fragment-id prefix.
 *
 * Reuse is steered by naming the live keys at the point of use and by
 * canonicalizing whatever arrives, not by a closed enum. Splitting the field
 * into existingKey/newKey did enforce the choice, but enforcing it cost the
 * whole batched report whenever the model chose wrong, and that was most of the
 * rejections — a small model cannot reliably pick between two sibling optional
 * fields. Normalization already collapses the spellings the enum was there to
 * collapse, so the enum was buying compliance the fold delivers anyway.
 */
const MAX_STEERED_REGISTRY_KEYS = 24
const MAX_DERIVED_KEY_CHARS = 64


export function buildReportAnalysisInputSchema(
  _input: ContinuityKeyRegistry = {},
  options: { includeDirections?: boolean } = {},
) {
  const report = z.object({
    // Model-authored report text is stored as supplied; this schema only asks
    // for the structure required to interpret it.
    summary: z.string().trim().min(1).max(1200).describe('Concise retrospective summary of the new prose as past history.'),
    characters: forgivingArray(CharacterLiveStateInputSchema, { max: 12 }).default([])
      .describe('Active characters in this scene: physical state, immediate posture, and epistemic updates.'),
    entities: forgivingArray(EntityLiveStateInputSchema, { max: 12 }).default([])
      .describe('Optional non-character entity updates (locations, artefacts, factions) with dynamic state keys.'),
     // Thread strings become stored ThreadOperation.label (max 240); keep the
     // grammar bound at or below that so a full-length string still decodes.
     threads: forgivingArray(z.string().trim().max(240), { max: 12 }).default([])
       .describe('Active narrative threads or open plot questions (e.g. "Who poisoned the king?").'),
    scene: sceneSchema
      .describe('Changed scene frame fields; transition uncertain withdraws the claim.'),
    mentions: forgivingArray(mentionInputSchema, { max: 24 }).default([])
      .describe('Distinct listed-fragment mentions using exact prose text, never bare pronouns.'),
  })

  return options.includeDirections === false
    ? report
    : report.extend({
        directions: forgivingArray(suggestionDirectionSchema, { min: 1, max: 4 })
          .describe('Story-specific options for the next passage; aim for three distinct directions.'),
      })
}

export const contradictionInputSchema = z.object({
  description: z.string().max(500).describe('What the contradiction is'),
  recordCorrectionReason: z.string().trim().min(1).max(500).optional()
    .describe('Why evidence proves the reusable record is wrong; omit for prose errors or unresolved conflicts.'),
  fragmentIds: forgivingArray(z.string().trim().max(64), { max: 6 }).default([])
    .describe('Reusable record IDs involved; grounded findings also need conflictingEvidence.'),
  sourceSegments: forgivingNumberArray(undefined, { max: 12 })
    .describe('Sentence numbers in the new prose carrying the conflicting assertion.'),
  conflictingEvidence: forgivingArray(z.object({
    fragmentId: z.string().trim().max(64),
    segments: forgivingNumberArray(undefined, { max: 24 })
      .describe('Record sentence numbers carrying the incompatible claim.'),
  }), { max: 6 }).default([])
    .describe('Conflicting reusable records cited by sentence; ordinary state changes are not contradictions.'),
})

export type ContradictionInput = z.infer<typeof contradictionInputSchema>

export const reportObservationInputSchema = z.object({
  summary: z.string().trim().min(1).max(1200).describe('Concise retrospective summary of the new prose as past history.'),
  scene: sceneSchema.describe('Changed scene frame fields; transition uncertain withdraws the claim.'),
  mentions: forgivingArray(mentionInputSchema, { max: 24 }).default([])
    .describe('Distinct listed-fragment mentions using exact prose text, never bare pronouns.'),
  candidateFragmentIds: forgivingArray(z.string().trim().max(64), { max: 12 }).default([]).optional()
    .describe('Optional candidate fragment IDs from catalog that may need attention. Omit or leave empty [] if none.'),
  contradictions: forgivingArray(contradictionInputSchema, { max: 6 }).default([]).optional()
    .describe('Optional contradictions with established records. Omit or leave empty [] if none.'),
})

export type ReportObservationInput = z.infer<typeof reportObservationInputSchema>

export const proposalEvidenceSchema = forgivingNumberArray(z.number().int().positive(), { min: 1, max: 24 })
  .describe('New-prose sentence numbers establishing the proposal.')

export const correctionProposalItemSchema = z.object({
  fragmentId: z.string().min(1).max(64).describe('Target fragment ID.'),
  field: z.enum(['content', 'description']).default('content'),
  segment: z.preprocess((val) => (typeof val === 'string' ? parseInt(val, 10) : val), z.number().int().positive())
    .describe('The numbered sentence in that fragment to replace.'),
  newText: z.string().trim().min(1).max(500)
    .describe('Corrected replacement text for the numbered assertion.'),
  reason: z.string().max(500).optional(),
})

export const newFragmentProposalItemSchema = createFragmentOperationSchema.omit({ action: true }).extend({
  description: z.string().trim().max(250).default(''),
})

export const librarianRecordCorrectionsInputSchema = z.object({
  title: z.string().max(100).optional()
    .describe('Optional proposal title.'),
  evidenceSegments: proposalEvidenceSchema
    .describe('New-prose sentence numbers establishing these corrections.'),
  rationale: z.string().trim().max(1200).optional()
    .describe('Optional shared rationale.'),
  corrections: forgivingArray(correctionProposalItemSchema, { min: 1, max: 6 })
    .describe('Localized record corrections grounded by reportAnalysis; not prose errors or unresolved conflicts.'),
})

export const librarianNewRecordsInputSchema = z.object({
  title: z.string().max(100).optional()
    .describe('Optional proposal title.'),
  evidenceSegments: proposalEvidenceSchema
    .describe('New-prose sentence numbers establishing these records.'),
  rationale: z.string().trim().max(1200).optional()
    .describe('Optional shared rationale.'),
  newFragments: forgivingArray(newFragmentProposalItemSchema, { min: 1, max: 4 })
    .describe('New reusable named records established by this prose; not event logs, current conditions, or scene details.'),
})

export const reportContinuityInputSchema = z.object({
  characters: forgivingArray(CharacterLiveStateInputSchema, { max: 12 }).default([])
    .describe('Active characters in this scene: immediate posture, sparse state dictionary of important physical/gear changes, and epistemic updates. Do NOT list absent background cast.'),
  entities: forgivingArray(EntityLiveStateInputSchema, { max: 12 }).default([]).optional()
    .describe('Optional non-character entity updates (locations, artefacts, factions) with dynamic state keys. Omit or leave empty [] if none.'),
  // See reportAnalysis: grammar bound stays at or below stored label max (240).
  threads: forgivingArray(z.string().trim().max(240), { max: 12 }).default([]).optional()
    .describe('Active narrative threads or open plot questions (e.g. "Who poisoned the king?"). Omit or leave empty [] if none.'),
  evidenceSegments: forgivingNumberArray(undefined, { max: 24 }).optional()
    .describe('New-prose sentence numbers establishing any permanent record corrections or new records. Omit or leave empty [] if no corrections.'),
  corrections: forgivingArray(correctionProposalItemSchema, { max: 6 }).default([]).optional()
    .describe('Optional permanent corrections to existing catalog records when canon truly changes; cite fragmentId and segment number from delivered records. Omit or leave empty [] if none.'),
  newRecords: forgivingArray(newFragmentProposalItemSchema, { max: 4 }).default([]).optional()
    .describe('Optional new reusable named records established by this prose (character, knowledge, etc.). Omit or leave empty [] if none.'),
})

export type ReportContinuityInput = z.infer<typeof reportContinuityInputSchema>

export const reportDirectionsInputSchema = z.object({
  directions: forgivingArray(suggestionDirectionSchema, { min: 1, max: 4 })
    .describe('Three distinct narrative directions for the next passage, each with title, description, and instruction.'),
})

export type ReportDirectionsInput = z.infer<typeof reportDirectionsInputSchema>

/** Registry-free shape for the context preview and the tool-name listing. */
export const reportAnalysisInputSchema = buildReportAnalysisInputSchema()

type ReportAnalysisInput = z.infer<ReturnType<typeof buildReportAnalysisInputSchema>>

/**
 * Preserve the strict JSON Schema generated by Zod v4 (including required keys
 * and exact property bounds) so that local inference engines (like llama.cpp's
 * PEG grammar generator) do not loosen required fields or permit arbitrary key loops.
 */
export function toExactJsonSchema<T extends z.ZodTypeAny>(schema: T) {
  const exact = z.toJSONSchema(schema)
  return jsonSchema(exact, {
    validate: (value: unknown) => {
      const result = schema.safeParse(value)
      return result.success ? { success: true, value: result.data } : { success: false, error: result.error }
    },
  })
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * Turn a citation into the stored operation. The resolved text is kept beside
 * the indices so a saved projection stays reviewable, and so the unattended
 * apply path can still re-check it against prose that may since have changed.
 */
function citedEvidence(
  segments: TextSegment[],
  cited: number[],
): { evidence: CitedEvidence; invalid: number[] } {
  const resolved = resolveSegments(segments, cited)
  // `evidence` is the storable half and `invalid` the verdict on it. Returned
  // flat, every lane spread the whole thing into its record and carried the
  // verdict into the projection, leaving stored operations with an `invalid: []`
  // that no type declares and nothing reads.
  return {
    evidence: { evidenceSegments: resolved.indexes.slice(0, 32), evidenceText: resolved.text },
    invalid: resolved.invalid,
  }
}

/** Canonicalize a descriptive field into a key, cut on a word boundary. */
function derivedContinuityKey(source: string | undefined): string {
  const normalized = normalizeContinuityKey(source ?? '')
  if (normalized.length <= MAX_DERIVED_KEY_CHARS) return normalized
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
  const prefixLimit = MAX_DERIVED_KEY_CHARS - digest.length - 1
  const clipped = normalized.slice(0, prefixLimit)
  const lastBreak = clipped.lastIndexOf('_')
  const prefix = lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped
  return `${prefix}_${digest}`
}

/**
 * Canonicalizing is what makes reuse happen: a key that differs from a live one
 * only by case, separator, or a prefixed fragment id lands on the live spelling
 * by construction, so the model does not have to declare which it meant.
 *
 * Creation operations may derive a fresh key from their structured identity or
 * description. Existing identities are addressed only by registry number or
 * stable key; human wording is never treated as semantic identity by code.
 */
function chosenKey(operation: { key?: unknown }, derivedFrom?: string): string | null {
  const declared = typeof operation.key === 'string' ? normalizeContinuityKey(operation.key) : ''
  return declared || derivedContinuityKey(derivedFrom) || null
}

function citationProblem(
  cited: { evidence: CitedEvidence; invalid: number[] },
): string | null {
  if (cited.invalid.length > 0) {
    return `Cited sentence ${cited.invalid.join(', ')} does not exist in the passage.`
  }
  if (cited.evidence.evidenceSegments.length === 0) return 'No supporting sentence was cited.'
  return null
}

/**
 * Dropped work explains itself on the entry, never only in a sibling note
 * beside the list: the trace panel and the model both read entries. Mentions
 * once carried their explanation in a `skippedMentionNote` alone, so dropped
 * mentions rendered as blank rows the moment the panel learned to report
 * refusals at all.
 */
type Skipped<T> = T & { reason: string }

/** The single key an entry set agrees on, or nothing when it is ambiguous. */
function soleKey(entries: RegistryEntry[]): string | undefined {
  const keys = new Set(entries.map((entry) => entry.key))
  return keys.size === 1 ? [...keys][0] : undefined
}

/**
 * The entry the model pointed at. Exact by construction, which is the whole
 * point: every other rung reconstructs an identity from something the model
 * spelled, and spelling is where the identity was being lost.
 */
function registryKeyAtIndex(
  entries: RegistryEntry[],
  entry: unknown,
  scope?: string,
): string | undefined {
  if (typeof entry !== 'number' || !Number.isInteger(entry)) return undefined
  return soleKey(inScope(entries, scope).filter((candidate) => candidate.index === entry))
}

/** Resolve the exact state definition carried by an existing registry address. */
function registeredStateDefinition(
  entries: RegistryEntry[],
  operation: { entry?: unknown; key?: unknown },
  resolvedKey: string,
): Pick<RegistryEntry, 'subject' | 'facet' | 'slot'> | undefined {
  const byEntry = typeof operation.entry === 'number' && Number.isInteger(operation.entry)
    ? entries.filter((candidate) => candidate.index === operation.entry)
    : []
  const candidates = byEntry.length > 0
    ? byEntry
    : entries.filter((candidate) => candidate.key === resolvedKey)
  if (candidates.length !== 1) return undefined
  const [candidate] = candidates
  return candidate.subject && candidate.facet ? candidate : undefined
}

/**
 * The identity an operation addresses, or why it has none.
 *
 * Two rules, one place. An action that can create an identity only needs enough
 * to derive one. An action that cannot — clear, advance, resolve, abandon,
 * correct, forget — can only mean something against an identity that already
 * exists, and until now nothing checked that it did: any spelling was accepted,
 * stored, and matched nothing at fold time, which is exactly how a plausible
 * invented key gets through. Reporting one back costs a single operation;
 * letting it through costs the continuity it was meant to record.
 *
 * `live` carries the registry plus whatever this analysis has already created,
 * and the caller adds to it as identities appear, so a retried report can still
 * address what its own earlier call opened.
 */
function resolveIdentity(
  operation: { key?: unknown; entry?: unknown; action: string },
  derivedFrom: string | undefined,
  options: {
    lane: 'state' | 'thread' | 'knowledge'
    allowDerived: boolean
    live: Set<string>
    registry: RegistryEntry[]
    scope?: string
    /** The derived fields are declared identity components, not prose wording. */
    structuralDerivation?: boolean
  },
): { ok: true; key: string } | { ok: false; reason: string } {
  const { lane, allowDerived, registry, scope } = options
  const addressedKey = registryKeyAtIndex(registry, operation.entry, scope)
    || chosenKey(operation)
  if (addressedKey) {
    if (allowDerived || options.live.has(scopedContinuityIdentity(addressedKey, scope))) {
      return { ok: true, key: addressedKey }
    }
    const listed = inScope(registry, scope)
      .slice(0, MAX_STEERED_REGISTRY_KEYS)
      .map((entry) => `[${entry.index}] ${entry.key}`)
    return {
      ok: false,
      reason: `No ${lane} identity is tracked under ${addressedKey}, so this ${operation.action} would change nothing. `
        + (listed.length > 0
          ? `Cite the entry number of the one you mean: ${listed.join(', ')}.`
          : `The ${lane} registry is empty, so there is nothing to ${operation.action}.`),
    }
  }

  const derivedKey = allowDerived ? chosenKey(operation, derivedFrom) : null
  if (!derivedKey) {
    return {
      ok: false,
      reason: allowDerived
        ? `A ${lane} operation needs enough identity to derive a key.`
        : `A ${lane} ${operation.action} operation must name an existing key.`,
    }
  }
  if (!options.structuralDerivation
    && options.live.has(scopedContinuityIdentity(derivedKey, scope))) {
    return {
      ok: false,
      reason: `The derived ${lane} key ${derivedKey} already exists. Cite its registry entry to reuse it; code does not infer identity from matching human wording.`,
    }
  }
  return { ok: true, key: derivedKey }
}

/** Identities a non-create action may address, before this pass adds its own. */
function liveIdentitySet(entries: RegistryEntry[]): Set<string> {
  return new Set(entries.map((entry) => scopedContinuityIdentity(entry.key, entry.scope)))
}

const CLEARED_STATE_VALUES = new Set(['none', 'cleared', 'removed', 'healed', 'empty', 'normal', 'default', 'null', 'undefined'])

type NormalizedContinuityInput = {
  scene?: SceneUpdate | NonNullable<ReportAnalysisInput['scene']>
  threads?: string[]
  characters?: CharacterLiveStateInput[]
  entities?: EntityLiveStateInput[]
  stateOperations?: any[]
  threadOperations?: any[]
  knowledgeOperations?: any[]
}

function normalizeContinuityProjection(
  input: NormalizedContinuityInput,
  segments: TextSegment[],
  registry: ContinuityRegistry = EMPTY_REGISTRY,
  options?: { checkedFragments?: Map<string, Fragment> },
): { projection: ContinuityProjection; skipped: Array<Skipped<{ kind: string; key: string }>> } {
  const skipped: Array<Skipped<{ kind: string; key: string }>> = []
  let scene: SceneInput & Partial<CitedEvidence> = (input.scene as (SceneInput & Partial<CitedEvidence>)) ?? { transition: 'uncertain', evidenceSegments: [] }
  const requiresSceneEvidence = sceneNeedsEvidence(scene)
  if (requiresSceneEvidence || (scene.evidenceSegments?.length ?? 0) > 0) {
    const resolved = citedEvidence(segments, scene.evidenceSegments ?? [])
    const problem = citationProblem(resolved)
    if (problem && requiresSceneEvidence) {
      const sceneKey = scene.transition !== 'continue' && scene.transition !== 'uncertain'
        ? scene.transition
        : (scene.location?.key ?? scene.time?.label ?? 'frame')
      skipped.push({ kind: 'scene', key: sceneKey, reason: problem })
      scene = { transition: 'uncertain', evidenceSegments: [] }
    } else if (problem) {
      // A `continue` needs no citation. If the model nevertheless supplied an
      // unusable one, retain the valid frame operation without persisting half
      // of the paired evidence contract.
      scene = { ...scene, evidenceSegments: [] }
    } else {
      scene = { ...scene, ...resolved.evidence }
    }
  }
  if (scene.transition === 'enter-flashback') scene = { ...scene, line: 'flashback' }
  if (scene.transition === 'enter-flash-forward') scene = { ...scene, line: 'flash-forward' }

  if (scene.location?.fragmentId) {
    const isValid = (!options?.checkedFragments || options.checkedFragments.has(scene.location.fragmentId))
      && FragmentIdSchema.safeParse(scene.location.fragmentId).success
    if (!isValid) {
      scene = {
        ...scene,
        location: {
          key: scene.location.key,
          label: scene.location.label,
        },
      }
    }
  }

  const liveState = liveIdentitySet(registry.state)
  const stateOperations: StateOperation[] = []
  for (const operation of input.stateOperations ?? []) {
    const allowDerived = operation.action === 'set'
    const derivedStateIdentity = operation.subject && operation.facet
      ? [derivedContinuityKey(operation.subject.label), operation.facet, operation.slot].filter(Boolean).join('_')
      : undefined
    const identity = resolveIdentity(operation, derivedStateIdentity, {
      lane: 'state',
      allowDerived,
      structuralDerivation: true,
      live: liveState,
      registry: registry.state,
    })
    if (!identity.ok) {
      skipped.push({ kind: 'state', key: operation.subject?.label ?? '', reason: identity.reason })
      continue
    }
    const stateKey = identity.key
    if (allowDerived) liveState.add(stateKey)
    const resolved = citedEvidence(segments, operation.evidenceSegments)
    const problem = citationProblem(resolved)
    if (problem) {
      skipped.push({ kind: 'state', key: stateKey, reason: problem })
      continue
    }
    if (operation.action === 'set' && !operation.value?.trim()) {
      skipped.push({ kind: 'state', key: stateKey, reason: 'A set operation requires a value.' })
      continue
    }
    const registeredDefinition = registeredStateDefinition(registry.state, operation, stateKey)
    const validSubjectFragmentId = operation.subject?.fragmentId
      && (!options?.checkedFragments || options.checkedFragments.has(operation.subject.fragmentId))
      && FragmentIdSchema.safeParse(operation.subject.fragmentId).success
      ? operation.subject.fragmentId
      : undefined
    const declaredSubject = operation.subject
      ? {
          key: derivedContinuityKey(operation.subject.label),
          label: operation.subject.label,
          ...(validSubjectFragmentId ? { fragmentId: validSubjectFragmentId } : {}),
        }
      : undefined
    const subject = registeredDefinition?.subject ?? declaredSubject
    const facet = registeredDefinition?.facet ?? operation.facet
    const slot = registeredDefinition?.facet
      ? registeredDefinition.slot
      : operation.slot
    if (operation.action === 'set' && (!subject || !facet)) {
      skipped.push({
        kind: 'state',
        key: stateKey,
        reason: 'A genuinely new set requires a subject and facet; an existing registry entry supplies them automatically.',
      })
      continue
    }
    stateOperations.push(operation.action === 'clear'
      ? { action: 'clear', ...resolved.evidence, stateKey }
      : {
          action: 'set',
          stateKey,
          subject: subject!,
          facet: facet!,
          ...(slot?.trim() ? { slot } : {}),
          value: operation.value!,
          certainty: operation.certainty ?? 'explicit',
          scope: operation.scope ?? 'scene',
          ...(operation.until ? { until: operation.until } : {}),
          ...resolved.evidence,
        })
  }

  const liveThreads = liveIdentitySet(registry.thread)
  const threadOperations: ThreadOperation[] = []
  // Assembled as the operations resolve, so the fold receives the prominence
  // delta without the model having to state each acted-on thread twice.
  const threadFocus: ThreadFocus[] = []

  for (const t of input.threads ?? []) {
    const label = typeof t === 'string' ? t.trim() : ''
    if (!label) continue
    const threadKey = derivedContinuityKey(label)
    threadOperations.push({
      action: 'open',
      threadKey,
      label,
      relatedFragmentIds: [],
      evidenceSegments: [],
      evidenceText: '',
    })
    threadFocus.push({ threadKey, visibility: 'foreground' })
  }

  for (const { visibility, ...operation } of input.threadOperations ?? []) {
    const allowDerived = operation.action === 'open'
    const identity = resolveIdentity(operation, operation.label || operation.note, {
      lane: 'thread',
      allowDerived,
      live: liveThreads,
      registry: registry.thread,
    })
    if (!identity.ok) {
      skipped.push({ kind: 'thread', key: operation.label ?? '', reason: identity.reason })
      continue
    }
    const threadKey = identity.key
    if (allowDerived) liveThreads.add(threadKey)
    const resolved = citedEvidence(segments, operation.evidenceSegments)
    const problem = citationProblem(resolved)
    if (problem) {
      skipped.push({ kind: 'thread', key: threadKey, reason: problem })
      continue
    }
    const validRelatedFragmentIds = uniqueStrings(operation.relatedFragmentIds).filter(
      (id) => !options?.checkedFragments || options.checkedFragments.has(id),
    )
    threadOperations.push({
      threadKey,
      action: operation.action,
      ...(operation.label?.trim() ? { label: operation.label } : {}),
      ...(operation.note?.trim() ? { note: operation.note } : {}),
      relatedFragmentIds: validRelatedFragmentIds,
      ...resolved.evidence,
    })
    // Acting on a thread puts it in view; a resolved or abandoned one is gone
    // and cannot be.
    if (operation.action === 'open' || operation.action === 'advance') {
      threadFocus.push({ threadKey, visibility: visibility ?? 'foreground' })
    }
  }

  const liveKnowledge = liveIdentitySet(registry.knowledge)
  const knowledgeOperations: KnowledgeOperation[] = []
  for (const operation of input.knowledgeOperations ?? []) {
    if (options?.checkedFragments) {
      const charFragment = options.checkedFragments.get(operation.characterId)
      if (!charFragment) {
        skipped.push({
          kind: 'knowledge',
          key: operation.characterId,
          reason: `Character fragment "${operation.characterId}" does not exist in the story catalog.`,
        })
        continue
      }
      if (charFragment.type !== 'character') {
        skipped.push({
          kind: 'knowledge',
          key: operation.characterId,
          reason: `Fragment "${operation.characterId}" is a ${charFragment.type}, not a character. Knowledge operations must target character records.`,
        })
        continue
      }
    }
    const allowDerived = operation.action === 'learn'
    const identity = resolveIdentity(operation, operation.fact, {
      lane: 'knowledge',
      allowDerived,
      live: liveKnowledge,
      registry: registry.knowledge,
      scope: operation.characterId,
    })
    if (!identity.ok) {
      skipped.push({ kind: 'knowledge', key: operation.characterId, reason: identity.reason })
      continue
    }
    const knowledgeKey = identity.key
    if (allowDerived) liveKnowledge.add(scopedContinuityIdentity(knowledgeKey, operation.characterId))
    const label = `${operation.characterId}:${knowledgeKey}`
    const resolved = citedEvidence(segments, operation.evidenceSegments)
    const problem = citationProblem(resolved)
    if (problem) {
      skipped.push({ kind: 'knowledge', key: label, reason: problem })
      continue
    }
    if (operation.action !== 'forget' && !operation.fact?.trim()) {
      skipped.push({ kind: 'knowledge', key: label, reason: 'Learning or correcting knowledge requires a fact.' })
      continue
    }
    knowledgeOperations.push({
      characterId: operation.characterId,
      knowledgeKey,
      action: operation.action,
      ...(operation.fact?.trim() ? { fact: operation.fact } : {}),
      acquisition: operation.acquisition ?? 'other',
      ...resolved.evidence,
    })
  }

  const characterStates: Record<string, CharacterLiveState> = {}
  for (const c of input.characters ?? []) {
    const suppliedName = c.name?.trim() ?? ''
    let resolvedId = c.characterId?.trim() || c.id?.trim()
    if (resolvedId && options?.checkedFragments) {
      const match = options.checkedFragments.get(resolvedId)
      if (!match || match.type !== 'character') {
        resolvedId = undefined
      }
    }
    // `name` is optional at the boundary: a model that cites the catalog id
    // need not restate the name the catalog already carries.
    const name = suppliedName
      || (resolvedId && options?.checkedFragments ? (options.checkedFragments.get(resolvedId)?.name ?? '').trim() : '')
    if (!name) {
      skipped.push({
        kind: 'character',
        key: resolvedId || suppliedName || 'unnamed',
        reason: 'A character item needs a name, or a characterId/id that resolves to a delivered character.',
      })
      continue
    }
    if (!resolvedId && options?.checkedFragments) {
      for (const [fid, fragment] of options.checkedFragments) {
        if (fragment.type === 'character' && fragment.name.trim().toLowerCase() === name.toLowerCase()) {
          resolvedId = fid
          break
        }
      }
    }

    const stateRecord: Record<string, string> = {}
    if (c.state) {
      for (const entry of c.state) {
        const key = entry.key.trim()
        if (!key) continue
        const val = entry.value.trim()
        stateRecord[key] = CLEARED_STATE_VALUES.has(val.toLowerCase()) ? '' : val
      }
    }

    const charImmediate = c.immediate?.trim() ?? ''
    const knowledge = (c.knowledge ?? [])
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter((k) => k.length > 0)
    const secrets = (c.secrets ?? [])
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => s.length > 0)

    const validCharId = resolvedId && FragmentIdSchema.safeParse(resolvedId).success ? resolvedId : undefined
    const stateKey = resolvedId ?? derivedContinuityKey(name)
    characterStates[stateKey] = {
      ...(validCharId ? { characterId: validCharId } : {}),
      name,
      ...(charImmediate ? { immediate: charImmediate } : {}),
      ...(Object.keys(stateRecord).length > 0 ? { state: stateRecord } : {}),
      ...(knowledge.length > 0 ? { knowledge: [...new Set(knowledge)] } : {}),
      ...(secrets.length > 0 ? { secrets: [...new Set(secrets)] } : {}),
    }
  }

  const entityStates: Record<string, EntityLiveState> = {}
  for (const e of input.entities ?? []) {
    const suppliedName = e.name?.trim() ?? ''
    let resolvedId = e.entityId?.trim() || e.id?.trim()
    if (resolvedId && options?.checkedFragments) {
      const match = options.checkedFragments.get(resolvedId)
      if (!match) resolvedId = undefined
    }
    // `name` is optional at the boundary: a model that cites the catalog id
    // need not restate the name the catalog already carries.
    const name = suppliedName
      || (resolvedId && options?.checkedFragments ? (options.checkedFragments.get(resolvedId)?.name ?? '').trim() : '')
    if (!name) {
      skipped.push({
        kind: 'entity',
        key: resolvedId || suppliedName || 'unnamed',
        reason: 'An entity item needs a name, or an entityId/id that resolves to a delivered record.',
      })
      continue
    }
    if (!resolvedId && options?.checkedFragments) {
      for (const [fid, fragment] of options.checkedFragments) {
        if (fragment.name.trim().toLowerCase() === name.toLowerCase()) {
          resolvedId = fid
          break
        }
      }
    }

    const stateRecord: Record<string, string> = {}
    if (e.state) {
      for (const entry of e.state) {
        const key = entry.key.trim()
        if (!key) continue
        const val = entry.value.trim()
        stateRecord[key] = CLEARED_STATE_VALUES.has(val.toLowerCase()) ? '' : val
      }
    }

    const entImmediate = e.immediate?.trim() ?? ''
    const notes = (e.notes ?? [])
      .map((n) => (typeof n === 'string' ? n.trim() : ''))
      .filter((n) => n.length > 0)

    const validEntId = resolvedId && FragmentIdSchema.safeParse(resolvedId).success ? resolvedId : undefined
    const stateKey = resolvedId ?? derivedContinuityKey(name)
    entityStates[stateKey] = {
      ...(validEntId ? { entityId: validEntId } : {}),
      name,
      ...(e.category ? { category: e.category } : {}),
      ...(entImmediate ? { immediate: entImmediate } : {}),
      ...(Object.keys(stateRecord).length > 0 ? { state: stateRecord } : {}),
      ...(notes.length > 0 ? { notes: [...new Set(notes)] } : {}),
    }
  }

  const locKey = scene.location?.key?.trim() ?? ''
  const locLabel = scene.location?.label?.trim() ?? ''
  const sanitizedLocation = scene.location && (locKey || locLabel)
    ? {
        key: locKey || derivedContinuityKey(locLabel),
        label: locLabel || locKey,
        ...(scene.location.fragmentId ? { fragmentId: scene.location.fragmentId } : {}),
      }
    : undefined

  const sanitizedTime = scene.time
    ? {
        label: scene.time.label,
        certainty: scene.time.certainty,
        ...(scene.time.calendar ? { calendar: scene.time.calendar } : {}),
      }
    : undefined

  const sanitizedElapsed = scene.elapsed
    ? {
        label: scene.elapsed.label,
        ...(scene.elapsed.minimumSeconds != null ? { minimumSeconds: scene.elapsed.minimumSeconds } : {}),
        ...(scene.elapsed.maximumSeconds != null ? { maximumSeconds: scene.elapsed.maximumSeconds } : {}),
      }
    : undefined

  const storedScene: SceneUpdate = {
    transition: scene.transition,
    ...(scene.line ? { line: scene.line } : {}),
    ...(sanitizedLocation ? { location: sanitizedLocation } : {}),
    ...(sanitizedTime ? { time: sanitizedTime } : {}),
    ...(sanitizedElapsed ? { elapsed: sanitizedElapsed } : {}),
    ...((scene.evidenceSegments?.length ?? 0) > 0 ? {
      evidenceSegments: scene.evidenceSegments,
      ...(scene.evidenceText ? { evidenceText: scene.evidenceText } : {}),
    } : {}),
  }
  return {
    projection: {
      version: 2,
      scene: storedScene,
      stateOperations,
      threadOperations,
      threadFocus,
      knowledgeOperations,
      ...(Object.keys(characterStates).length > 0 ? { characterStates } : {}),
      ...(Object.keys(entityStates).length > 0 ? { entityStates } : {}),
    },
    skipped,
  }
}

type AnalysisProposalSkipped = Skipped<{
  operationId: string
  action: FragmentChangeOperation['action']
  target?: OperationValidation['target']
  errors?: string[]
}>

function validationMessage(result: OperationValidation): string {
  return result.errors?.map((error) => error.message).join('; ') || 'Operation was not valid.'
}

function skippedOperation(
  result: OperationValidation,
  reason = validationMessage(result),
): AnalysisProposalSkipped {
  return {
    operationId: result.operationId,
    action: result.action,
    target: result.target,
    reason,
    errors: result.errors?.map((error) => error.message),
  }
}

function proposalTargets(proposal: { operations: FragmentChangeOperation[] }): Set<string> {
  const targets = new Set<string>()
  for (const op of proposal.operations) {
    if (op.action === 'replace_text') {
      targets.add(`${op.fragmentId}:${op.field}`)
    } else if (op.action === 'create_fragment') {
      const name = op.name.trim().toLowerCase()
      if (name) targets.add(`create:${op.type}:${name}`)
    }
  }
  return targets
}

function queueFragmentChangeProposal(params: {
  collector: AnalysisCollector
  title?: string
  rationale?: string
  proposalKind: 'correction' | 'new-fragment'
  evidenceSegments?: number[]
  evidenceText?: string
  eligibilityReason?: string
  autoApplySafe?: boolean
  operations: FragmentChangeOperation[]
  validation: OperationValidation[]
}): void {
  const title = params.title?.trim() ?? ''
  const rationale = params.rationale?.trim() ?? ''
  const eligibilityReason = params.eligibilityReason?.trim() ?? ''
  if (params.operations.length === 0) return

  let autoApplySafe = params.autoApplySafe ?? true
  const newTargets = proposalTargets(params)
  if (newTargets.size > 0) {
    for (const existing of params.collector.fragmentChangeProposals) {
      const existingTargets = proposalTargets(existing)
      const hasConflict = [...newTargets].some((target) => existingTargets.has(target))
      if (hasConflict) {
        existing.autoApplySafe = false
        autoApplySafe = false
      }
    }
  }

  params.collector.fragmentChangeProposals.push({
    ...(title ? { title } : {}),
    ...(rationale ? { rationale } : {}),
    proposalKind: params.proposalKind,
    ...(params.evidenceSegments?.length ? { evidenceSegments: params.evidenceSegments } : {}),
    ...(params.evidenceText ? { evidenceText: params.evidenceText } : {}),
    ...(eligibilityReason ? { eligibilityReason } : {}),
    autoApplySafe,
    operations: params.operations,
    validation: params.validation,
  })
}

function correctionContractError(operation: FragmentChangeOperation): string | null {
  if (operation.action !== 'replace_text') {
    return 'Corrections may only replace an exact existing assertion. Record events and state changes in reportAnalysis; use newFragments for a new reusable record.'
  }
  if (operation.replaceAll) {
    return 'Corrections cannot replace every occurrence automatically; identify one exact assertion and occurrence.'
  }
  return null
}

/** Bodies are numbered so a correction can address a sentence instead of retyping one. */
const MAX_DELIVERED_FRAGMENTS = 24

/**
 * Deliver the records not shown numbered yet, and register that they now are.
 * One ledger carries both halves of the rule: nothing is sent twice, and nothing
 * is addressable that was never numbered.
 */
function deliverResolvedFragments(
  loaded: Map<string, Fragment>,
  referencedIds: string[],
  numberedFragmentIds: Set<string>,
): Array<{ id: string; type: string; name: string; description: string; content: string }> {
  const delivered: Array<{ id: string; type: string; name: string; description: string; content: string }> = []
  for (const fragmentId of referencedIds) {
    if (delivered.length >= MAX_DELIVERED_FRAGMENTS) break
    if (numberedFragmentIds.has(fragmentId)) continue
    const fragment = loaded.get(fragmentId)
    if (!fragment) continue
    numberedFragmentIds.add(fragmentId)
    delivered.push({
      id: fragment.id,
      type: fragment.type,
      name: fragment.name,
      description: fragment.description,
      content: numberSentences(fragment.content),
    })
  }
  return delivered
}

// --- Tools ---

export function createAnalysisTools(
  collector: AnalysisCollector,
  opts?: { 
    dataDir: string; 
    storyId: string; 
    proseFragmentId?: string; 
    disableDirections?: boolean; 
    disableSuggestions?: boolean;
    includeReadTools?: boolean;
    includeReportTool?: boolean;
    numberedFragmentIds?: Set<string> | readonly string[];
    continuityKeys?: ContinuityKeyRegistry;
    customFragmentTypes?: Array<{ type: string; name: string }>;
    onProgress?: (progress: LibrarianAnalysisProgress) => void;
  },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {}
  /**
   * Every record the model has been shown numbered, from context blocks, reads,
   * or resolved reports. It is what makes a segment number mean anything: an
   * unread record still segments server-side, so a citation against one resolves
   * to a real sentence, just not the one being counted to.
   *
   * Held by reference — pipeline compilation adds the context-block half after
   * the tools exist, once user block overrides settle what is actually shown.
   */
  const numberedFragmentIds = opts?.numberedFragmentIds instanceof Set
    ? opts.numberedFragmentIds
    : new Set(opts?.numberedFragmentIds ?? [])
  let hasReported = false
  const unnumberedProposalAttemptIds = new Set<string>()
  // Normalized once here; every lookup below reads the same shape and numbering.
  const continuityRegistry = completeRegistry(opts?.continuityKeys ?? {})
  const emitProgress = (stage: LibrarianAnalysisProgressStage) => {
    if (!opts?.onProgress || !opts.proseFragmentId) return
    if (!hasReported && stage !== 'observation') return
    opts.onProgress(structuredClone({
      fragmentId: opts.proseFragmentId,
      stage,
      summaryUpdate: collector.summaryUpdate,
      continuityProjection: collector.continuityProjection,
      mentions: collector.mentions,
      contradictions: collector.contradictions,
      fragmentChangeProposals: collector.fragmentChangeProposals.map((proposal) => ({
        ...proposal,
        sourceFragmentId: opts.proseFragmentId,
      })),
      timelineEvents: timelineEventsFor(collector.events, collector.continuityProjection.scene, collector.summaryUpdate),
      directions: collector.directions,
    }))
  }

  const customTypes = opts?.customFragmentTypes ?? []
  const allowedTypes = ['character', 'knowledge', ...customTypes.map((t) => t.type)]

  const resolveEvidence = async (cited: number[]) => {
    if (!opts?.proseFragmentId) {
      return { evidence: { evidenceSegments: cited, evidenceText: '' } }
    }
    const prose = await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId)
    const resolved = citedEvidence(segmentText(prose?.content ?? ''), cited)
    const problem = citationProblem(resolved)
    if (problem) {
      return {
        error: {
          ok: false,
          proposalCount: collector.fragmentChangeProposals.length,
          queuedOperationCount: 0,
          invalid: 1,
          evidenceMatched: false,
          note: `${problem} Cite sentence numbers from the New Prose Fragment.`,
        },
      }
    }
    return { evidence: resolved.evidence }
  }

  /** A proposal call is one atomic, self-contained author-facing change. */
  const queueValidatedProposal = async (params: {
    toolName: 'proposeRecordCorrections' | 'proposeNewRecords' | 'reportContinuity'
    proposalKind: 'correction' | 'new-fragment'
    evidence: CitedEvidence
    title?: string
    rationale?: string
    operations: FragmentChangeOperation[]
    rejected?: AnalysisProposalSkipped[]
  }) => {
    const skipped: AnalysisProposalSkipped[] = [...(params.rejected ?? [])]
    for (const operation of params.operations) {
      if (operation.action === 'replace_text') {
        const contractError = correctionContractError(operation)
        if (contractError) {
          skipped.push({ operationId: operation.operationId ?? '', action: operation.action, reason: contractError })
        }
      }
    }

    const validation = (skipped.length === 0 && opts)
      ? await validateOperations(opts.dataDir, opts.storyId, params.operations, {
        allowedCreateTypes: allowedTypes,
        createTypeScopeDescription: 'librarian analysis proposals',
      })
      : { operations: [], results: [] as OperationValidation[] }
    for (const result of validation.results) {
      if (result.status !== 'valid') skipped.push(skippedOperation(result))
    }

    if (skipped.length > 0 || (opts && validation.operations.length !== params.operations.length)) {
      return {
        ok: false,
        proposalCount: collector.fragmentChangeProposals.length,
        queuedOperationCount: 0,
        invalid: skipped.length,
        evidenceMatched: true,
        ...operationEchoFields(validation.results),
        skipped,
        note: 'The proposal was not queued because one or more operations were invalid.',
      }
    }

    queueFragmentChangeProposal({
      collector,
      title: params.title,
      rationale: params.rationale,
      proposalKind: params.proposalKind,
      evidenceSegments: params.evidence.evidenceSegments,
      evidenceText: params.evidence.evidenceText,
      eligibilityReason: params.rationale,
      autoApplySafe: true,
      operations: validation.operations,
      validation: validation.results,
    })
    emitProgress('record-maintenance')
    return {
      ok: true,
      proposalCount: collector.fragmentChangeProposals.length,
      queuedOperationCount: validation.operations.length,
      invalid: 0,
      evidenceMatched: true,
      autoApplySafe: true,
      ...operationEchoFields(validation.results),
    }
  }

  const resolveCorrectionOperations = async (corrections: Array<z.infer<typeof correctionProposalItemSchema>>) => {
    const unresolved: AnalysisProposalSkipped[] = []
    const operations: FragmentChangeOperation[] = []
    for (const correction of corrections) {
      const field = correction.field ?? 'content'
      const target = opts ? await getFragment(opts.dataDir, opts.storyId, correction.fragmentId) : null
      const current = target?.[field]
      if (!target || typeof current !== 'string') {
        unresolved.push({
          operationId: '',
          action: 'replace_text',
          reason: `There is no reusable record ${correction.fragmentId}${field === 'content' ? '' : ` with a ${field} field`}.`,
        })
        continue
      }
      if (!numberedFragmentIds.has(correction.fragmentId)) {
        unnumberedProposalAttemptIds.add(correction.fragmentId)
        unresolved.push({
          operationId: '',
          action: 'replace_text',
          reason: `${correction.fragmentId} has not been shown with numbered sentences. Include it in candidateFragmentIds or report mentions to inspect its numbered sentences.`,
        })
        continue
      }
      const segments = segmentText(current)
      const segment = segments.find((candidate) => candidate.index === correction.segment)
      if (!segment) {
        unresolved.push({
          operationId: '',
          action: 'replace_text',
          reason: `${correction.fragmentId}.${field} has ${segments.length} numbered sentences; ${correction.segment} is not one of them.`,
        })
        continue
      }
      const twins = segments.filter((candidate) => candidate.text === segment.text)
      operations.push({
        action: 'replace_text',
        fragmentId: correction.fragmentId,
        field,
        oldText: segment.text,
        newText: correction.newText,
        replaceAll: false,
        ...(twins.length > 1
          ? { occurrence: twins.findIndex((candidate) => candidate.index === segment.index) + 1 }
          : {}),
        ...(correction.reason ? { reason: correction.reason } : {}),
      })
    }
    return { operations, unresolved }
  }

  if (opts?.includeReportTool !== false) {
    tools.reportAnalysis = tool({
      description: 'Report all prose findings in one self-contained batch. Evidence fields cite numbered sentences.',
      inputSchema: toExactJsonSchema(buildReportAnalysisInputSchema(opts?.continuityKeys ?? {}, {
        includeDirections: false,
      })),
      execute: async (input: ReportAnalysisInput & Record<string, any>) => {
        const {
          summary,
          characters = [],
          entities = [],
          threads = [],
          mentions = [],
          scene = { transition: 'uncertain', evidenceSegments: [] },
          // Legacy programmatic fallbacks
          events = [],
          stateOperations = [],
          threadOperations = [],
          knowledgeOperations = [],
        } = input
        const candidateFragmentIds: string[] = Array.isArray(input.candidateFragmentIds)
          ? input.candidateFragmentIds.filter((id: unknown): id is string => typeof id === 'string')
          : []
        const contradictions: ContradictionInput[] = Array.isArray(input.contradictions)
          ? (input.contradictions as ContradictionInput[])
          : []
        const rawDirections = 'directions' in input && Array.isArray(input.directions)
          ? input.directions
          : []
        const directions: SuggestionDirection[] = rawDirections.map((d: any) => {
          const title = (d.title || d.label || d.summary || 'Direction').trim()
          const instruction = (d.instruction || d.prompt || d.description || '').trim()
          const description = (d.description || d.summary || d.instruction || d.prompt || '').trim()
          return {
            title,
            description,
            instruction,
          }
        })
        const sourceProse = opts?.proseFragmentId
          ? await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId)
          : null

        if (!summary || summary.trim().length === 0) {
          return {
            ok: false,
            note: 'Empty summary: please provide a concise retrospective summary of what happened in the prose.',
          }
        }

        const checkedFragments = new Map<string, Fragment>()
        if (opts) {
          try {
            const allStoryFragments = await listFragments(opts.dataDir, opts.storyId)
            for (const f of allStoryFragments) {
              checkedFragments.set(f.id, f)
            }
          } catch {
            const uniqueIds = [...new Set<string>([
              ...mentions.map((m) => m.fragmentId).filter(Boolean),
              ...candidateFragmentIds,
              ...contradictions.flatMap((c: any) => [
                ...(c.fragmentIds ?? []),
                ...(c.conflictingEvidence ?? []).map((evidence: any) => evidence.fragmentId),
              ]),
              ...(scene.location?.fragmentId ? [scene.location.fragmentId] : []),
              ...((stateOperations ?? []).flatMap((op: any) => op?.subject?.fragmentId ? [op.subject.fragmentId] : [])),
              ...((threadOperations ?? []).flatMap((operation: any) => operation?.relatedFragmentIds ?? [])),
              ...((knowledgeOperations ?? []).map((operation: any) => operation?.characterId)),
              ...characters.flatMap((c) => [c.id, c.characterId]).filter((id): id is string => Boolean(id)),
              ...entities.flatMap((e) => [e.id, e.entityId]).filter((id): id is string => Boolean(id)),
            ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]

            const checks = await Promise.all(
              uniqueIds.map(async (fid) => ({ fid, fragment: await getFragment(opts.dataDir, opts.storyId, fid) })),
            )
            for (const check of checks) {
              if (check.fragment) checkedFragments.set(check.fid, check.fragment)
            }
          }
        }

        // The same segmentation the prompt block rendered, so the numbers the
        // model saw are the numbers resolved here.
        const proseSegments = segmentText(sourceProse?.content ?? '')
        const normalizedProjection = normalizeContinuityProjection({
          scene,
          threads,
          characters,
          entities,
          stateOperations: stateOperations ?? undefined,
          threadOperations: threadOperations ?? undefined,
          knowledgeOperations: knowledgeOperations ?? undefined,
        }, proseSegments, continuityRegistry, {
          checkedFragments: opts ? checkedFragments : undefined,
        })
        collector.continuityProjection = normalizedProjection.projection

        const candidateEvents = input.events ?? events
        const rawEvents: string[] = Array.isArray(candidateEvents)
          ? candidateEvents
          : (typeof candidateEvents === 'string' && candidateEvents.trim().length > 0 ? [candidateEvents.trim()] : [])
        collector.events = rawEvents
        collector.summaryUpdate = summary
        collector.directions = directions

        // A highlight can only bind text that actually occurs in the passage.
        const skippedMentions: Array<Skipped<{ fragmentId: string; text: string }>> = []
        const anchoredMentions: LibrarianMention[] = []
        const proseLower = (opts?.proseFragmentId && sourceProse?.content)
          ? sourceProse.content.toLowerCase()
          : null

        for (const m of mentions) {
          const fid = m.fragmentId.trim()
          const text = m.text.trim()
          if (!text) continue
          if (!fid || (opts && !checkedFragments.has(fid))) {
            skippedMentions.push({
              fragmentId: fid,
              text,
              reason: `Unknown fragment ID "${fid}". Mentions must cite existing catalog records.`,
            })
            continue
          }
          if (proseLower) {
            const anchored = anchorMentionText(text, proseLower)
            if (anchored == null) {
              skippedMentions.push({
                fragmentId: fid,
                text,
                reason: 'Not verbatim in the passage, so it cannot be highlighted.',
              })
              continue
            }
            anchoredMentions.push({ fragmentId: fid, text: anchored })
          } else {
            anchoredMentions.push({ fragmentId: fid, text })
          }
        }

        collector.mentions = anchoredMentions
        const validCandidateFragmentIds = opts
          ? candidateFragmentIds.filter((id) => checkedFragments.has(id))
          : candidateFragmentIds
        collector.candidateFragmentIds = [...new Set(validCandidateFragmentIds)]

        // Mentions become resolved context for the next writer turn; durable
        // candidates additionally constrain continuity and record maintenance.
        // Both deltas come back here rather than through readFragments: this
        // call already loaded every referenced fragment to validate its ID, so
        // making the model fetch what the process is holding buys only round
        // trips.
        const resolvedFragments = deliverResolvedFragments(
          checkedFragments,
          [...anchoredMentions.map((mention) => mention.fragmentId), ...validCandidateFragmentIds],
          numberedFragmentIds,
        )
        // Mention bodies improve the next writer context but do not, by
        // themselves, justify another Analyze request. Candidate IDs are the
        // model explicitly asking to inspect durable assertions, so only a
        // newly delivered candidate keeps the inspection stage open.
        const candidateIds = new Set([...validCandidateFragmentIds, ...unnumberedProposalAttemptIds])
        const inspectionRequired = resolvedFragments.some((fragment) => candidateIds.has(fragment.id))
        unnumberedProposalAttemptIds.clear()

        const skippedContradictions: Array<Skipped<{ description: string }>> = []
        const groundedContradictions: AnalysisCollector['contradictions'] = []
        for (const contradiction of contradictions) {
          // Pure/test consumers have no durable records to cite. The
          // online Librarian must ground both sides so a plausible narrative
          // transition cannot become a permanent red flag merely because the
          // model called it a contradiction.
          if (!opts?.proseFragmentId) {
            groundedContradictions.push({
              ...contradiction,
              recordCorrectionReason: contradiction.recordCorrectionReason ?? undefined,
              conflictingEvidence: (contradiction.conflictingEvidence ?? [])
                .map((evidence: any) => ({ ...evidence, evidenceText: '' })),
            })
            continue
          }
          const citedSource = citedEvidence(proseSegments, contradiction.sourceSegments ?? [])
          const citationIssue = citationProblem(citedSource)
          if (citationIssue) {
            skippedContradictions.push({
              description: contradiction.description,
              reason: citationIssue,
            })
            continue
          }
          if ((contradiction.conflictingEvidence ?? []).length === 0) {
            skippedContradictions.push({
              description: contradiction.description,
              reason: 'The finding did not cite a conflicting sentence in a reusable record.',
            })
            continue
          }

          // The record is shown sentence-numbered too, so the conflicting side
          // is cited rather than re-quoted, exactly like the prose side.
          const evidenceChecks = await Promise.all((contradiction.conflictingEvidence ?? []).map(async (evidence: any) => {
            const fragment = checkedFragments.get(evidence.fragmentId)
              ?? await getFragment(opts.dataDir, opts.storyId, evidence.fragmentId)
            const reusable = Boolean(fragment && fragment.type !== 'prose' && fragment.type !== 'summary')
            const resolved = reusable
              ? citedEvidence(segmentText(fragment!.content), evidence.segments)
              : { evidence: { evidenceSegments: [] as number[], evidenceText: '' }, invalid: [] as number[] }
            return { fragmentId: evidence.fragmentId, valid: reusable && citationProblem(resolved) === null, resolved }
          }))
          const badEvidence = evidenceChecks.find((check) => !check.valid)
          if (badEvidence) {
            skippedContradictions.push({
              description: contradiction.description,
              reason: `Cite the numbered sentence in ${badEvidence.fragmentId} that carries the incompatible claim; it must be a reusable non-prose record.`,
            })
            continue
          }
          const conflictingEvidence = evidenceChecks.map((check) => ({
            fragmentId: check.fragmentId,
            segments: check.resolved.evidence.evidenceSegments,
            evidenceText: check.resolved.evidence.evidenceText,
          }))
          groundedContradictions.push({
            description: contradiction.description,
            ...(contradiction.recordCorrectionReason ? { recordCorrectionReason: contradiction.recordCorrectionReason } : {}),
            fragmentIds: uniqueStrings(evidenceChecks.map((check) => check.fragmentId)),
            sourceSegments: citedSource.evidence.evidenceSegments,
            sourceEvidenceText: citedSource.evidence.evidenceText,
            conflictingEvidence,
          })
        }
        collector.contradictions = groundedContradictions

        hasReported = true
        emitProgress(inspectionRequired
          ? 'inspection'
          : opts?.disableDirections === true ? 'observation' : 'directions')
        return {
          ok: true,
          mentionCount: collector.mentions.length,
          candidateFragmentCount: collector.candidateFragmentIds.length,
          contradictionCount: collector.contradictions.length,
          eventCount: collector.events.length,
          stateOperationCount: collector.continuityProjection.stateOperations.length,
          threadOperationCount: collector.continuityProjection.threadOperations.length,
          focusedThreadCount: collector.continuityProjection.threadFocus.length,
          knowledgeOperationCount: collector.continuityProjection.knowledgeOperations.length,
          directionCount: collector.directions.length,
          directionsProvided: collector.directions.length > 0,
          ...(resolvedFragments.length > 0 ? {
            resolvedFragments,
            resolvedFragmentNote: 'Full records for what you just reported, not already in your context. Their sentences are numbered for correction targeting. Use them for directions and record maintenance; no further reads are needed for these.',
          } : {}),
          ...(inspectionRequired ? { inspectionRequired: true } : {}),
          ...(normalizedProjection.skipped.length > 0 ? { skippedContinuity: normalizedProjection.skipped } : {}),
          ...(skippedMentions.length > 0 ? {
            skippedMentions,
            skippedMentionNote: 'These texts do not appear verbatim in the prose, or cite unknown records, and were not stored as highlights.',
          } : {}),
          ...(skippedContradictions.length > 0 ? {
            skippedContradictions,
            skippedContradictionNote: 'Contradictions are review findings, not guesses. Cite sentence numbers on both sides.',
          } : {}),
        }
      },
    })

    tools.reportObservation = tool({
      description: 'Step 1 of 3: Report grounded narrative observations: retrospective summary, scene frame, catalog mentions, and candidate/contradiction records.',
      inputSchema: toExactJsonSchema(reportObservationInputSchema),
      execute: async (input: ReportObservationInput) => {
        const {
          summary,
          scene = { transition: 'uncertain', evidenceSegments: [] },
          mentions = [],
          candidateFragmentIds = [],
          contradictions = [],
        } = input
        if (!summary || summary.trim().length === 0) {
          return { ok: false, note: 'Empty summary: please provide a concise retrospective summary of the prose.' }
        }

        const sourceProse = opts?.proseFragmentId
          ? await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId)
          : null
        const proseSegments = segmentText(sourceProse?.content ?? '')

        const checkedFragments = new Map<string, Fragment>()
        if (opts) {
          try {
            const allStoryFragments = await listFragments(opts.dataDir, opts.storyId)
            for (const f of allStoryFragments) checkedFragments.set(f.id, f)
          } catch {
            // best-effort fallback
          }
          if (checkedFragments.size === 0) {
            const uniqueIds = [...new Set<string>([
              ...mentions.map((m) => m.fragmentId).filter(Boolean),
              ...candidateFragmentIds,
              ...contradictions.flatMap((c: any) => [
                ...(c.fragmentIds ?? []),
                ...(c.conflictingEvidence ?? []).map((evidence: any) => evidence.fragmentId),
              ]),
              ...(scene.location?.fragmentId ? [scene.location.fragmentId] : []),
            ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]

            const checks = await Promise.all(
              uniqueIds.map(async (fid) => ({ fid, fragment: await getFragment(opts.dataDir, opts.storyId, fid) })),
            )
            for (const check of checks) {
              if (check.fragment) checkedFragments.set(check.fid, check.fragment)
            }
          }
        }

        const normalizedProjection = normalizeContinuityProjection({
          scene,
        }, proseSegments, continuityRegistry, {
          checkedFragments: opts ? checkedFragments : undefined,
        })
        collector.continuityProjection.scene = normalizedProjection.projection.scene
        collector.summaryUpdate = summary

        // Anchor mentions
        const skippedMentions: Array<Skipped<{ fragmentId: string; text: string }>> = []
        const anchoredMentions: LibrarianMention[] = []
        const proseLower = (opts?.proseFragmentId && sourceProse?.content)
          ? sourceProse.content.toLowerCase()
          : null

        for (const m of mentions) {
          const fid = m.fragmentId.trim()
          const text = m.text.trim()
          if (!text) continue
          if (!fid || (opts && !checkedFragments.has(fid))) {
            skippedMentions.push({
              fragmentId: fid,
              text,
              reason: `Unknown fragment ID "${fid}". Mentions must cite existing catalog records.`,
            })
            continue
          }
          if (proseLower) {
            const anchored = anchorMentionText(text, proseLower)
            if (anchored == null) {
              skippedMentions.push({
                fragmentId: fid,
                text,
                reason: 'Not verbatim in the passage, so it cannot be highlighted.',
              })
              continue
            }
            anchoredMentions.push({ fragmentId: fid, text: anchored })
          } else {
            anchoredMentions.push({ fragmentId: fid, text })
          }
        }

        collector.mentions = anchoredMentions

        const rawCandidateIds = (candidateFragmentIds ?? []).filter((id): id is string => typeof id === 'string')
        const validCandidateFragmentIds = opts
          ? rawCandidateIds.filter((id) => checkedFragments.has(id))
          : rawCandidateIds
        collector.candidateFragmentIds = [...new Set(validCandidateFragmentIds)]

        // Contradiction Grounding
        const skippedContradictions: Array<Skipped<{ description: string }>> = []
        const groundedContradictions: AnalysisCollector['contradictions'] = []
        for (const contradiction of contradictions) {
          if (!opts?.proseFragmentId) {
            groundedContradictions.push({
              ...contradiction,
              recordCorrectionReason: contradiction.recordCorrectionReason ?? undefined,
              conflictingEvidence: (contradiction.conflictingEvidence ?? [])
                .map((evidence: any) => ({ ...evidence, evidenceText: '' })),
            })
            continue
          }
          const citedSource = citedEvidence(proseSegments, contradiction.sourceSegments ?? [])
          const citationIssue = citationProblem(citedSource)
          if (citationIssue) {
            skippedContradictions.push({
              description: contradiction.description,
              reason: citationIssue,
            })
            continue
          }
          if ((contradiction.conflictingEvidence ?? []).length === 0) {
            skippedContradictions.push({
              description: contradiction.description,
              reason: 'The finding did not cite a conflicting sentence in a reusable record.',
            })
            continue
          }

          const evidenceChecks = await Promise.all((contradiction.conflictingEvidence ?? []).map(async (evidence: any) => {
            const fragment = checkedFragments.get(evidence.fragmentId)
              ?? await getFragment(opts.dataDir, opts.storyId, evidence.fragmentId)
            const reusable = Boolean(fragment && fragment.type !== 'prose' && fragment.type !== 'summary')
            const resolved = reusable
              ? citedEvidence(segmentText(fragment!.content), evidence.segments)
              : { evidence: { evidenceSegments: [] as number[], evidenceText: '' }, invalid: [] as number[] }
            return { fragmentId: evidence.fragmentId, valid: reusable && citationProblem(resolved) === null, resolved }
          }))
          const badEvidence = evidenceChecks.find((check) => !check.valid)
          if (badEvidence) {
            skippedContradictions.push({
              description: contradiction.description,
              reason: `Cite the numbered sentence in ${badEvidence.fragmentId} that carries the incompatible claim; it must be a reusable non-prose record.`,
            })
            continue
          }
          const conflictingEvidence = evidenceChecks.map((check) => ({
            fragmentId: check.fragmentId,
            segments: check.resolved.evidence.evidenceSegments,
            evidenceText: check.resolved.evidence.evidenceText,
          }))
          groundedContradictions.push({
            description: contradiction.description,
            ...(contradiction.recordCorrectionReason ? { recordCorrectionReason: contradiction.recordCorrectionReason } : {}),
            fragmentIds: uniqueStrings(evidenceChecks.map((check) => check.fragmentId)),
            sourceSegments: citedSource.evidence.evidenceSegments,
            sourceEvidenceText: citedSource.evidence.evidenceText,
            conflictingEvidence,
          })
        }
        collector.contradictions = groundedContradictions

        // Deliver resolved fragments with numbered sentences for mentions, candidates, and contradictory records
        const fragmentIdsToDeliver = uniqueStrings([
          ...anchoredMentions.map((mention) => mention.fragmentId),
          ...validCandidateFragmentIds,
          ...groundedContradictions.flatMap((c) => c.conflictingEvidence?.map((e) => e.fragmentId) ?? []),
        ])
        const resolvedFragments = deliverResolvedFragments(
          checkedFragments,
          fragmentIdsToDeliver,
          numberedFragmentIds,
        )

        hasReported = true
        emitProgress('observation')

        return {
          ok: true,
          nextInstruction: 'Step 1 complete. Now execute reportContinuity for characters physically present in this scene. Note only significant physical or gear changes (e.g. broken weapon, injury) as key/value pairs in state. If no changes occurred, omit state or leave it empty []. If no permanent corrections or new records are needed, leave corrections and newRecords empty [].',
          summaryLength: summary.length,
          mentionCount: anchoredMentions.length,
          candidateFragmentCount: collector.candidateFragmentIds.length,
          contradictionCount: collector.contradictions.length,
          sceneTransition: collector.continuityProjection.scene?.transition ?? 'uncertain',
          ...(resolvedFragments.length > 0 ? {
            resolvedFragments,
            resolvedFragmentNote: 'Full records for what you just reported, not already in your context. Their sentences are numbered for correction targeting. Use them for continuity and record maintenance; no further reads are needed for these.',
          } : {}),
          ...(skippedMentions.length > 0 ? { skippedMentions } : {}),
          ...(skippedContradictions.length > 0 ? { skippedContradictions } : {}),
        }
      },
    })

    tools.reportContinuity = tool({
      description: 'Step 2 of 3: Report active character working memory (immediate kinetic posture, sparse state of important changes like a broken weapon or injury, knowledge, secrets), entity states, threads, and optional record corrections. If no permanent corrections are needed, leave corrections empty [].',
      inputSchema: toExactJsonSchema(reportContinuityInputSchema),
      execute: async (input: ReportContinuityInput) => {
        const {
          characters = [],
          entities = [],
          threads = [],
          evidenceSegments = [],
          corrections = [],
          newRecords = [],
        } = input
        const sourceProse = opts?.proseFragmentId
          ? await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId)
          : null
        const proseSegments = segmentText(sourceProse?.content ?? '')

        const checkedFragments = new Map<string, Fragment>()
        if (opts) {
          try {
            const allStoryFragments = await listFragments(opts.dataDir, opts.storyId)
            for (const f of allStoryFragments) checkedFragments.set(f.id, f)
          } catch {
            // best-effort fallback
          }
          if (checkedFragments.size === 0) {
            const uniqueIds = [...new Set<string>([
              ...characters.flatMap((c) => [c.id, c.characterId]).filter((id): id is string => Boolean(id)),
              ...entities.flatMap((e) => [e.id, e.entityId]).filter((id): id is string => Boolean(id)),
              ...(corrections ?? []).map((c) => c.fragmentId),
            ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]

            const checks = await Promise.all(
              uniqueIds.map(async (fid) => ({ fid, fragment: await getFragment(opts.dataDir, opts.storyId, fid) })),
            )
            for (const check of checks) {
              if (check.fragment) checkedFragments.set(check.fid, check.fragment)
            }
          }
        }

        const normalizedProjection = normalizeContinuityProjection({
          scene: collector.continuityProjection.scene,
          characters,
          entities,
          threads,
        }, proseSegments, continuityRegistry, {
          checkedFragments: opts ? checkedFragments : undefined,
        })

        collector.continuityProjection.characterStates = normalizedProjection.projection.characterStates
        collector.continuityProjection.entityStates = normalizedProjection.projection.entityStates
        collector.continuityProjection.threadOperations = normalizedProjection.projection.threadOperations
        collector.continuityProjection.threadFocus = normalizedProjection.projection.threadFocus

        // Record proposals: corrections and new reusable records
        const proposalSkipped: any[] = []
        if (opts?.disableSuggestions !== true && opts?.proseFragmentId) {
          if (corrections && corrections.length > 0) {
            const evidence = await resolveEvidence(evidenceSegments)
            if (evidence.error) {
              proposalSkipped.push(evidence.error)
            } else {
              const { operations, unresolved } = await resolveCorrectionOperations(corrections)
              const result = await queueValidatedProposal({
                toolName: 'reportContinuity',
                proposalKind: 'correction',
                evidence: evidence.evidence!,
                operations,
                rejected: unresolved,
              })
              if (!result.ok && 'skipped' in result && Array.isArray(result.skipped)) {
                proposalSkipped.push(...result.skipped)
              }
            }
          }

          if (newRecords && newRecords.length > 0) {
            const evidence = await resolveEvidence(evidenceSegments)
            if (evidence.error) {
              proposalSkipped.push(evidence.error)
            } else {
              const result = await queueValidatedProposal({
                toolName: 'reportContinuity',
                proposalKind: 'new-fragment',
                evidence: evidence.evidence!,
                operations: newRecords.map((operation) => ({ ...operation, description: operation.description ?? '', action: 'create_fragment' as const })),
              })
              if (!result.ok && 'skipped' in result && Array.isArray(result.skipped)) {
                proposalSkipped.push(...result.skipped)
              }
            }
          }
        }

        emitProgress(collector.fragmentChangeProposals.length > 0 ? 'record-maintenance' : 'observation')

        return {
          ok: true,
          nextInstruction: 'Step 2 complete. Now execute reportDirections to report three distinct creative narrative directions for the next passage.',
          characterCount: Object.keys(normalizedProjection.projection.characterStates ?? {}).length,
          entityCount: Object.keys(normalizedProjection.projection.entityStates ?? {}).length,
          threadCount: (normalizedProjection.projection.threadOperations ?? []).length,
          proposalCount: collector.fragmentChangeProposals.length,
          ...(normalizedProjection.skipped.length > 0 ? { skippedContinuity: normalizedProjection.skipped } : {}),
          ...(proposalSkipped.length > 0 ? { skippedProposals: proposalSkipped } : {}),
        }
      },
    })
  }

  if (opts?.disableDirections !== true) {
    tools.reportDirections = tool({
      description: 'Step 3 of 3: Report three distinct creative narrative directions for what could happen in the next passage. Analysis is complete after this call.',
      inputSchema: toExactJsonSchema(reportDirectionsInputSchema),
      execute: async (input: ReportDirectionsInput) => {
        collector.directions = input.directions
        emitProgress('directions')
        return {
          ok: true,
          nextInstruction: 'Step 3 complete. Analysis finished.',
          directionCount: collector.directions.length,
        }
      },
    })
  }

  if (opts && opts.includeReadTools !== false) {
    // Sharing the ledger is what makes a read the way to earn a record's
    // numbers, rather than a second presentation that forgets to grant them.
    const readTools = createFragmentTools(opts.dataDir, opts.storyId, {
      readOnly: true,
      numberedFragmentIds,
      skipNumberedFragments: true,
    })
    for (const name of READ_TOOLS_ALREADY_IN_ANALYZE_CONTEXT) delete readTools[name]
    Object.assign(tools, readTools)
  }

  if (!opts?.disableSuggestions && opts?.proseFragmentId) {
    tools.proposeRecordCorrections = tool({
      description: 'Queue author-reviewed corrections for reusable records proven wrong by a grounded reportAnalysis finding. Do not rewrite prose or unresolved conflicts.',
      inputSchema: librarianRecordCorrectionsInputSchema,
      execute: async ({ title, evidenceSegments, rationale, corrections }) => {
        const evidence = await resolveEvidence(evidenceSegments)
        if (evidence.error) return evidence.error
        const { operations, unresolved } = await resolveCorrectionOperations(corrections)
        return queueValidatedProposal({
          toolName: 'proposeRecordCorrections',
          proposalKind: 'correction',
          evidence: evidence.evidence!,
          title,
          rationale,
          operations,
          rejected: unresolved,
        })
      },
    })

    tools.proposeNewRecords = tool({
      description: `Queue new reusable named records established by the prose; not events, temporary conditions, unnamed scenery, or feelings. Allowed type values: ${allowedTypes.join(', ')}.`,
      inputSchema: librarianNewRecordsInputSchema,
      execute: async ({ title, evidenceSegments, rationale, newFragments }) => {
        const evidence = await resolveEvidence(evidenceSegments)
        if (evidence.error) return evidence.error
        return queueValidatedProposal({
          toolName: 'proposeNewRecords',
          proposalKind: 'new-fragment',
          evidence: evidence.evidence!,
          title,
          rationale,
          operations: newFragments.map((operation) => ({ ...operation, description: operation.description ?? '', action: 'create_fragment' as const })),
        })
      },
    })
  }

  return tools
}

/**
 * The analyze toolset. Single source for the runtime handler and the agent's
 * available-tools list, so the toggle path and the model stay in sync.
 *
 * Online analysis uses one shared collector and numbered-record ledger. The
 * adaptive Analyze loop reports its observation, then reads/proposes as needed
 * without returning bodies already available in the prompt or tool history.
 * Deeper router/audit/backfill jobs can feed candidates into this same shape.
 */
export function createLibrarianOnlineTools(
  collector: AnalysisCollector,
  opts: {
    dataDir: string
    storyId: string
    proseFragmentId?: string
    disableDirections?: boolean
    disableSuggestions?: boolean
    numberedFragmentIds?: Set<string> | readonly string[]
    continuityKeys?: ContinuityKeyRegistry
    customFragmentTypes?: Array<{ type: string; name: string }>
    onProgress?: (progress: LibrarianAnalysisProgress) => void
  },
): ToolSet {
  return createAnalysisTools(collector, {
    ...opts,
    includeReadTools: opts.disableSuggestions !== true || opts.disableDirections !== true,
    includeReportTool: true,
  })
}

/** Tool names the analyze agent exposes — drives the toggle list with no drift. */
export function listLibrarianAnalyzeToolNames(): string[] {
  return Object.keys(createLibrarianOnlineTools(createEmptyCollector(), {
    dataDir: '',
    storyId: '',
    proseFragmentId: 'pr-preview',
  }))
}
