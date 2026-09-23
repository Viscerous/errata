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
  NarrativeDurationInputSchema,
  NarrativeTimeInputSchema,
  SceneLocationInputSchema,
  type CitedEvidence,
  type ContinuityProjection,
  type ContinuityRegistry,
  type SceneUpdate,
  type ThreadFocus,
  type ThreadOperation,
} from '@/contracts/continuity'
import { normalizeContinuityKey } from '@/lib/continuity-keys'
import {
  CharacterReportInputSchema,
  EntityReportInputSchema,
  LiveStatePresentInputSchema,
  LiveStateUpdatesInputSchema,
  normalizeLiveStateReports,
  reportRef,
} from './live-state-report'
import {
  createFragmentOperationSchema,
  type FragmentChangeOperation,
  type OperationValidation,
  operationEchoFields,
  validateOperations,
} from '../fragments/change-operations'

const mentionTextSchema = z.string().trim().min(1).max(120)

export const mentionInputSchema = z.object({
  fragmentId: FragmentIdSchema.describe('The ID of the mentioned catalog fragment from the catalog (e.g. "kn-bakagu", "ch-buguzi")'),
  // The mention decision is which record the prose references, judged
  // contextually; one entry per record and wording. The highlight is the words
  // the prose uses, quoted by the model and confirmed by the server as a name
  // or phrase it really contains; it is never guessed from parts of the record
  // name. There is no per-sentence locator: it made "record x sentence" the
  // unit and invited one entry per sentence the record appears in.
  text: mentionTextSchema.describe('The name, title, or descriptive phrase the prose uses for this record, exactly as written (e.g. "Van Reede", "the girls"). Not a pronoun.'),
})

/** Map collected mentions to the prose annotation shape used for highlighting. */
export function toMentionAnnotations(mentions: LibrarianMention[]) {
  const seen = new Set<string>()
  return mentions.flatMap((mention) => {
    const key = `${mention.fragmentId}\u0000${mention.text.toLocaleLowerCase()}`
    if (!mention.text.trim() || seen.has(key)) return []
    seen.add(key)
    return [{ type: 'mention' as const, fragmentId: mention.fragmentId, text: mention.text }]
  })
}

/**
 * Resolve the highlight term for a mention: the words the model quoted, else
 * the record's full name, whichever the prose contains as whole words. A span
 * is confirmed, never guessed; a mention whose wording cannot be found is still
 * a mention, just without a highlight.
 */
export function resolveMentionTerm(opts: {
  fragmentId: string
  modelText?: string
  prose?: string
  resolveName?: (fragmentId: string) => string | undefined
}): string {
  const prose = opts.prose ?? ''
  for (const candidate of [opts.modelText, opts.resolveName?.(opts.fragmentId)]) {
    const span = verbatimSpan(prose, candidate?.trim() ?? '')
    if (span && namesSomething(span)) return span
  }
  return ''
}

/**
 * A highlight is a name or a phrase: several words, or one word of at least two
 * letters that begins capitalized (or is written in a script without case).
 * A pronoun or a lone common word ("I", "my", "the") refers to nothing on its
 * own and would light up every occurrence in the passage.
 */
function namesSomething(span: string): boolean {
  const words = span.trim().split(/\s+/)
  if (words.length > 1) return true
  const letters = words[0].replace(/[^\p{L}]/gu, '')
  if (letters.length < 2) return false
  const initial = letters[0]
  return initial === initial.toUpperCase()
}

/**
 * The first whole-word occurrence of a phrase in the prose, as the prose spells
 * it. A phrase inside a longer word is not a reference to it.
 */
function verbatimSpan(prose: string, phrase: string): string {
  if (!phrase || !prose) return ''
  const pattern = phrase
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').exec(prose)
  return match ? match[0] : ''
}

/**
 * Ground reported mentions against the catalog: one mention per record and
 * resolved highlight term, so a record named two ways keeps both highlights
 * while a restatement collapses. Unknown IDs are skipped with a reason the model
 * can act on. `checkedFragments` is undefined for callers without story storage.
 */
function groundMentions(
  mentions: Array<z.infer<typeof mentionInputSchema>>,
  prose: string,
  checkedFragments: Map<string, Fragment> | undefined,
): { reported: LibrarianMention[]; skipped: Array<Skipped<{ fragmentId: string; text: string }>> } {
  const skipped: Array<Skipped<{ fragmentId: string; text: string }>> = []
  const reported = new Map<string, LibrarianMention>()
  for (const m of mentions) {
    const fid = m.fragmentId.trim()
    const text = (m.text ?? '').trim()
    if (!fid || (checkedFragments && !checkedFragments.has(fid))) {
      skipped.push({
        fragmentId: fid,
        text,
        reason: `Unknown fragment ID "${fid}". Mentions must cite existing catalog records.`,
      })
      continue
    }
    const term = resolveMentionTerm({
      fragmentId: fid,
      modelText: m.text,
      prose,
      resolveName: (id) => checkedFragments?.get(id)?.name,
    })
    const key = `${fid}\u0000${term.toLocaleLowerCase()}`
    if (!reported.has(key)) reported.set(key, { fragmentId: fid, text: term })
  }
  // A mention without a confirmed highlight adds nothing beside one with it.
  const highlighted = new Set([...reported.values()].filter((mention) => mention.text).map((mention) => mention.fragmentId))
  return {
    reported: [...reported.values()].filter((mention) => mention.text || !highlighted.has(mention.fragmentId)),
    skipped,
  }
}

// --- Collector ---

export interface AnalysisCollector {
  summaryUpdate: string
  /** What happened, one bullet each. Positioned into a timeline by the frame. */
  events: string[]
  mentions: LibrarianMention[]
  /** Uncatalogued names the prose introduces, confirmed verbatim and not already recorded. */
  newRecordNames: string[]
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
    newRecordNames: [],
    contradictions: [],
    fragmentChangeProposals: [],
    continuityProjection: {
      version: 4,
      scene: { transition: 'uncertain' },
      threadOperations: [],
      threadFocus: [],
      liveStates: [],
    },
    directions: [],
  }
}

/**
 * Only evidence opens record maintenance: a contradiction citing both the
 * record and the prose, or a new name the prose uses and the catalog lacks. A
 * lasting change that contradicts nothing belongs in live state until the
 * author promotes it.
 */
export function needsRecordMaintenance(collector: AnalysisCollector): boolean {
  return collector.contradictions.length > 0 || collector.newRecordNames.length > 0
}

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
    let items: unknown[]
    if (val === null || val === undefined) items = []
    else if (Array.isArray(val)) items = val
    else if (typeof val === 'string') {
      const trimmed = val.trim()
      items = (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'n/a') ? [] : [trimmed]
    }
    else if (typeof val === 'object') items = [val]
    else items = []

    // Forgive per entry: keep only items the element schema accepts, so a single
    // malformed entry (a hallucinated ID, a dropped field) does not fail the
    // whole report. The surviving items are then grounded by the caller; `min`
    // on the inner array still fails a required array when every entry is
    // dropped, and the slice below trims overflow instead of rejecting it.
    const kept: unknown[] = []
    for (const item of items) {
      const parsed = elementSchema.safeParse(item)
      if (parsed.success) kept.push(parsed.data)
    }
    return options?.max !== undefined ? kept.slice(0, options.max) : kept
  }, arr)
}

/**
 * An optional claim its schema rejects is dropped rather than failing the whole
 * report, matching the per-entry forgiveness of `forgivingArray`: one malformed
 * scene field must not discard a valid summary, mentions, and events.
 */
export function forgivingOptional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (val) => (val === null || val === undefined || !schema.safeParse(val).success ? undefined : val),
    schema.optional(),
  )
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
    let nums: number[]
    if (val === null || val === undefined) nums = []
    else if (Array.isArray(val)) {
      nums = val
        .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN))
        .filter((n) => Number.isInteger(n) && n > 0)
    }
    else if (typeof val === 'number' && Number.isInteger(val) && val > 0) nums = [val]
    else if (typeof val === 'string') {
      const parsed = parseInt(val, 10)
      nums = Number.isInteger(parsed) && parsed > 0 ? [parsed] : []
    }
    else nums = []
    return options?.max !== undefined ? nums.slice(0, options.max) : nums
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
  location: forgivingOptional(SceneLocationInputSchema)
    .describe('Resulting place when established or changed; otherwise omit.'),
  time: forgivingOptional(NarrativeTimeInputSchema)
    .describe('Resulting story time when established or changed; otherwise omit.'),
  elapsed: forgivingOptional(NarrativeDurationInputSchema)
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

const EMPTY_REGISTRY: ContinuityRegistry = { thread: [], items: [] }

const MAX_DERIVED_KEY_CHARS = 64

export const contradictionInputSchema = z.object({
  description: z.string().max(300).describe('What the contradiction is'),
  recordCorrectionReason: z.string().trim().min(1).max(300).optional()
    .describe('Why evidence proves the reusable record is wrong; omit for prose errors or unresolved conflicts.'),
  fragmentIds: forgivingArray(z.string().trim().max(64), { max: 4 }).default([])
    .describe('Reusable record IDs involved; grounded findings also need conflictingEvidence.'),
  sourceSegments: forgivingNumberArray(undefined, { max: 6 })
    .describe('Sentence numbers in the new prose carrying the conflicting assertion.'),
  conflictingEvidence: forgivingArray(z.object({
    fragmentId: z.string().trim().max(64),
    segments: forgivingNumberArray(undefined, { max: 6 })
      .describe('Record sentence numbers carrying the incompatible claim.'),
  }), { max: 3 }).default([])
    .describe('Conflicting reusable records cited by sentence; ordinary state changes are not contradictions.'),
})

export type ContradictionInput = z.infer<typeof contradictionInputSchema>

/**
 * The passage report, in the order each part builds on the last: what
 * happened, then where everyone now stands, then where the story could go. One
 * request reasons over the passage once; splitting it into a request per part
 * re-read the same context for each and did not make a small model any less
 * likely to run away.
 */
export const reportPassageInputSchema = z.object({
  summary: z.string().trim().min(1).max(1200).describe('Concise retrospective summary of the new prose as past history.'),
  events: forgivingArray(z.string().trim().min(1).max(240), { max: 8 }).default([])
    .describe('Distinct events that occurred in this passage, in narrative order. Use empty [] if the summary alone is sufficient.'),
  scene: sceneSchema.describe('Changed scene frame fields; transition uncertain withdraws the claim.'),
  mentions: forgivingArray(mentionInputSchema, { max: 16 }).default([])
    .describe('Each catalog record this prose references, judged by meaning.'),
  contradictions: forgivingArray(contradictionInputSchema, { max: 3 }).default([])
    .describe('Contradictions with established records. Use empty [] if none.'),
  newRecordNames: forgivingArray(z.string().trim().min(1).max(80), { max: 4 }).default([])
    .describe('Names of lasting people, places, objects, or institutions this prose introduces that have no catalog record, exactly as the prose writes them. Use empty [] if none.'),
  present: LiveStatePresentInputSchema.default([]),
  characters: forgivingArray(CharacterReportInputSchema, { max: 6 }).default([])
    .describe('Characters for whom this passage establishes or changes something. Leave out anyone with nothing new.'),
  entities: forgivingArray(EntityReportInputSchema, { max: 4 }).default([])
    .describe('Places, objects, or groups actively involved in this passage, with what changed for them. Use empty [] if none.'),
  update: LiveStateUpdatesInputSchema.default([]),
  // Thread strings become stored ThreadOperation.label (max 240); keep the
  // grammar bound at or below that so a full-length string still decodes.
  threads: forgivingArray(z.string().trim().max(240), { max: 6 }).default([])
    .describe('Current foreground narrative threads. Reuse a supplied thread key for an existing thread; otherwise provide a concise label for a new open question. This is a snapshot: omitted existing threads become dormant.'),
  resolvedThreads: forgivingArray(z.string().trim().max(100), { max: 4 }).default([])
    .describe('Existing thread keys conclusively answered or closed by this passage. Use empty [] if none.'),
  // No minimum: a report without usable directions keeps everything else it
  // found, and the directions lane is recorded as incomplete instead.
  directions: forgivingArray(suggestionDirectionSchema, { max: 4 })
    .describe('Three distinct narrative directions for the next passage, each with title, description, and instruction.'),
})

/** Directions are part of the report unless the story turned them off. */
export function buildPassageReportInputSchema(options: { includeDirections?: boolean } = {}) {
  return options.includeDirections === false
    ? reportPassageInputSchema.omit({ directions: true })
    : reportPassageInputSchema
}

export type ReportPassageInput = z.infer<typeof reportPassageInputSchema>
type PassageReportArgs = Omit<ReportPassageInput, 'directions'> & Partial<Pick<ReportPassageInput, 'directions'>>

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

export const reportMaintenanceInputSchema = z.object({
  evidenceSegments: forgivingNumberArray(undefined, { max: 24 }).default([])
    .describe('New-prose sentence numbers establishing the proposed corrections or records.'),
  corrections: forgivingArray(correctionProposalItemSchema, { max: 6 }).default([])
    .describe('Permanent corrections to delivered catalog records when canon truly changed. Use empty [] if none.'),
  newRecords: forgivingArray(newFragmentProposalItemSchema, { max: 4 }).default([])
    .describe('New reusable named records established by this prose. Use empty [] if none.'),
})

export type ReportMaintenanceInput = z.infer<typeof reportMaintenanceInputSchema>

/**
 * Preserve the strict JSON Schema generated by Zod v4 (including required keys
 * and exact property bounds). Where a local engine compiles the schema into a
 * decoding grammar, this keeps it from loosening required fields or permitting
 * arbitrary key loops. Not every chat format is constrained (llama.cpp parses
 * Gemma 4 tool calls without a grammar), so validation below stays the check
 * that always runs.
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
 * Turn a citation into the stored evidence. The resolved text is kept beside
 * the indices so a saved finding stays reviewable, and so the unattended apply
 * path can still re-check it against prose that may since have changed.
 */
function citedEvidence(
  segments: TextSegment[],
  cited: number[],
): { evidence: CitedEvidence; invalid: number[] } {
  const resolved = resolveSegments(segments, cited)
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
 * beside the list: the trace panel reads entries. Mentions once carried their
 * explanation in a `skippedMentionNote` alone, so dropped mentions rendered as
 * blank rows the moment the panel learned to report refusals at all.
 */
type Skipped<T> = T & { reason: string }

function normalizeScene(
  input: SceneInput | undefined,
  segments: TextSegment[],
  checkedFragments: Map<string, Fragment> | undefined,
  skipped: Array<Skipped<{ kind: string; key: string }>>,
): SceneUpdate {
  let scene: SceneInput & Partial<CitedEvidence> = input ?? { transition: 'uncertain', evidenceSegments: [] }
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

  const locationFragmentId = scene.location?.fragmentId
  const validLocationFragmentId = locationFragmentId
    && (!checkedFragments || checkedFragments.has(locationFragmentId))
    && FragmentIdSchema.safeParse(locationFragmentId).success
    ? locationFragmentId
    : undefined
  const locKey = scene.location?.key?.trim() ?? ''
  const locLabel = scene.location?.label?.trim() ?? ''
  const location = scene.location && (locKey || locLabel)
    ? {
        key: locKey || derivedContinuityKey(locLabel),
        label: locLabel || locKey,
        ...(validLocationFragmentId ? { fragmentId: validLocationFragmentId } : {}),
      }
    : undefined
  const time = scene.time
    ? {
        label: scene.time.label,
        certainty: scene.time.certainty,
        ...(scene.time.calendar ? { calendar: scene.time.calendar } : {}),
      }
    : undefined
  const elapsed = scene.elapsed
    ? {
        label: scene.elapsed.label,
        ...(scene.elapsed.minimumSeconds != null ? { minimumSeconds: scene.elapsed.minimumSeconds } : {}),
        ...(scene.elapsed.maximumSeconds != null ? { maximumSeconds: scene.elapsed.maximumSeconds } : {}),
      }
    : undefined

  return {
    transition: scene.transition,
    ...(scene.line ? { line: scene.line } : {}),
    ...(location ? { location } : {}),
    ...(time ? { time } : {}),
    ...(elapsed ? { elapsed } : {}),
    ...((scene.evidenceSegments?.length ?? 0) > 0 ? {
      evidenceSegments: scene.evidenceSegments,
      ...(scene.evidenceText ? { evidenceText: scene.evidenceText } : {}),
    } : {}),
  }
}

/**
 * Threads are a foreground snapshot plus what this passage settles. A thread
 * is addressed by its key or its label; anything else opens a new one. Live
 * threads the snapshot omits stay unresolved but go dormant, still available
 * to directions.
 */
function normalizeThreads(
  threads: string[],
  resolvedThreads: string[],
  registry: ContinuityRegistry['thread'],
  skipped: Array<Skipped<{ kind: string; key: string }>>,
): Pick<ContinuityProjection, 'threadOperations' | 'threadFocus'> {
  const threadOperations: ThreadOperation[] = []
  const threadFocus: ThreadFocus[] = []
  const byKey = new Map(registry.map((entry) => [normalizeContinuityKey(entry.key), entry]))
  const byLabel = new Map(registry.map((entry) => [normalizeContinuityKey(entry.label), entry]))
  const existing = (value: string) => {
    const requested = normalizeContinuityKey(value)
    return byKey.get(requested) ?? byLabel.get(requested)
  }
  const active = new Set<string>()
  const resolved = new Set<string>()

  for (const value of resolvedThreads) {
    const entry = existing(value)
    if (!entry) {
      skipped.push({ kind: 'thread', key: value, reason: `No unresolved thread matches "${value}".` })
      continue
    }
    const threadKey = normalizeContinuityKey(entry.key)
    if (resolved.has(threadKey)) continue
    resolved.add(threadKey)
    threadOperations.push({ action: 'resolve', threadKey })
  }

  for (const value of threads) {
    const label = value.trim()
    if (!label) continue
    const entry = existing(label)
    const threadKey = normalizeContinuityKey(entry?.key ?? derivedContinuityKey(label))
    if (resolved.has(threadKey) || active.has(threadKey)) continue
    active.add(threadKey)
    threadOperations.push({ action: entry ? 'advance' : 'open', threadKey, label: entry?.label ?? label })
    threadFocus.push({ threadKey, visibility: 'foreground' })
  }

  for (const entry of registry) {
    const threadKey = normalizeContinuityKey(entry.key)
    if (active.has(threadKey) || resolved.has(threadKey)) continue
    threadFocus.push({ threadKey, visibility: 'dormant' })
  }
  return { threadOperations, threadFocus }
}

function normalizeContinuityProjection(
  input: Pick<ReportPassageInput, 'scene' | 'present' | 'characters' | 'entities' | 'update' | 'threads' | 'resolvedThreads'>,
  segments: TextSegment[],
  registry: ContinuityRegistry,
  checkedFragments: Map<string, Fragment> | undefined,
): { projection: ContinuityProjection; skipped: Array<Skipped<{ kind: string; key: string }>> } {
  const skipped: Array<Skipped<{ kind: string; key: string }>> = []
  const scene = normalizeScene(input.scene, segments, checkedFragments, skipped)
  const threads = normalizeThreads(input.threads ?? [], input.resolvedThreads ?? [], registry.thread, skipped)
  const liveStates = normalizeLiveStateReports(
    { present: input.present, characters: input.characters, entities: input.entities, update: input.update },
    registry.items,
    checkedFragments,
  )
  skipped.push(...liveStates.skipped)
  return {
    projection: { version: 4, scene, ...threads, liveStates: liveStates.reports },
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
  proposalKind: 'correction' | 'new-fragment'
  evidenceSegments?: number[]
  evidenceText?: string
  operations: FragmentChangeOperation[]
  validation: OperationValidation[]
}): void {
  if (params.operations.length === 0) return

  let autoApplySafe = true
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
    proposalKind: params.proposalKind,
    ...(params.evidenceSegments?.length ? { evidenceSegments: params.evidenceSegments } : {}),
    ...(params.evidenceText ? { evidenceText: params.evidenceText } : {}),
    autoApplySafe,
    operations: params.operations,
    validation: params.validation,
  })
}

function correctionContractError(operation: FragmentChangeOperation): string | null {
  if (operation.action !== 'replace_text') {
    return 'Corrections may only replace an exact existing assertion. Live state carries changes that contradict nothing; use newRecords for a new reusable record.'
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

/**
 * The story's records by ID, for grounding what a report cites. Listing is the
 * normal path; when it fails, the referenced IDs are loaded one by one so a
 * report can still be grounded against what exists.
 */
async function loadCatalog(dataDir: string, storyId: string, referencedIds: string[]): Promise<Map<string, Fragment>> {
  const catalog = new Map<string, Fragment>()
  try {
    for (const fragment of await listFragments(dataDir, storyId)) catalog.set(fragment.id, fragment)
  } catch {
    // Loaded by ID below.
  }
  if (catalog.size > 0) return catalog
  const ids = [...new Set(referencedIds.filter((id) => id.trim().length > 0))]
  for (const fragment of await Promise.all(ids.map((id) => getFragment(dataDir, storyId, id)))) {
    if (fragment) catalog.set(fragment.id, fragment)
  }
  return catalog
}

function referencedFragmentIds(input: PassageReportArgs): string[] {
  return [
    ...input.mentions.map((mention) => mention.fragmentId),
    ...input.contradictions.flatMap((contradiction) => [
      ...contradiction.fragmentIds,
      ...contradiction.conflictingEvidence.map((evidence) => evidence.fragmentId),
    ]),
    ...(input.scene.location?.fragmentId ? [input.scene.location.fragmentId] : []),
    ...input.characters.map(reportRef),
    ...input.entities.map(reportRef),
  ]
}

/**
 * A contradiction is a review finding, not a guess: it cites the new prose and
 * the conflicting sentence of a reusable record. Without story storage (pure
 * callers) there is nothing to cite against, so findings pass through.
 */
async function groundContradictions(
  contradictions: ContradictionInput[],
  proseSegments: TextSegment[],
  catalog: Map<string, Fragment> | undefined,
): Promise<{ grounded: AnalysisCollector['contradictions']; skipped: Array<Skipped<{ description: string }>> }> {
  const grounded: AnalysisCollector['contradictions'] = []
  const skipped: Array<Skipped<{ description: string }>> = []
  for (const contradiction of contradictions) {
    if (!catalog) {
      grounded.push({
        ...contradiction,
        conflictingEvidence: contradiction.conflictingEvidence.map((evidence) => ({ ...evidence, evidenceText: '' })),
      })
      continue
    }
    const citedSource = citedEvidence(proseSegments, contradiction.sourceSegments)
    const citationIssue = citationProblem(citedSource)
    if (citationIssue) {
      skipped.push({ description: contradiction.description, reason: citationIssue })
      continue
    }
    if (contradiction.conflictingEvidence.length === 0) {
      skipped.push({
        description: contradiction.description,
        reason: 'The finding did not cite a conflicting sentence in a reusable record.',
      })
      continue
    }
    // The record is shown sentence-numbered too, so the conflicting side is
    // cited rather than re-quoted, exactly like the prose side.
    const evidenceChecks = contradiction.conflictingEvidence.map((evidence) => {
      const fragment = catalog.get(evidence.fragmentId)
      const reusable = Boolean(fragment && fragment.type !== 'prose' && fragment.type !== 'summary')
      const resolved = reusable
        ? citedEvidence(segmentText(fragment!.content), evidence.segments)
        : { evidence: { evidenceSegments: [] as number[], evidenceText: '' }, invalid: [] as number[] }
      return { fragmentId: evidence.fragmentId, valid: reusable && citationProblem(resolved) === null, resolved }
    })
    const badEvidence = evidenceChecks.find((check) => !check.valid)
    if (badEvidence) {
      skipped.push({
        description: contradiction.description,
        reason: `Cite the numbered sentence in ${badEvidence.fragmentId} that carries the incompatible claim; it must be a reusable non-prose record.`,
      })
      continue
    }
    grounded.push({
      description: contradiction.description,
      ...(contradiction.recordCorrectionReason ? { recordCorrectionReason: contradiction.recordCorrectionReason } : {}),
      fragmentIds: uniqueStrings(evidenceChecks.map((check) => check.fragmentId)),
      sourceSegments: citedSource.evidence.evidenceSegments,
      sourceEvidenceText: citedSource.evidence.evidenceText,
      conflictingEvidence: evidenceChecks.map((check) => ({
        fragmentId: check.fragmentId,
        segments: check.resolved.evidence.evidenceSegments,
        evidenceText: check.resolved.evidence.evidenceText,
      })),
    })
  }
  return { grounded, skipped }
}

/**
 * A new record is warranted only by a name the prose really uses and the
 * catalog does not already have; a bare claim that one might be is not
 * evidence.
 */
function groundNewRecordNames(names: string[], prose: string, catalog: Map<string, Fragment> | undefined): string[] {
  const catalogNames = new Set([...(catalog?.values() ?? [])]
    .filter((fragment) => fragment.type !== 'prose')
    .map((fragment) => fragment.name.trim().toLocaleLowerCase()))
  return uniqueStrings(names
    .map((name) => resolveMentionTerm({ fragmentId: '', modelText: name, prose }))
    .filter((name) => name && !catalogNames.has(name.toLocaleLowerCase())))
}

// --- Tools ---

export const PASSAGE_REPORT_TOOL = 'reportPassage'
export const MAINTENANCE_REPORT_TOOL = 'reportMaintenance'

/**
 * The analyze reports. `reportPassage` answers the passage; `reportMaintenance`
 * proposes record changes, and exists only with story storage and suggestions
 * enabled. Both write into one collector and one numbered-record ledger.
 * Without options, nothing is grounded against story storage.
 */
export function createAnalysisTools(
  collector: AnalysisCollector,
  opts?: {
    dataDir: string
    storyId: string
    proseFragmentId?: string
    disableDirections?: boolean
    disableSuggestions?: boolean
    numberedFragmentIds?: Set<string> | readonly string[]
    registry?: Partial<ContinuityRegistry>
    customFragmentTypes?: Array<{ type: string; name: string }>
    onProgress?: (progress: LibrarianAnalysisProgress) => void
  },
): ToolSet {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {}
  /**
   * Every record the model has been shown numbered, from context blocks or the
   * passage report's delivery. It is what makes a segment number mean anything:
   * an unshown record still segments server-side, so a citation against one
   * resolves to a real sentence, just not the one being counted to.
   *
   * Held by reference — pipeline compilation adds the context-block half after
   * the tools exist, once user block overrides settle what is actually shown.
   */
  const numberedFragmentIds = opts?.numberedFragmentIds instanceof Set
    ? opts.numberedFragmentIds
    : new Set(opts?.numberedFragmentIds ?? [])
  const registry: ContinuityRegistry = { ...EMPTY_REGISTRY, ...opts?.registry }
  const emitProgress = (stage: LibrarianAnalysisProgressStage) => {
    if (!opts?.onProgress || !opts.proseFragmentId) return
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

  const includeDirections = opts?.disableDirections !== true
  const maintenanceEnabled = opts !== undefined && opts.disableSuggestions !== true
  const customTypes = opts?.customFragmentTypes ?? []
  const allowedTypes = ['character', 'knowledge', ...customTypes.map((t) => t.type)]
  const loadProse = async () => (opts?.proseFragmentId
    ? (await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId))?.content ?? ''
    : '')

  tools[PASSAGE_REPORT_TOOL] = tool({
    description: [
      'Report this passage in one answer: what happened (summary, events, scene, mentions, and any record evidence),',
      'then where each character and entity now stands and which threads are open or resolved',
      includeDirections ? ', then distinct directions for the next passage.' : '.',
    ].join(' '),
    inputSchema: toExactJsonSchema(buildPassageReportInputSchema({ includeDirections })),
    execute: async (input: PassageReportArgs) => {
      if (!input.summary.trim()) {
        return { ok: false, note: 'Empty summary: please provide a concise retrospective summary of the prose.' }
      }
      const prose = await loadProse()
      // The same segmentation the prompt block rendered, so the numbers the
      // model saw are the numbers resolved here.
      const proseSegments = segmentText(prose)
      const catalog = opts ? await loadCatalog(opts.dataDir, opts.storyId, referencedFragmentIds(input)) : undefined

      const continuity = normalizeContinuityProjection(input, proseSegments, registry, catalog)
      const mentions = groundMentions(input.mentions, prose, catalog)
      const contradictions = await groundContradictions(input.contradictions, proseSegments, catalog)
      collector.summaryUpdate = input.summary
      collector.events = input.events
      collector.continuityProjection = continuity.projection
      collector.mentions = mentions.reported
      collector.contradictions = contradictions.grounded
      collector.newRecordNames = groundNewRecordNames(input.newRecordNames, prose, catalog)
      if (input.directions) collector.directions = input.directions

      // Record maintenance is shown these numbered, so a correction can
      // address the sentence it replaces.
      const resolvedFragments = catalog
        ? deliverResolvedFragments(catalog, uniqueStrings([
            ...collector.mentions.map((mention) => mention.fragmentId),
            ...collector.contradictions.flatMap((contradiction) => contradiction.fragmentIds),
          ]), numberedFragmentIds)
        : []

      emitProgress(maintenanceEnabled && needsRecordMaintenance(collector) ? 'record-maintenance' : 'passage')
      return {
        ok: true,
        eventCount: collector.events.length,
        mentionCount: collector.mentions.length,
        contradictionCount: collector.contradictions.length,
        newRecordNames: collector.newRecordNames,
        sceneTransition: collector.continuityProjection.scene.transition,
        subjectCount: collector.continuityProjection.liveStates.length,
        threadCount: collector.continuityProjection.threadOperations.length,
        directionCount: collector.directions.length,
        ...(resolvedFragments.length > 0 ? { resolvedFragments } : {}),
        ...(continuity.skipped.length > 0 ? { skippedContinuity: continuity.skipped } : {}),
        ...(mentions.skipped.length > 0 ? { skippedMentions: mentions.skipped } : {}),
        ...(contradictions.skipped.length > 0 ? { skippedContradictions: contradictions.skipped } : {}),
      }
    },
  })

  if (!opts || !maintenanceEnabled) return tools

  const resolveEvidence = async (cited: number[]) => {
    const resolved = citedEvidence(segmentText(await loadProse()), cited)
    const problem = citationProblem(resolved)
    if (problem) {
      return {
        error: {
          ok: false,
          invalid: 1,
          note: `${problem} Cite sentence numbers from the New Prose Fragment.`,
        },
      }
    }
    return { evidence: resolved.evidence }
  }

  /** A proposal is one atomic, self-contained author-facing change. */
  const queueValidatedProposal = async (params: {
    proposalKind: 'correction' | 'new-fragment'
    evidence: CitedEvidence
    operations: FragmentChangeOperation[]
    rejected?: AnalysisProposalSkipped[]
  }) => {
    const skipped: AnalysisProposalSkipped[] = [...(params.rejected ?? [])]
    for (const operation of params.operations) {
      const contractError = correctionContractError(operation)
      if (params.proposalKind === 'correction' && contractError) {
        skipped.push({ operationId: operation.operationId ?? '', action: operation.action, reason: contractError })
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
        queuedOperationCount: 0,
        invalid: skipped.length,
        ...operationEchoFields(validation.results),
        skipped,
      }
    }

    queueFragmentChangeProposal({
      collector,
      proposalKind: params.proposalKind,
      evidenceSegments: params.evidence.evidenceSegments,
      evidenceText: params.evidence.evidenceText,
      operations: validation.operations,
      validation: validation.results,
    })
    return {
      ok: true,
      queuedOperationCount: validation.operations.length,
      invalid: 0,
      ...operationEchoFields(validation.results),
    }
  }

  const resolveCorrectionOperations = async (corrections: Array<z.infer<typeof correctionProposalItemSchema>>) => {
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
          reason: `${correction.fragmentId} has not been shown with numbered sentences, so no sentence of it can be addressed.`,
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

  tools[MAINTENANCE_REPORT_TOOL] = tool({
    description: 'Report only durable-record maintenance supported by the supplied numbered prose and records. Use empty arrays when review finds no safe correction or new reusable record.',
    inputSchema: toExactJsonSchema(reportMaintenanceInputSchema),
    execute: async (input: ReportMaintenanceInput) => {
      const { evidenceSegments, corrections, newRecords } = input
      const skippedProposals: unknown[] = []
      let queuedOperationCount = 0
      let invalid = 0
      const record = (result: { queuedOperationCount?: number; invalid?: number; skipped?: unknown[] }) => {
        queuedOperationCount += result.queuedOperationCount ?? 0
        invalid += result.invalid ?? 0
        skippedProposals.push(...(result.skipped ?? []))
      }

      if (corrections.length > 0 || newRecords.length > 0) {
        const evidence = await resolveEvidence(evidenceSegments)
        if (evidence.error) {
          invalid += evidence.error.invalid
          skippedProposals.push(evidence.error)
        } else {
          if (corrections.length > 0) {
            const { operations, unresolved } = await resolveCorrectionOperations(corrections)
            record(await queueValidatedProposal({
              proposalKind: 'correction',
              evidence: evidence.evidence,
              operations,
              rejected: unresolved,
            }))
          }
          if (newRecords.length > 0) {
            record(await queueValidatedProposal({
              proposalKind: 'new-fragment',
              evidence: evidence.evidence,
              operations: newRecords.map((operation) => ({ ...operation, action: 'create_fragment' as const })),
            }))
          }
        }
      }

      emitProgress('record-maintenance')
      return {
        ok: true,
        proposalCount: collector.fragmentChangeProposals.length,
        queuedOperationCount,
        invalid,
        ...(skippedProposals.length > 0 ? { skippedProposals } : {}),
      }
    },
  })

  return tools
}

/** Tool names the analyze agent exposes — drives the toggle list with no drift. */
export function listLibrarianAnalyzeToolNames(): string[] {
  return Object.keys(createAnalysisTools(createEmptyCollector(), { dataDir: '', storyId: '' }))
}
