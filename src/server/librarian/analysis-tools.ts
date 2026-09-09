import { createHash } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { suggestionDirectionSchema, type SuggestionDirection } from '../directions/schema'
import { getFragment } from '../fragments/storage'
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
  NarrativeDurationInputSchema,
  NarrativeTimeInputSchema,
  SceneLocationInputSchema,
  type CitedEvidence,
  type ContinuityProjection,
  type ContinuityRegistry,
  type KnowledgeOperation,
  type RegistryEntry,
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
  unknownFragmentIdsMessage,
  validateOperations,
} from '../fragments/change-operations'

const mentionTextSchema = z.string().trim().min(1).describe('The exact name, title, or key term as it appears in the prose, copied verbatim — no added quotes, no paraphrase')

/**
 * Anchor a reported mention to the prose it annotates: the highlight regex can
 * only bind text that actually occurs in the passage (case-insensitive).
 */
export function anchorMentionText(text: string, proseLower: string): string | null {
  const raw = text.trim()
  return raw && proseLower.includes(raw.toLowerCase()) ? raw : null
}

export const mentionInputSchema = z.object({
  fragmentId: FragmentIdSchema.describe('The ID of the mentioned fragment'),
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
): LibrarianAnalysis['timelineEvents'] {
  const position = scene.line === 'flashback' ? 'before' : 'after'
  return events.map((event) => ({ event, position }))
}

const stringArray = z.array(z.string()).default([])

/**
 * Evidence is a citation, not a quotation. The passage is presented with
 * numbered sentences, so pointing at them is exact by construction and costs
 * one integer rather than a few hundred output characters. Quoted evidence lost
 * whole proposal calls whenever the model could not reproduce the span exactly;
 * there is nothing to mis-transcribe here.
 */
const proseCitationSchema = z.array(z.number().int().positive()).default([])
  .describe('New-prose sentence numbers.')

// This is intentionally a forgiving, default-heavy LLM input schema. The
// normalized result is typed by, and storage-validates against, the strict
// persisted schema; exposing that strict schema to the model would add ceremony
// without adding information.
const sceneSchema = z.object({
  transition: z.enum([
    'continue', 'advance', 'cut', 'enter-flashback', 'enter-flash-forward', 'return', 'uncertain',
  ]).default('uncertain')
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
    .describe('Sentence numbers establishing the scene, place, or time change.'),
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

/** Bound on any continuity key, whether the model spelled it or it was derived. */
const MAX_CONTINUITY_KEY_CHARS = 100
const MAX_DERIVED_KEY_CHARS = 64

/**
 * The two ways to name a continuity identity: point at a numbered registry
 * entry, or spell the key. Every addressable field in the report shares this
 * shape so one idea is not two shapes within one schema.
 */
function registryAddressFields(
  entryDescription: string,
  keyDescription: string,
) {
  const entrySchema = z.number().int().positive().nullish().describe(entryDescription)
  const keySchema = z.string().trim().max(MAX_CONTINUITY_KEY_CHARS).nullish().describe(keyDescription)
  return {
    // Pointing beats spelling for the same reason it does with sentences: the
    // number is verifiable, where a spelled key is readily invented and matches
    // nothing.
    entry: entrySchema,
    key: keySchema,
  }
}

function continuityKeyFields(
  existing: RegistryEntry[] | undefined,
  noun: string,
  example: string,
  creationAction: 'set' | 'open' | 'learn',
) {
  // Sorted so the description is byte-identical whenever the key set is
  // unchanged. Registry order follows recency of update, which would otherwise
  // rewrite the tool block on every analysis and cost the prompt cache.
  const unique = [...new Set((existing ?? []).map((entry) => entry.key))].sort()
  const reuse = unique.length > 0
    ? ` Reuse when applicable: ${unique.slice(0, MAX_STEERED_REGISTRY_KEYS).join(', ')}.`
    : ''
  return registryAddressFields(
    `Registry entry to update; omit when ${creationAction} creates one.`,
    `Existing ${noun} key if no entry number is used.${reuse} Omit both to derive a new key; otherwise use snake_case without IDs (for example ${example}).`,
  )
}

function stateOperationSchemaFor(registry: ContinuityRegistry) {
  return z.object({
    ...continuityKeyFields(registry.state, 'state identity', 'captivity_status', 'set'),
    action: z.enum(['set', 'clear']),
    subject: z.object({
      label: z.string().trim().min(1).max(160),
      fragmentId: FragmentIdSchema.optional(),
    }).optional().describe('Subject and optional record ID for a new set.'),
    facet: z.string().trim().min(1).max(100).optional()
      .describe('One stable question for a new set, such as location, attire, or injury; avoid catch-all status.'),
    slot: z.string().trim().min(1).max(100).optional()
      .describe('Optional sub-key when a facet can hold simultaneous values, such as left_wrist injury.'),
    value: z.string().trim().max(300).optional(),
    certainty: z.enum(['explicit', 'implied']).default('explicit')
      .describe('Whether the prose states this directly or by necessary implication.'),
    scope: z.enum(['scene', 'cross-scene']).default('scene')
      .describe('Use cross-scene only when the condition must survive a scene cut.'),
    until: NarrativeTimeInputSchema.optional()
      .describe('Optional story-time expiry for a cross-scene condition.'),
    evidenceSegments: proseCitationSchema,
  })
}

function threadOperationSchemaFor(registry: ContinuityRegistry) {
  return z.object({
    ...continuityKeyFields(registry.thread, 'unresolved question', 'who_betrayed_the_house', 'open'),
    action: z.enum(['open', 'advance', 'resolve', 'abandon']),
    label: z.string().trim().max(240).optional()
      .describe('Optional plain-language question; defaults to the key.'),
    note: z.string().trim().max(300).optional(),
    relatedFragmentIds: z.array(FragmentIdSchema).max(40).default([]),
    // A thread this passage acted on is in view by the acting; carrying that
    // here removes the whole reason to restate the operation in threadFocus.
    visibility: z.enum(['foreground', 'background']).optional()
      .describe('Prominence after the passage; open and advance default to foreground.'),
    evidenceSegments: proseCitationSchema,
  })
}

function knowledgeOperationSchemaFor(registry: ContinuityRegistry) {
  return z.object({
    characterId: FragmentIdSchema,
    ...continuityKeyFields(registry.knowledge, 'fact identity', 'queen_identity', 'learn'),
    action: z.enum(['learn', 'correct', 'forget']),
    fact: z.string().trim().max(400).optional()
      .describe('Durable character-specific learning. Preserve source, inference, and temporal limits; do not turn expressions into general willingness.'),
    acquisition: z.enum(['witnessed', 'told', 'inferred', 'other']).default('other'),
    evidenceSegments: proseCitationSchema,
  })
}

export function buildReportAnalysisInputSchema(input: ContinuityKeyRegistry = {}) {
  const registry = completeRegistry(input)
  return z.object({
    // Model-authored report text is stored as supplied; this schema only asks
    // for the structure required to interpret it.
    summary: z.string().trim().min(1).describe('Concise retrospective summary of the new prose as past history.'),
    events: stringArray
      .describe('A few short timeline events; scene metadata supplies when.'),
    mentions: z.array(mentionInputSchema).default([])
      .describe('Distinct listed-fragment mentions using exact prose text, never bare pronouns.'),
    candidateFragmentIds: z.array(FragmentIdSchema).default([])
      .describe('Existing record IDs needing full text for durable-memory or contradiction review.'),
    contradictions: z.array(z.object({
      description: z.string().describe('What the contradiction is'),
      recordCorrectionReason: z.string().trim().min(1).max(500).optional()
        .describe('Why evidence proves the reusable record is wrong; omit for prose errors or unresolved conflicts.'),
      fragmentIds: z.array(FragmentIdSchema).default([])
        .describe('Reusable record IDs involved; grounded findings also need conflictingEvidence.'),
      sourceSegments: proseCitationSchema
        .describe('Sentence numbers in the new prose carrying the conflicting assertion.'),
      conflictingEvidence: z.array(z.object({
        fragmentId: FragmentIdSchema,
        segments: z.array(z.number().int().positive()).default([])
          .describe('Record sentence numbers carrying the incompatible claim.'),
      })).default([])
        .describe('Conflicting reusable records cited by sentence; ordinary state changes are not contradictions.'),
    })).default([]),
    scene: sceneSchema
      .describe('Changed scene fields; transition uncertain withdraws the claim.'),
    stateOperations: z.array(stateOperationSchemaFor(registry)).default([])
      .describe('Persistent conditions: set replaces, clear ends; use scene scope unless it must survive a cut.'),
    threadOperations: z.array(threadOperationSchemaFor(registry)).default([])
      .describe('Lifecycle changes for unresolved questions; never repurpose keys.'),
    knowledgeOperations: z.array(knowledgeOperationSchemaFor(registry)).default([])
      .describe('Durable character-specific learning with attributed and temporal limits.'),
  })
}

/** Registry-free shape for the context preview and the tool-name listing. */
export const reportAnalysisInputSchema = buildReportAnalysisInputSchema()

type ReportAnalysisInput = z.infer<ReturnType<typeof buildReportAnalysisInputSchema>>

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
    evidence: { evidenceSegments: resolved.indexes, evidenceText: resolved.text },
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

type NormalizedContinuityInput = {
  scene: NonNullable<ReportAnalysisInput['scene']>
  stateOperations: NonNullable<ReportAnalysisInput['stateOperations']>
  threadOperations: NonNullable<ReportAnalysisInput['threadOperations']>
  knowledgeOperations: NonNullable<ReportAnalysisInput['knowledgeOperations']>
}

function normalizeContinuityProjection(
  input: NormalizedContinuityInput,
  segments: TextSegment[],
  registry: ContinuityRegistry = EMPTY_REGISTRY,
): { projection: ContinuityProjection; skipped: Array<Skipped<{ kind: string; key: string }>> } {
  const skipped: Array<Skipped<{ kind: string; key: string }>> = []
  let scene = input.scene
  const requiresSceneEvidence = sceneNeedsEvidence(scene)
  if (requiresSceneEvidence || (scene.evidenceSegments?.length ?? 0) > 0) {
    const resolved = citedEvidence(segments, scene.evidenceSegments ?? [])
    const problem = citationProblem(resolved)
    if (problem && requiresSceneEvidence) {
      skipped.push({ kind: 'scene', key: scene.transition, reason: problem })
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

  const liveState = liveIdentitySet(registry.state)
  const stateOperations: StateOperation[] = []
  for (const operation of input.stateOperations) {
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
    const declaredSubject = operation.subject
      ? {
          key: derivedContinuityKey(operation.subject.label),
          label: operation.subject.label,
          ...(operation.subject.fragmentId ? { fragmentId: operation.subject.fragmentId } : {}),
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
  for (const { visibility, ...operation } of input.threadOperations) {
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
    threadOperations.push({
      threadKey,
      action: operation.action,
      ...(operation.label?.trim() ? { label: operation.label } : {}),
      ...(operation.note?.trim() ? { note: operation.note } : {}),
      relatedFragmentIds: uniqueStrings(operation.relatedFragmentIds),
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
  for (const operation of input.knowledgeOperations) {
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

  const storedScene = (scene.evidenceSegments?.length ?? 0) > 0
    ? scene
    : {
        transition: scene.transition,
        ...(scene.line ? { line: scene.line } : {}),
        ...(scene.location ? { location: scene.location } : {}),
        ...(scene.time ? { time: scene.time } : {}),
        ...(scene.elapsed ? { elapsed: scene.elapsed } : {}),
      }
  return {
    projection: {
      version: 2,
      scene: storedScene,
      stateOperations,
      threadOperations,
      threadFocus,
      knowledgeOperations,
    },
    skipped,
  }
}

const proposalEvidenceSchema = z.array(z.number().int().positive()).min(1)
  .describe('New-prose sentence numbers establishing the proposal.')

/**
 * A correction names the sentence it replaces rather than reproducing it.
 *
 * The old shape asked for `oldText`/`newText`/`occurrence` — string surgery
 * against a record the model had only read. Calls failed outright on `oldText
 * was not found`, and those that succeeded submitted a whole copied paragraph,
 * so the "smallest correction" rule had to be reconstructed server-side and
 * still let scene recaps through. Addressing a sentence makes the scope
 * structural — a paragraph recap is not expressible — and removes the
 * transcription step entirely.
 */
const correctionProposalItemSchema = z.object({
  fragmentId: z.string().min(1).describe('Target fragment ID.'),
  field: z.enum(['content', 'description']).default('content'),
  segment: z.number().int().positive()
    .describe('The numbered sentence in that fragment to replace.'),
  newText: z.string().trim().min(1)
    .describe('Corrected replacement text for the numbered assertion.'),
  reason: z.string().max(500).optional(),
})

const newFragmentProposalItemSchema = createFragmentOperationSchema.omit({ action: true })

/**
 * The online Librarian has a deliberately narrower write contract than chat
 * editing. It may correct an assertion that accepted prose made inaccurate, or
 * propose one genuinely new reusable record. Routine events and state changes
 * already have first-class homes in reportAnalysis.
 */
export const librarianRecordCorrectionsInputSchema = z.object({
  title: z.string().optional()
    .describe('Optional proposal title.'),
  evidenceSegments: proposalEvidenceSchema
    .describe('New-prose sentence numbers establishing these corrections.'),
  rationale: z.string().trim().optional()
    .describe('Optional shared rationale.'),
  corrections: z.array(correctionProposalItemSchema).min(1)
    .describe('Localized record corrections grounded by reportAnalysis; not prose errors or unresolved conflicts.'),
})

export const librarianNewRecordsInputSchema = z.object({
  title: z.string().optional()
    .describe('Optional proposal title.'),
  evidenceSegments: proposalEvidenceSchema
    .describe('New-prose sentence numbers establishing these records.'),
  rationale: z.string().trim().optional()
    .describe('Optional shared rationale.'),
  newFragments: z.array(newFragmentProposalItemSchema).min(1)
    .describe('New reusable named records; not event logs, current conditions, scene details, or duplicates.'),
})

export const librarianFinishInspectionInputSchema = z.object({})

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
  params.collector.fragmentChangeProposals.push({
    ...(title ? { title } : {}),
    ...(rationale ? { rationale } : {}),
    proposalKind: params.proposalKind,
    ...(params.evidenceSegments?.length ? { evidenceSegments: params.evidenceSegments } : {}),
    ...(params.evidenceText ? { evidenceText: params.evidenceText } : {}),
    ...(eligibilityReason ? { eligibilityReason } : {}),
    ...(params.autoApplySafe !== undefined ? { autoApplySafe: params.autoApplySafe } : {}),
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
  const successfulToolNames = new Set<string>()
  // Normalized once here; every lookup below reads the same shape and numbering.
  const continuityRegistry = completeRegistry(opts?.continuityKeys ?? {})
  const emitProgress = (stage: LibrarianAnalysisProgressStage) => {
    if (!opts?.onProgress || !opts.proseFragmentId || !successfulToolNames.has('reportAnalysis')) return
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
      timelineEvents: timelineEventsFor(collector.events, collector.continuityProjection.scene),
      directions: collector.directions,
    }))
  }

  if (opts?.includeReportTool !== false) {
    tools.reportAnalysis = tool({
      description: 'Report all prose findings in one self-contained batch. Evidence fields cite numbered sentences.',
      inputSchema: buildReportAnalysisInputSchema(opts?.continuityKeys ?? {}),
      execute: async (input: ReportAnalysisInput) => {
        const {
          summary,
          events = [],
          mentions = [],
          candidateFragmentIds = [],
          contradictions = [],
          scene = { transition: 'uncertain', evidenceSegments: [] },
          stateOperations = [],
          threadOperations = [],
          knowledgeOperations = [],
        } = input
        const sourceProse = opts?.proseFragmentId
          ? await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId)
          : null

        const checkedFragments = new Map<string, Fragment>()
        if (opts) {
          const uniqueIds = [...new Set<string>([
            ...mentions.map(m => m.fragmentId),
            ...candidateFragmentIds,
            ...contradictions.flatMap(c => [
              ...(c.fragmentIds ?? []),
              ...(c.conflictingEvidence ?? []).map((evidence) => evidence.fragmentId),
            ]),
            ...threadOperations.flatMap((operation) => operation.relatedFragmentIds),
            ...knowledgeOperations.map((operation) => operation.characterId),
          ].filter((id): id is string => typeof id === 'string'))]

          const checks = await Promise.all(
            uniqueIds.map(async (fid) => ({ fid, fragment: await getFragment(opts.dataDir, opts.storyId, fid) })),
          )
          for (const check of checks) {
            if (check.fragment) checkedFragments.set(check.fid, check.fragment)
          }
          const invalidIds = checks.filter((check) => !check.fragment).map((check) => check.fid)
          if (invalidIds.length > 0) {
            throw new Error(unknownFragmentIdsMessage(invalidIds))
          }
          const characterIds = new Set(knowledgeOperations.map((operation) => operation.characterId))
          const invalidCharacterIds = checks
            .filter((check) => characterIds.has(check.fid) && check.fragment?.type !== 'character')
            .map((check) => check.fid)
          if (invalidCharacterIds.length > 0) {
            throw new Error(`Expected character fragment IDs for knowledge operations: ${invalidCharacterIds.join(', ')}`)
          }
        }

        // The same segmentation the prompt block rendered, so the numbers the
        // model saw are the numbers resolved here.
        const proseSegments = segmentText(sourceProse?.content ?? '')
        const normalizedProjection = normalizeContinuityProjection({
          scene,
          stateOperations,
          threadOperations,
          knowledgeOperations,
        }, proseSegments, continuityRegistry)
        collector.continuityProjection = normalizedProjection.projection

        collector.events = events
        collector.summaryUpdate = summary

        // A highlight can only bind text that actually occurs in the passage.
        const skippedMentions: Array<Skipped<{ fragmentId: string; text: string }>> = []
        let anchoredMentions = mentions
        if (opts?.proseFragmentId) {
          const proseLower = sourceProse?.content.toLowerCase()
          if (proseLower) {
            anchoredMentions = []
            for (const m of mentions) {
              const anchored = anchorMentionText(m.text, proseLower)
              if (anchored == null) {
                skippedMentions.push({
                  fragmentId: m.fragmentId,
                  text: m.text,
                  reason: 'Not verbatim in the passage, so it cannot be highlighted.',
                })
              } else {
                anchoredMentions.push({ ...m, text: anchored })
              }
            }
          }
        }

        collector.mentions = anchoredMentions
        collector.candidateFragmentIds = [...new Set(candidateFragmentIds)]

        // Mentions become resolved context for the next writer turn; durable
        // candidates additionally constrain continuity and record maintenance.
        // Both deltas come back here rather than through readFragments: this
        // call already loaded every referenced fragment to validate its ID, so
        // making the model fetch what the process is holding buys only round
        // trips.
        const resolvedFragments = deliverResolvedFragments(
          checkedFragments,
          [...anchoredMentions.map((mention) => mention.fragmentId), ...candidateFragmentIds],
          numberedFragmentIds,
        )
        // Mention bodies improve the next writer context but do not, by
        // themselves, justify another Analyze request. Candidate IDs are the
        // model explicitly asking to inspect durable assertions, so only a
        // newly delivered candidate keeps the inspection stage open.
        const candidateIds = new Set(candidateFragmentIds)
        const inspectionRequired = resolvedFragments.some((fragment) => candidateIds.has(fragment.id))

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
              conflictingEvidence: (contradiction.conflictingEvidence ?? [])
                .map((evidence) => ({ ...evidence, evidenceText: '' })),
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
          const evidenceChecks = await Promise.all((contradiction.conflictingEvidence ?? []).map(async (evidence) => {
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

        successfulToolNames.add('reportAnalysis')
        emitProgress(inspectionRequired ? 'inspection' : 'observation')
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
          ...(resolvedFragments.length > 0 ? {
            resolvedFragments,
            resolvedFragmentNote: 'Full records for what you just reported, not already in your context. Their sentences are numbered for correction targeting. Use them for directions and record maintenance; no further reads are needed for these.',
          } : {}),
          ...(inspectionRequired ? { inspectionRequired: true } : {}),
          ...(normalizedProjection.skipped.length > 0 ? { skippedContinuity: normalizedProjection.skipped } : {}),
          ...(skippedMentions.length > 0 ? {
            skippedMentions,
            skippedMentionNote: 'These texts do not appear verbatim in the prose and were not stored as highlights.',
          } : {}),
          ...(skippedContradictions.length > 0 ? {
            skippedContradictions,
            skippedContradictionNote: 'Contradictions are review findings, not guesses. Cite sentence numbers on both sides.',
          } : {}),
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
    const customTypes = opts?.customFragmentTypes ?? []
    const allowedTypes = ['character', 'knowledge', ...customTypes.map(t => t.type)]
    const resolveEvidence = async (cited: number[]) => {
      const prose = await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId!)
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
      toolName: 'proposeRecordCorrections' | 'proposeNewRecords'
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

      const validation = skipped.length === 0
        ? await validateOperations(opts.dataDir, opts.storyId, params.operations, {
          allowedCreateTypes: allowedTypes,
          createTypeScopeDescription: 'librarian analysis proposals',
        })
        : { operations: [], results: [] as OperationValidation[] }
      for (const result of validation.results) {
        if (result.status !== 'valid') skipped.push(skippedOperation(result))
      }

      if (skipped.length > 0 || validation.operations.length !== params.operations.length) {
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
        autoApplySafe: params.proposalKind === 'new-fragment',
        operations: validation.operations,
        validation: validation.results,
      })
      successfulToolNames.add(params.toolName)
      emitProgress('record-maintenance')
      return {
        ok: true,
        proposalCount: collector.fragmentChangeProposals.length,
        queuedOperationCount: validation.operations.length,
        invalid: 0,
        evidenceMatched: true,
        autoApplySafe: params.proposalKind === 'new-fragment',
        ...operationEchoFields(validation.results),
      }
    }

    tools.proposeRecordCorrections = tool({
      description: 'Queue author-reviewed corrections for reusable records proven wrong by a grounded reportAnalysis finding. Do not rewrite prose or unresolved conflicts.',
      inputSchema: librarianRecordCorrectionsInputSchema,
      execute: async ({ title, evidenceSegments, rationale, corrections }) => {
        const evidence = await resolveEvidence(evidenceSegments)
        if (evidence.error) return evidence.error
        // Resolve each cited sentence into the exact span it addresses. The
        // model never states the old text, so it cannot get it wrong; an
        // unresolvable citation is reported against the numbering it saw.
        const unresolved: AnalysisProposalSkipped[] = []
        const operations: FragmentChangeOperation[] = []
        for (const correction of corrections) {
          const field = correction.field ?? 'content'
          const target = await getFragment(opts.dataDir, opts.storyId, correction.fragmentId)
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
            unresolved.push({
              operationId: '',
              action: 'replace_text',
              reason: `${correction.fragmentId} has not been shown with numbered sentences.`,
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
          operations: newFragments.map((operation) => ({ ...operation, action: 'create_fragment' as const })),
        })
      },
    })
  }

  if (!opts?.disableDirections) {
    tools.proposeDirections = tool({
      description: 'Required when available: suggest 3-5 next directions informed by the completed analysis.',
      inputSchema: z.object({
        directions: z.array(suggestionDirectionSchema).min(3).max(5),
      }),
      execute: async ({ directions }) => {
        collector.directions = directions
        successfulToolNames.add('proposeDirections')
        emitProgress('directions')
        return { ok: true }
      },
    })
  }

  tools.finishInspection = tool({
    description: 'End record inspection when the records did not change the last report. If they changed a finding, call reportAnalysis again instead.',
    inputSchema: librarianFinishInspectionInputSchema,
    execute: async () => {
      const missingRequired: string[] = []
      if (tools.reportAnalysis && !successfulToolNames.has('reportAnalysis')) missingRequired.push('reportAnalysis')
      if (tools.proposeDirections && !successfulToolNames.has('proposeDirections')) {
        missingRequired.push('proposeDirections')
      }

      if (missingRequired.length > 0) {
        return {
          ok: false,
          missingRequired,
          note: 'Finish inspection only after required report and direction tools succeed.',
        }
      }
      return { ok: true, completed: [...successfulToolNames] }
    },
  })

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
