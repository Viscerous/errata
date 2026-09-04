import { createHash } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { suggestionDirectionSchema, type SuggestionDirection } from '../directions/schema'
import { getFragment } from '../fragments/storage'
import { FragmentIdSchema, type Fragment } from '../fragments/schema'
import { numberSentences, resolveSegments, segmentText, stripSegmentMarker, type TextSegment } from '../llm/segments'
import type { LibrarianAnalysis, LibrarianFragmentChangeProposal, LibrarianMention } from './storage'
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
import {
  correctionShapeError,
  MAX_CORRECTION_SPAN_CHARS,
  MAX_NEW_FRAGMENT_CONTENT_CHARS,
  MIN_CORRECTION_ANCHOR_CHARS,
} from './correction-limits'
import { createFragmentTools } from '../llm/tools'
import {
  createFragmentOperationSchema,
  type FragmentChangeOperation,
  type OperationValidation,
  fragmentBaseHash,
  operationEchoFields,
  unknownFragmentIdsMessage,
  validateOperations,
} from '../fragments/change-operations'

const mentionTextSchema = z.string().trim().min(1).describe('The exact name, title, or key term as it appears in the prose, copied verbatim — no added quotes, no paraphrase')

// Wrapping quotes and edge punctuation a model habitually adds around a term.
const MENTION_EDGE_TRIM_RE = /^["'‚„“”«»`‘’]+|["'‚„“”«»`‘’.,!?;:]+$/g
const INLINE_MARKDOWN_RE = /[*_~`]+/g

/**
 * A rendered phrase may be split by inline Markdown in source: the model sees
 * `*Medicine* file` as “Medicine file”, and the highlighter later receives the
 * rendered text in separate nodes. Once removing markup proves the whole phrase
 * is exact, retain the longest source-present word span that can actually bind.
 */
function markdownAnchoredMention(text: string, proseLower: string): string | null {
  if (!proseLower.replace(INLINE_MARKDOWN_RE, '').includes(text.toLowerCase())) return null
  const words = text.split(/\s+/).filter(Boolean)
  for (let length = words.length; length > 0; length -= 1) {
    const candidates = Array.from({ length: words.length - length + 1 }, (_, index) => (
      words.slice(index, index + length).join(' ')
    )).sort((a, b) => b.length - a.length)
    const match = candidates.find((candidate) => proseLower.includes(candidate.toLowerCase()))
    if (match) return match
  }
  return null
}

/**
 * Anchor a reported mention to the prose it annotates: the highlight regex can
 * only bind text that actually occurs in the passage (case-insensitive). Returns
 * the verbatim-usable text — salvaging quote-wrapped reports — or null when the
 * text does not occur (a paraphrase), which the caller echoes back as feedback.
 */
export function anchorMentionText(text: string, proseLower: string): string | null {
  const raw = text.trim()
  if (raw && proseLower.includes(raw.toLowerCase())) return raw
  const stripped = raw.replace(MENTION_EDGE_TRIM_RE, '').trim()
  if (stripped && proseLower.includes(stripped.toLowerCase())) return stripped
  if (stripped) return markdownAnchoredMention(stripped, proseLower)
  return null
}

export const mentionInputSchema = z.object({
  fragmentId: FragmentIdSchema.describe('The ID of the mentioned fragment'),
  text: mentionTextSchema,
})

function mentionKey(mention: LibrarianMention): string {
  return `${mention.fragmentId}\u0000${mention.text.trim().toLowerCase()}`
}

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

function lastWhitespaceIndex(value: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(value[index])) return index
  }
  return -1
}

/** Keep bounded prose readable and make a clipped tail explicit. */
function truncateAtWordBoundary(value: string, maxChars: number): { value: string; truncated: boolean } {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return { value: trimmed, truncated: false }
  if (maxChars <= 0) return { value: '', truncated: true }
  if (maxChars === 1) return { value: '…', truncated: true }

  const clipped = trimmed.slice(0, maxChars - 1).trimEnd()
  const lastWhitespace = lastWhitespaceIndex(clipped)
  const readable = (lastWhitespace > 0 ? clipped.slice(0, lastWhitespace) : clipped).trimEnd()
  return { value: `${readable}…`, truncated: true }
}

/** Prefer a complete sentence when durable summary-like prose must be bounded. */
function truncateAtSentenceBoundary(value: string, maxChars: number): { value: string; truncated: boolean } {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return { value: trimmed, truncated: false }

  const clipped = trimmed.slice(0, maxChars)
  let sentenceEnd = -1
  for (let index = 0; index < clipped.length; index += 1) {
    if (!/[.!?]/.test(clipped[index])) continue
    let end = index + 1
    while (end < clipped.length && /["'’”)\]]/.test(clipped[end])) end += 1
    if (end === clipped.length || /\s/.test(clipped[end])) sentenceEnd = end
  }
  // Do not turn a long useful summary into a tiny first sentence. If no
  // reasonably late sentence boundary exists, retain as much as possible and
  // end at a word boundary instead.
  if (sentenceEnd >= Math.floor(maxChars / 2)) {
    return { value: clipped.slice(0, sentenceEnd).trimEnd(), truncated: true }
  }
  return truncateAtWordBoundary(trimmed, maxChars)
}

function normalizeUniqueLines(values: string[] | undefined, maxItems: number, maxItemChars = 200): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    const trimmed = truncateAtWordBoundary(value, maxItemChars).value
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= maxItems) break
  }
  return out
}

function sentenceJoin(values: string[]): string {
  return values.map((v) => v.endsWith('.') ? v : `${v}.`).join(' ')
}

/** Events kept per passage, across however many reports build the timeline. */
const MAX_TIMELINE_EVENTS = 12

/**
 * Analyze is given the prose chain and the rolling summary in its context, so
 * these two would only offer a second copy of what it is already looking at.
 * They go unused, and an unused tool is still schema the model reads past.
 * listFragmentTypes stays: proposeNewRecords takes a free-string `type` and this
 * is where the valid ones are named.
 */
const READ_TOOLS_ALREADY_IN_ANALYZE_CONTEXT = ['readProseChain', 'readStorySummary']

/** Last resort when a report carried events but no summary prose. */
function summaryFromEvents(events: string[]): string {
  return events.length > 0 ? sentenceJoin(events).trim() : ''
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
): LibrarianAnalysis['timelineEvents'] {
  const position = scene.line === 'flashback' ? 'before' : 'after'
  return events.map((event) => ({ event, position }))
}

// Two-tier limits: the schema `.max()` is a wide ceiling that rejects only
// degenerate output (a looping model repeating an array entry hundreds of times)
// with a clean validation error; the execute path CLIPS anything between the
// working target and that ceiling, so a merely verbose report never loses the
// whole batched call over a few extra items. Targets live in execute
// (normalizeUniqueLines / collector caps); aim guidance lives in `.describe`.

/**
 * Small models sometimes confuse the string[] signal arrays with the
 * contradictions shape ({description, fragmentIds}), or pad arrays with
 * hallucinated `true` values.  This schema coerces recoverable items to
 * strings and silently drops junk so a mostly-correct report isn't lost.
 */
const coercedStringItem = z.union([
  z.string().max(400),
  z.object({ description: z.string() }).transform((obj) => obj.description),
]).catch('')

const coercedStringArray = z.array(coercedStringItem).max(200).default([])
  .transform((arr) => arr.filter((item): item is string => typeof item === 'string' && item.length > 0))

/**
 * Evidence is a citation, not a quotation. The passage is presented with
 * numbered sentences, so pointing at them is exact by construction and costs
 * one integer rather than a few hundred output characters. Quoted evidence lost
 * whole proposal calls whenever the model could not reproduce the span exactly;
 * there is nothing to mis-transcribe here.
 */
/**
 * How many cited sentences are kept. Brevity is a preference, not an invariant:
 * over-citing costs a longer stored evidence string and nothing else, so the
 * bound is applied when the citation is resolved rather than made a condition of
 * accepting the call. As a schema `.max()` it rejected the whole payload, losing
 * an entire report round trip because one operation cited one sentence too many.
 */
export const MAX_CITED_SEGMENTS = 8

const proseCitationSchema = z.array(z.number().int().positive()).default([])
  .describe(`Sentence numbers from the New Prose Fragment that show this. Cite the fewest that carry it; only the first ${MAX_CITED_SEGMENTS} are kept.`)

/** Conditional maintenance lanes may be abandoned after a failed attempt. */
const skippedToolNameSchema = z.enum(['proposeRecordCorrections', 'proposeNewRecords'])

// This is intentionally a forgiving, default-heavy LLM input schema. The
// normalized result is typed by, and storage-validates against, the strict
// persisted schema; exposing that strict schema to the model would add ceremony
// without adding information.
const sceneSchema = z.object({
  transition: z.enum([
    'continue', 'advance', 'cut', 'enter-flashback', 'enter-flash-forward', 'return', 'uncertain',
  ]).default('uncertain')
    .describe('What this passage does to the scene cursor. A cut starts another scene on the same narrative line; enter-flashback/enter-flash-forward opens an overlay; return resumes the suspended frame.'),
  line: z.enum(['present', 'flashback', 'flash-forward', 'uncertain']).optional()
    .describe('The resulting narrative line only when this passage changes or establishes it. Omit it when continuing the established line.'),
  location: SceneLocationInputSchema.optional()
    .describe('The resulting place only when this passage changes or first establishes it. Omit an unchanged inherited location.'),
  time: NarrativeTimeInputSchema.optional()
    .describe('The resulting story time only when this passage changes or first establishes it. Omit unchanged inherited time.'),
  elapsed: NarrativeDurationInputSchema.optional()
    .describe('Elapsed story time for advance. One generation never implies a duration by itself.'),
  evidenceSegments: proseCitationSchema
    .describe('Sentence numbers carrying the scene, place, or time transition, when the prose gives one.'),
}).default({ transition: 'uncertain', evidenceSegments: [] })

type SceneInput = z.infer<typeof sceneSchema>
type SceneClaim = Pick<SceneInput, 'transition' | 'line' | 'location' | 'time' | 'elapsed'>

/** Whether a scene payload says anything beyond the schema's empty default. */
function hasSceneClaim(scene: SceneClaim): boolean {
  return scene.transition !== 'uncertain'
    || (scene.line !== undefined && scene.line !== 'uncertain')
    || scene.location !== undefined
    || scene.time !== undefined
    || scene.elapsed !== undefined
}

/** Scene claims that must be grounded in the prose rather than inherited. */
function sceneNeedsEvidence(scene: SceneInput): boolean {
  return (scene.transition !== 'continue' && scene.transition !== 'uncertain')
    || (scene.line !== undefined && scene.line !== 'uncertain')
    || scene.location !== undefined
    || scene.time !== undefined
    || scene.elapsed !== undefined
}

/** The live registry, so an operation can pick an identity rather than spell one. */
/** A bare key is accepted so a caller with nothing to number can stay terse. */
export type ContinuityKeyInput = string | (Omit<RegistryEntry, 'index' | 'label'> & { index?: number; label?: string })

export interface ContinuityKeyRegistry {
  state?: ContinuityKeyInput[]
  thread?: ContinuityKeyInput[]
  knowledge?: ContinuityKeyInput[]
}

/**
 * Canonicalize the registry once, at the boundary. Every lookup below then reads
 * one shape with normalized keys, instead of each re-deciding what a bare string
 * means and whether a key still needs normalizing.
 */
function normalizeRegistry(registry: ContinuityKeyRegistry): ContinuityRegistry {
  const lane = (entries: ContinuityKeyInput[] | undefined): RegistryEntry[] => (
    (entries ?? []).map((entry, position) => {
      const reference = typeof entry === 'string' ? { key: entry } : entry
      return {
        index: reference.index ?? position + 1,
        key: normalizeContinuityKey(reference.key),
        label: reference.label ?? '',
        ...(reference.scope ? { scope: reference.scope } : {}),
        ...(reference.subject ? { subject: reference.subject } : {}),
        ...(reference.facet ? { facet: reference.facet } : {}),
        ...(reference.slot ? { slot: reference.slot } : {}),
      }
    }).filter((entry) => entry.key)
  )
  return {
    state: lane(registry.state),
    thread: lane(registry.thread),
    knowledge: lane(registry.knowledge),
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
function registryAddressFields<const T extends string>(
  entryField: T,
  entryDescription: string,
  keyDescription: string,
) {
  const entrySchema = z.number().int().positive().nullish().describe(entryDescription)
  const keySchema = z.string().trim().max(MAX_CONTINUITY_KEY_CHARS).nullish().describe(keyDescription)
  return {
    // Pointing beats spelling for the same reason it does with sentences: the
    // number is verifiable, where a spelled key is readily invented and matches
    // nothing.
    [entryField]: entrySchema,
    key: keySchema,
  } as unknown as Record<T, typeof entrySchema> & { key: typeof keySchema }
}

function continuityKeyFields(
  existing: RegistryEntry[] | undefined,
  entryField: 'stateEntry' | 'threadEntry' | 'knowledgeEntry',
  noun: string,
  example: string,
  creationAction: 'set' | 'open' | 'learn',
) {
  // Sorted so the description is byte-identical whenever the key set is
  // unchanged. Registry order follows recency of update, which would otherwise
  // rewrite the tool block on every analysis and cost the prompt cache.
  const unique = [...new Set((existing ?? []).map((entry) => entry.key))].sort()
  const reuse = unique.length > 0
    ? ` Reuse one of these exactly when the passage changes something already tracked: ${unique.slice(0, MAX_STEERED_REGISTRY_KEYS).join(', ')}.`
    : ''
  return registryAddressFields(
    entryField,
    `The numbered registry entry this operation changes, taken from the Continuity Registry. Cite it whenever the passage changes something already tracked; omit it only when a ${creationAction} introduces something genuinely new.`,
    `The ${noun}, when you are not citing an entry number.${reuse} For a genuinely new identity introduced by a ${creationAction} operation, omit both and the engine will derive one. If you coin a key, use snake_case naming the thing itself, such as ${example}; never include a character or fragment ID.`,
  )
}

function stateOperationSchemaFor(registry: ContinuityRegistry) {
  return z.object({
    ...continuityKeyFields(registry.state, 'stateEntry', 'state identity', 'captivity_status', 'set'),
    action: z.enum(['set', 'clear']),
    subject: z.object({
      label: z.string().trim().min(1).max(160),
      fragmentId: FragmentIdSchema.optional(),
    }).optional().describe('Required only for a genuinely new set. Give its plain label and optional record ID; the engine derives the structural key. An existing stateEntry already supplies the complete subject.'),
    facet: z.string().trim().min(1).max(100).optional()
      .describe('Required only for a new set. One stable question, such as location (where?), attire (wearing what?), or injury (what condition?). Existing entries supply it. Keep values about that question; separate independently changing conditions and avoid catch-all status.'),
    slot: z.string().trim().min(1).max(100).optional()
      .describe('Only when one subject can carry several simultaneous values of this facet, such as left_wrist under injury.'),
    value: z.string().trim().max(300).optional(),
    certainty: z.enum(['explicit', 'implied']).default('explicit')
      .describe('Whether accepted prose states the condition directly or establishes it by a necessary implication.'),
    scope: z.enum(['scene', 'cross-scene']).default('scene')
      .describe('Use scene normally. Use cross-scene only when this condition must still constrain writing after a scene cut.'),
    until: NarrativeTimeInputSchema.optional()
      .describe('Optional story-time expiry for a cross-scene condition.'),
    evidenceSegments: proseCitationSchema,
  })
}

function threadOperationSchemaFor(registry: ContinuityRegistry) {
  return z.object({
    ...continuityKeyFields(registry.thread, 'threadEntry', 'unresolved question', 'who_betrayed_the_house', 'open'),
    action: z.enum(['open', 'advance', 'resolve', 'abandon']),
    label: z.string().trim().max(240).optional()
      .describe('Optional plain-language phrasing of the question. Omit it and the key is used.'),
    note: z.string().trim().max(300).optional(),
    relatedFragmentIds: z.array(FragmentIdSchema).max(40).default([]),
    // A thread this passage acted on is in view by the acting; carrying that
    // here removes the whole reason to restate the operation in threadFocus.
    visibility: z.enum(['foreground', 'background']).optional()
      .describe('How present this thread is after the passage. Defaults to foreground for open and advance; ignored for resolve and abandon.'),
    evidenceSegments: proseCitationSchema,
  })
}

/**
 * Focus for threads this passage did *not* operate on.
 *
 * It used to cover every live thread, so most focus arrays were just the
 * operation list restated a second time, and an "omit the key when the arrays
 * align one-for-one" rule existed to make that restatement bearable — which
 * silently dropped entries whenever the alignment did not actually hold. An
 * untouched thread is by definition already in the registry, so it is addressed
 * the same way every other continuity identity is.
 */
const threadFocusSchema = z.object({
  ...registryAddressFields(
    'threadEntry',
    'The numbered Continuity Registry entry for a still-relevant thread this passage did not act on.',
    'That thread\'s key, when you are not citing an entry number. It must already be open; focus cannot introduce a thread.',
  ),
  visibility: z.enum(['foreground', 'background', 'dormant'])
    .describe('Set dormant when an existing thread should leave the immediate writing context without being resolved.'),
})

function knowledgeOperationSchemaFor(registry: ContinuityRegistry) {
  return z.object({
    characterId: FragmentIdSchema,
    ...continuityKeyFields(registry.knowledge, 'knowledgeEntry', 'fact identity', 'queen_identity', 'learn'),
    action: z.enum(['learn', 'correct', 'forget']),
    fact: z.string().trim().max(400).optional()
      .describe('Worth remembering beyond recent prose. Preserve who said or inferred it and when it applied: "She told him she wanted X during the examination", not "She wants X". Attribute interpretations as beliefs; never generalize willingness from an expression. Omit knowledge dependent on a capability contradicted by the records.'),
    acquisition: z.enum(['witnessed', 'told', 'inferred', 'other']).default('other'),
    evidenceSegments: proseCitationSchema,
  })
}

export function buildReportAnalysisInputSchema(input: ContinuityKeyRegistry = {}) {
  const registry = normalizeRegistry(input)
  return z.object({
    // Accept verbosity here and normalize it in execute. Rejecting the entire
    // structured report for an overlong summary makes reasoning models retain
    // a large failed tool call and regenerate every otherwise-valid field.
    summary: z.string().default('').describe('A concise retrospective record of what had happened in the new prose fragment, written as past history rather than a scene to continue — a paragraph or two, at most 1200 characters. Longer input is shortened by the server.'),
    events: coercedStringArray
      .describe('What happened, one short statement each — the few that matter, at most 8 are kept. These become the story timeline; `scene` places them, so do not restate when they happened.'),
    mentions: z.array(mentionInputSchema).max(150).default([])
      .describe('Distinct mentions of listed fragments in the new prose — at most one entry per fragment/text pair; a single mention highlights every occurrence of that text. Use exact prose text; never a bare pronoun.'),
    candidateFragmentIds: z.array(FragmentIdSchema).max(120).default([])
      .describe('Existing fragment IDs to return in full, even when the prose never names them. Two kinds: durable-memory candidates, and records this passage has made inaccurate. Your context lists every record with its description — use those to find the ones tied to whatever changed here.'),
    contradictions: z.array(z.object({
      description: z.string().describe('What the contradiction is'),
      recordCorrectionReason: z.string().trim().min(1).max(500).optional()
        .describe('Only when evidence establishes the reusable record itself is wrong: explain why that record should change. Omit for a prose error or unresolved conflict. A conflicting generated assertion alone does not authorize changing a capability, consent, knowledge, or authority constraint.'),
      fragmentIds: z.array(FragmentIdSchema).default([])
        .describe('IDs of the reusable fragments involved. A grounded finding must also provide conflictingEvidence.'),
      sourceSegments: proseCitationSchema
        .describe('Sentence numbers in the new prose carrying the conflicting assertion.'),
      conflictingEvidence: z.array(z.object({
        fragmentId: FragmentIdSchema,
        segments: z.array(z.number().int().positive()).default([])
          .describe(`Sentence numbers in that record carrying the incompatible claim; only the first ${MAX_CITED_SEGMENTS} are kept.`),
      })).max(8).default([])
        .describe('The reusable non-prose records this conflicts with, cited by sentence. State changes across successive prose are not contradictions.'),
    })).max(32).default([]),
    scene: sceneSchema.optional()
      .describe('Changed scene fields. Omit this lane on a narrow retry to retain its earlier accepted data; send only {transition:"uncertain"} to withdraw a rejected scene claim.'),
    stateOperations: z.array(stateOperationSchemaFor(registry)).max(80).optional()
      .describe('Keyed conditions worth retaining after this prose leaves the recent window. Existing stateEntry values already supply state identity. A later set supersedes the prior value directly; clear only when the condition ends without replacement. Scene is the normal scope; choose cross-scene only when the condition must constrain a later scene. Omit this lane on a narrow retry to retain earlier data; send [] to withdraw its rejected operations.'),
    threadOperations: z.array(threadOperationSchemaFor(registry)).max(80).optional()
      .describe('Explicit lifecycle changes for unresolved narrative questions. Resolve completed questions, never repurpose a key. Omission retains prior prominence; set dormant through threadFocus explicitly. Omit this lane on a narrow retry to retain earlier data; send [] to withdraw its rejected operations.'),
    threadFocus: z.array(threadFocusSchema).max(80).optional()
      .describe('Sparse prominence updates for threads this passage did NOT act on. Do not repeat threadOperations here — those carry their own visibility. Omission retains a thread\'s prior prominence; set dormant explicitly when it should leave the immediate writing context without being resolved. Omit this lane on a narrow retry to retain earlier data; send [] to withdraw its rejected focus entries.'),
    knowledgeOperations: z.array(knowledgeOperationSchemaFor(registry)).max(120).optional()
      .describe('Useful learning established for a specific character, including attributed inferences with their limits. Preserve the occasion of temporary disclosures; omit current desires, feelings, unsupported opinions, and reader-only information. Omit this lane on a narrow retry to retain earlier data; send [] to withdraw its rejected operations.'),
  })
}

/** Registry-free shape for the context preview and the tool-name listing. */
export const reportAnalysisInputSchema = buildReportAnalysisInputSchema()

type ReportAnalysisInput = z.infer<ReturnType<typeof buildReportAnalysisInputSchema>>

function uniqueStrings(values: string[], maxItems: number): string[] {
  return [...new Set(values)].slice(0, maxItems)
}

const MAX_STORED_ANALYSIS_SUMMARY_CHARS = 1200

function normalizeAnalysisSummary(value: string): { value: string; truncated: boolean } {
  return truncateAtSentenceBoundary(value, MAX_STORED_ANALYSIS_SUMMARY_CHARS)
}

function keepLastByKey<T>(items: T[], keyFor: (item: T) => string, maxItems: number): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const key = keyFor(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.unshift(item)
    if (out.length >= maxItems) break
  }
  return out
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
  const resolved = resolveSegments(segments, cited.slice(0, MAX_CITED_SEGMENTS))
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

/**
 * How much of each lane one passage's projection retains. Applied both when a
 * report is normalized and when a retry is folded onto it, so the two cannot
 * drift into disagreeing about how much a passage may hold.
 */
const PROJECTION_CAPS = { state: 12, thread: 12, focus: 16, knowledge: 24 } as const

const stateKeyOf = (operation: StateOperation) => operation.stateKey
const threadKeyOf = (operation: ThreadOperation) => operation.threadKey
const threadFocusKeyOf = (focus: ThreadFocus) => focus.threadKey
const knowledgeKeyOf = (operation: KnowledgeOperation) => scopedContinuityIdentity(operation.knowledgeKey, operation.characterId)

/**
 * Sentence citations are the stable part of a retry when a small model drops or
 * corrects its key. Use them to recognize the same operation without guessing
 * from mutable prose labels. Empty citations are never identities, and an
 * ambiguous signature deliberately matches nothing.
 */
function evidenceSignature(operation: { action: string; evidenceSegments: number[] }, scope = ''): string {
  if (operation.evidenceSegments.length === 0) return ''
  const evidence = [...new Set(operation.evidenceSegments)].sort((a, b) => a - b).join(',')
  return `${scope}\u0000${operation.action}\u0000${evidence}`
}

const stateSignatureOf = (operation: Pick<StateOperation, 'action' | 'evidenceSegments'>) =>
  evidenceSignature(operation)
const threadSignatureOf = (operation: Pick<ThreadOperation, 'action' | 'evidenceSegments'>) =>
  evidenceSignature(operation)
const knowledgeSignatureOf = (operation: Pick<KnowledgeOperation, 'characterId' | 'action' | 'evidenceSegments'>) =>
  evidenceSignature(operation, operation.characterId)

function uniquelyMatchingKey<T>(
  previous: T[],
  signature: string,
  signatureOf: (item: T) => string,
  keyOf: (item: T) => string,
): string | undefined {
  if (!signature) return undefined
  const matches = previous.filter((item) => signatureOf(item) === signature)
  return matches.length === 1 ? keyOf(matches[0]) : undefined
}

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
  operation: { stateEntry?: unknown; key?: unknown },
  resolvedKey: string,
): Pick<RegistryEntry, 'subject' | 'facet' | 'slot'> | undefined {
  const byEntry = typeof operation.stateEntry === 'number' && Number.isInteger(operation.stateEntry)
    ? entries.filter((candidate) => candidate.index === operation.stateEntry)
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
function resolveIdentity<T>(
  operation: { key?: unknown; entry?: unknown; action: string },
  derivedFrom: string | undefined,
  options: {
    lane: 'state' | 'thread' | 'knowledge'
    allowDerived: boolean
    live: Set<string>
    previous: T[]
    registry: RegistryEntry[]
    scope?: string
    /** The derived fields are declared identity components, not prose wording. */
    structuralDerivation?: boolean
    signature: string
    signatureOf: (item: T) => string
    keyOf: (item: T) => string
  },
): { ok: true; key: string } | { ok: false; reason: string } {
  const { lane, allowDerived, registry, scope } = options
  const addressedKey = registryKeyAtIndex(registry, operation.entry, scope)
    || chosenKey(operation)
    || uniquelyMatchingKey(options.previous, options.signature, options.signatureOf, options.keyOf)
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
        : `A ${lane} ${operation.action} operation must name the existing key; no unambiguous retry or live-registry match was found.`,
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
function liveIdentitySet(entries: RegistryEntry[], created: Iterable<string>): Set<string> {
  return new Set([
    ...entries.map((entry) => scopedContinuityIdentity(entry.key, entry.scope)),
    ...created,
  ])
}

type NormalizedContinuityInput = {
  scene: NonNullable<ReportAnalysisInput['scene']>
  stateOperations: NonNullable<ReportAnalysisInput['stateOperations']>
  threadOperations: NonNullable<ReportAnalysisInput['threadOperations']>
  threadFocus: NonNullable<ReportAnalysisInput['threadFocus']>
  knowledgeOperations: NonNullable<ReportAnalysisInput['knowledgeOperations']>
}

function normalizeContinuityProjection(
  input: NormalizedContinuityInput,
  segments: TextSegment[],
  previous?: ContinuityProjection,
  registry: ContinuityRegistry = EMPTY_REGISTRY,
): { projection: ContinuityProjection; skipped: Array<Skipped<{ kind: string; key: string }>> } {
  const skipped: Array<Skipped<{ kind: string; key: string }>> = []
  let scene = input.scene
  if (sceneNeedsEvidence(scene)) {
    const resolved = citedEvidence(segments, scene.evidenceSegments ?? [])
    const problem = citationProblem(resolved)
    if (problem) {
      skipped.push({ kind: 'scene', key: scene.transition, reason: problem })
      scene = { transition: 'uncertain', evidenceSegments: [] }
    } else {
      scene = { ...scene, ...resolved.evidence }
    }
  }
  if (scene.transition === 'enter-flashback') scene = { ...scene, line: 'flashback' }
  if (scene.transition === 'enter-flash-forward') scene = { ...scene, line: 'flash-forward' }

  // Seeded from what an earlier call of a retried report already created, so a
  // restated new identity stays addressable across the retry.
  const liveState = liveIdentitySet(
    registry.state,
    (previous?.stateOperations ?? []).filter((op) => op.action === 'set').map((op) => op.stateKey),
  )
  const stateOperations: StateOperation[] = []
  for (const operation of input.stateOperations) {
    const allowDerived = operation.action === 'set'
    const derivedStateIdentity = operation.subject && operation.facet
      ? [derivedContinuityKey(operation.subject.label), operation.facet, operation.slot].filter(Boolean).join('_')
      : undefined
    const identity = resolveIdentity({ ...operation, entry: operation.stateEntry }, derivedStateIdentity, {
      lane: 'state',
      allowDerived,
      structuralDerivation: true,
      live: liveState,
      previous: previous?.stateOperations ?? [],
      registry: registry.state,
      signature: stateSignatureOf(operation),
      signatureOf: stateSignatureOf,
      keyOf: stateKeyOf,
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
    const priorDefinition = [...(previous?.stateOperations ?? [])].reverse().find((candidate): candidate is Extract<StateOperation, { action: 'set' }> => (
      candidate.action === 'set' && candidate.stateKey === stateKey
    ))
    const declaredSubject = operation.subject
      ? {
          key: derivedContinuityKey(operation.subject.label),
          label: operation.subject.label,
          ...(operation.subject.fragmentId ? { fragmentId: operation.subject.fragmentId } : {}),
        }
      : undefined
    const subject = registeredDefinition?.subject ?? priorDefinition?.subject ?? declaredSubject
    const facet = registeredDefinition?.facet ?? priorDefinition?.facet ?? operation.facet
    const slot = registeredDefinition?.facet
      ? registeredDefinition.slot
      : priorDefinition
        ? priorDefinition.slot
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

  const liveThreads = liveIdentitySet(
    registry.thread,
    (previous?.threadOperations ?? []).filter((op) => op.action === 'open').map((op) => op.threadKey),
  )
  const threadOperations: ThreadOperation[] = []
  // Assembled as the operations resolve, so the fold receives the prominence
  // delta without the model having to state each acted-on thread twice.
  const threadFocus: ThreadFocus[] = []
  const closedThisPass = new Set<string>()
  for (const { visibility, ...operation } of input.threadOperations) {
    const allowDerived = operation.action === 'open'
    const identity = resolveIdentity({ ...operation, entry: operation.threadEntry }, operation.label || operation.note, {
      lane: 'thread',
      allowDerived,
      live: liveThreads,
      previous: previous?.threadOperations ?? [],
      registry: registry.thread,
      signature: threadSignatureOf(operation),
      signatureOf: threadSignatureOf,
      keyOf: threadKeyOf,
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
      relatedFragmentIds: uniqueStrings(operation.relatedFragmentIds, 20),
      ...resolved.evidence,
    })
    // Acting on a thread puts it in view; a resolved or abandoned one is gone
    // and cannot be.
    if (operation.action === 'open' || operation.action === 'advance') {
      threadFocus.push({ threadKey, visibility: visibility ?? 'foreground' })
    } else {
      closedThisPass.add(threadKey)
    }
  }

  const liveKnowledge = liveIdentitySet(
    registry.knowledge,
    (previous?.knowledgeOperations ?? [])
      .filter((op) => op.action === 'learn')
      .map((op) => scopedContinuityIdentity(op.knowledgeKey, op.characterId)),
  )
  const knowledgeOperations: KnowledgeOperation[] = []
  for (const operation of input.knowledgeOperations) {
    const allowDerived = operation.action === 'learn'
    const identity = resolveIdentity({ ...operation, entry: operation.knowledgeEntry }, operation.fact, {
      lane: 'knowledge',
      allowDerived,
      live: liveKnowledge,
      previous: previous?.knowledgeOperations ?? [],
      registry: registry.knowledge,
      scope: operation.characterId,
      signature: knowledgeSignatureOf(operation),
      signatureOf: knowledgeSignatureOf,
      keyOf: (item) => item.knowledgeKey,
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

  for (const focus of input.threadFocus) {
    const threadKey = registryKeyAtIndex(registry.thread, focus.threadEntry)
      || normalizeContinuityKey(focus.key ?? '')
    if (!threadKey) {
      skipped.push({
        kind: 'thread-focus',
        key: '',
        reason: 'A thread focus entry must cite a Continuity Registry entry number or name its thread key.',
      })
      continue
    }
    // Focus adjusts the prominence of a thread that is open after this passage;
    // it can neither introduce one nor address a thread closed by this passage. Either way the
    // stored entry would be one the fold can never match — inert, and reported
    // nowhere. The operations lane closed exactly this hole.
    if (closedThisPass.has(threadKey)) {
      skipped.push({
        kind: 'thread-focus',
        key: threadKey,
        reason: `This passage closed ${threadKey}, so it no longer needs a prominence update.`,
      })
      continue
    }
    if (!liveThreads.has(threadKey)) {
      skipped.push({
        kind: 'thread-focus',
        key: threadKey,
        reason: `No thread is open under ${threadKey}, so this focus entry would change nothing. Open it with a thread operation, or cite the entry number of the one you mean.`,
      })
      continue
    }
    threadFocus.push({ threadKey, visibility: focus.visibility })
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
      stateOperations: keepLastByKey(stateOperations, stateKeyOf, PROJECTION_CAPS.state),
      threadOperations: threadOperations.slice(0, PROJECTION_CAPS.thread),
      threadFocus: keepLastByKey(threadFocus, threadFocusKeyOf, PROJECTION_CAPS.focus),
      knowledgeOperations: keepLastByKey(knowledgeOperations, knowledgeKeyOf, PROJECTION_CAPS.knowledge),
    },
    skipped,
  }
}

/** `previous` entries `next` said nothing about, followed by everything `next` reported. */
function uniqueSignatures<T>(items: T[], signatureOf: (item: T) => string): Set<string> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const signature = signatureOf(item)
    if (signature) counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([signature]) => signature))
}

function superseded<T>(
  previous: T[],
  next: T[],
  keyOf: (item: T) => string,
  signatureOf?: (item: T) => string,
): T[] {
  const restated = new Set(next.map(keyOf))
  const aliasedSignatures = new Set<string>()
  if (signatureOf) {
    const previousUnique = uniqueSignatures(previous, signatureOf)
    for (const signature of uniqueSignatures(next, signatureOf)) {
      if (previousUnique.has(signature)) aliasedSignatures.add(signature)
    }
  }
  return [
    ...previous.filter((item) => {
      if (restated.has(keyOf(item))) return false
      return !signatureOf || !aliasedSignatures.has(signatureOf(item))
    }),
    ...next,
  ]
}

/**
 * Fold a re-reported projection onto the one already collected. `reportAnalysis`
 * is retried — after a rejected proposal lane, a bad citation, or a model simply
 * calling it again — and the second call is rarely a superset of the first, so
 * plain assignment makes every retry a truncation: valid operations from the
 * first call are replaced by the empty sets a later one did not restate.
 *
 * The new call has full authority over the keys it names and none over the keys
 * it does not — the discipline `hasSummarySignal` already applies to the summary,
 * per key rather than all-or-nothing, since a partial re-report is normal here.
 */
function mergeContinuityProjection(
  previous: ContinuityProjection,
  next: ContinuityProjection,
): ContinuityProjection {
  return {
    ...next,
    // A bare uncertain scene is the schema default, so it carries no claim and
    // must not overwrite a scene an earlier retry actually determined.
    scene: !hasSceneClaim(next.scene)
      ? previous.scene
      : next.scene,
    stateOperations: keepLastByKey(
      superseded(previous.stateOperations, next.stateOperations, stateKeyOf, stateSignatureOf),
      stateKeyOf,
      PROJECTION_CAPS.state,
    ),
    // Not collapsed by key: one call may legitimately open and then advance the
    // same thread.
    threadOperations: superseded(
      previous.threadOperations,
      next.threadOperations,
      threadKeyOf,
      threadSignatureOf,
    ).slice(-PROJECTION_CAPS.thread),
    threadFocus: keepLastByKey(
      [...previous.threadFocus, ...next.threadFocus],
      threadFocusKeyOf,
      PROJECTION_CAPS.focus,
    ),
    knowledgeOperations: keepLastByKey(
      superseded(previous.knowledgeOperations, next.knowledgeOperations, knowledgeKeyOf, knowledgeSignatureOf),
      knowledgeKeyOf,
      PROJECTION_CAPS.knowledge,
    ),
  }
}

const proposalEvidenceSchema = z.array(z.number().int().positive()).default([])
  .describe(`Sentence numbers from the New Prose Fragment that establish this change; only the first ${MAX_CITED_SEGMENTS} are kept.`)

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
  newText: z.string().trim().min(1).max(MAX_CORRECTION_SPAN_CHARS)
    .describe('The corrected sentence: exactly one sentence, replacing exactly that one. Write the sentence alone, without its [number]. Restate only that assertion; do not summarize the scene.'),
  reason: z.string().max(500).optional(),
})

const newFragmentProposalItemSchema = createFragmentOperationSchema.omit({ action: true })

/**
 * The online Librarian has a deliberately narrower write contract than chat
 * editing. It may correct an assertion that accepted prose made inaccurate, or
 * propose one genuinely new reusable record. Routine events and state changes
 * already have first-class homes in reportAnalysis.
 */
const MAX_PROPOSAL_TITLE_CHARS = 100
const MAX_PROPOSAL_RATIONALE_CHARS = 600

export const librarianRecordCorrectionsInputSchema = z.object({
  title: z.string().optional()
    .describe(`Optional proposal title. Aim for at most ${MAX_PROPOSAL_TITLE_CHARS} characters; longer input is shortened by the server.`),
  evidenceSegments: proposalEvidenceSchema
    .describe('Sentence numbers from the New Prose Fragment that establish this change. Required on the first attempt; a retry may omit them because the tool retains the last grounded citation.'),
  rationale: z.string().trim().optional()
    .describe(`Optional shared rationale. Aim for at most ${MAX_PROPOSAL_RATIONALE_CHARS} characters; longer input is shortened by the server.`),
  corrections: z.array(correctionProposalItemSchema).max(4).default([])
    .describe('Localized replacements for record assertions cited in reportAnalysis contradictions with recordCorrectionReason explaining why the record is wrong. Leave prose errors and unresolved conflicts for review; ordinary progression belongs in continuity state.'),
})

export const librarianNewRecordsInputSchema = z.object({
  title: z.string().optional()
    .describe(`Optional proposal title. Aim for at most ${MAX_PROPOSAL_TITLE_CHARS} characters; longer input is shortened by the server.`),
  evidenceSegments: proposalEvidenceSchema
    .describe('Sentence numbers from the New Prose Fragment that establish this change. Required on the first attempt; a retry may omit them because the tool retains the last grounded citation.'),
  rationale: z.string().trim().optional()
    .describe(`Optional shared rationale. Aim for at most ${MAX_PROPOSAL_RATIONALE_CHARS} characters; longer input is shortened by the server.`),
  newFragments: z.array(newFragmentProposalItemSchema).max(4).default([])
    .describe('Genuinely new reusable named records. Do not create event logs, current-condition notes, scene details, or duplicates.'),
})

/**
 * A bare tool name is accepted because it is the shape models reach for first,
 * and for a lane that was never called it is complete information — the gate
 * does not require those to be declared at all. Demanding {toolName, reason}
 * for them spent a retry on the bare form models send anyway, and told the gate
 * nothing it went on to use.
 */
export const librarianFinishAnalysisInputSchema = z.object({
  // No `completed` list. The gate already knows which calls succeeded — it
  // watched them — so asking the model to restate it added no information the
  // gate went on to use and one more way to be wrong. Only what the engine
  // cannot observe is worth a field, and that is the reason for an abandonment.
  skipped: z.array(z.union([
    skippedToolNameSchema,
    z.object({
      toolName: skippedToolNameSchema,
      reason: z.string().trim().min(1).optional(),
    }),
  ])).default([]).describe('Lanes you are abandoning: the tool name on its own, or {toolName, reason} to say why. A lane you left failing needs the reason. A lane you never needed does not have to be listed.'),
})

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

function normalizeForDedupe(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Identity of an operation for cross-proposal dedup. A retried batch usually
 * resubmits already-queued operations alongside the fixed one; anything whose
 * key is already queued must not queue again, or the user sees two proposals
 * carrying the same create/append and the second one fails on apply (or worse,
 * a create applies twice). Keys ignore whitespace and case so a lightly
 * reworded resubmission still matches.
 */
function operationDedupeKey(operation: FragmentChangeOperation): string {
  switch (operation.action) {
    case 'create_fragment':
      return `create|${operation.type}|${normalizeForDedupe(operation.name)}`
    case 'append_paragraph':
      return `add|${operation.fragmentId}|${operation.field}|${normalizeForDedupe(operation.text)}`
    case 'replace_text':
      return `replace|${operation.fragmentId}|${operation.field}|${normalizeForDedupe(operation.oldText)}|${normalizeForDedupe(operation.newText)}`
    case 'set_fields':
      return `set|${operation.fragmentId}|${JSON.stringify(operation.fields)}`
    case 'archive_fragment':
      return `archive|${operation.fragmentId}`
  }
}

function queueFragmentChangeProposal(params: {
  collector: AnalysisCollector
  title?: string
  rationale?: string
  proposalKind?: 'correction' | 'new-fragment'
  evidenceSegments?: number[]
  evidenceText?: string
  eligibilityReason?: string
  autoApplySafe?: boolean
  operations: FragmentChangeOperation[]
  validation: OperationValidation[]
}): { queued: FragmentChangeOperation[]; alreadyQueued: FragmentChangeOperation[] } {
  const title = params.title
    ? truncateAtWordBoundary(params.title, MAX_PROPOSAL_TITLE_CHARS).value
    : ''
  const rationale = params.rationale
    ? truncateAtSentenceBoundary(params.rationale, MAX_PROPOSAL_RATIONALE_CHARS).value
    : ''
  const eligibilityReason = params.eligibilityReason
    ? truncateAtSentenceBoundary(params.eligibilityReason, MAX_PROPOSAL_RATIONALE_CHARS).value
    : ''
  const queuedKeys = new Set(
    params.collector.fragmentChangeProposals.flatMap((proposal) =>
      proposal.operations.map(operationDedupeKey),
    ),
  )
  const queued: FragmentChangeOperation[] = []
  const alreadyQueued: FragmentChangeOperation[] = []
  for (const operation of params.operations) {
    const key = operationDedupeKey(operation)
    if (queuedKeys.has(key)) {
      alreadyQueued.push(operation)
      continue
    }
    queuedKeys.add(key)
    queued.push(operation)
  }
  if (queued.length === 0) return { queued, alreadyQueued }

  const queuedIds = new Set(queued.map((operation) => operation.operationId ?? ''))
  params.collector.fragmentChangeProposals.push({
    ...(title ? { title } : {}),
    ...(rationale ? { rationale } : {}),
    ...(params.proposalKind ? { proposalKind: params.proposalKind } : {}),
    ...(params.evidenceSegments?.length ? { evidenceSegments: params.evidenceSegments } : {}),
    ...(params.evidenceText ? { evidenceText: params.evidenceText } : {}),
    ...(eligibilityReason ? { eligibilityReason } : {}),
    ...(params.autoApplySafe !== undefined ? { autoApplySafe: params.autoApplySafe } : {}),
    operations: queued,
    validation: params.validation.filter((result) => queuedIds.has(result.operationId)),
  })
  return { queued, alreadyQueued }
}

type RetainedProposalEvidence = {
  evidenceSegments: number[]
  evidenceText: string
  title?: string
  rationale?: string
}

function correctionContractError(operation: FragmentChangeOperation): string | null {
  if (operation.action !== 'replace_text') {
    return 'Corrections may only replace an exact existing assertion. Record events and state changes in reportAnalysis; use newFragments for a new reusable record.'
  }
  if (operation.replaceAll) {
    return 'Corrections cannot replace every occurrence automatically; identify one exact assertion and occurrence.'
  }
  if (operation.oldText.length > MAX_CORRECTION_SPAN_CHARS || operation.newText.length > MAX_CORRECTION_SPAN_CHARS) {
    return `Corrections must stay within ${MAX_CORRECTION_SPAN_CHARS} characters on each side.`
  }
  if (operation.oldText.trim().length < MIN_CORRECTION_ANCHOR_CHARS) {
    return 'Corrections must identify a meaningful existing assertion, not a one- or two-character token.'
  }
  const shapeError = correctionShapeError(operation.oldText, operation.newText)
  if (shapeError) return shapeError
  if (normalizeForDedupe(operation.oldText) === normalizeForDedupe(operation.newText)) {
    return 'The replacement does not materially differ from the existing assertion.'
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
    includeFinishTool?: boolean;
    numberedFragmentIds?: Set<string> | readonly string[];
    continuityKeys?: ContinuityKeyRegistry;
    customFragmentTypes?: Array<{ type: string; name: string }>;
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
  /** Continuity work rejected by normalization and not yet repaired by identity. */
  let unresolvedContinuity: Array<Skipped<{ kind: string; key: string }>> = []
  /**
   * Proposal lanes whose most recent call left something undone — refused
   * outright, or queued in part. Record maintenance is optional, so never
   * calling a lane needs no declaration; walking away from work the lane
   * reported back does.
   */
  const unfinishedProposalToolNames = new Set<string>()
  // Normalized once here; every lookup below reads the same shape and numbering.
  const continuityRegistry = normalizeRegistry(opts?.continuityKeys ?? {})
  /** Which continuity lane owns a key, so a correction aimed at one can say so. */
  const continuityKeyOwners = new Map<string, 'state' | 'thread' | 'knowledge'>()
  for (const lane of ['state', 'thread', 'knowledge'] as const) {
    for (const entry of continuityRegistry[lane]) continuityKeyOwners.set(entry.key, lane)
  }
  let retainedCorrectionEvidence: RetainedProposalEvidence | null = null
  let retainedNewRecordEvidence: RetainedProposalEvidence | null = null

  if (opts?.includeReportTool !== false) {
    tools.reportAnalysis = tool({
      description: 'Report the prose analysis in one batch: summary, events, mentions, scene transition/frame, keyed state changes, thread lifecycle/focus, explicit character knowledge changes, and contradictions. Call once with everything you found. If a later step proves the report wrong or incomplete, call it again with the corrected set: the newest summary replaces the prior one, continuity entries it restates supersede their prior versions, and omitted lanes plus events, mentions, candidates, and contradictions are retained. To withdraw a rejected continuity operation that should not exist, explicitly send [] for its lane; use {transition:"uncertain"} to withdraw a rejected scene claim.',
      inputSchema: buildReportAnalysisInputSchema(opts?.continuityKeys ?? {}),
      execute: async (input: ReportAnalysisInput) => {
        const {
          summary = '',
          events = [],
          mentions = [],
          candidateFragmentIds = [],
          contradictions = [],
          scene = { transition: 'uncertain', evidenceSegments: [] },
          stateOperations = [],
          threadOperations = [],
          threadFocus = [],
          knowledgeOperations = [],
        } = input
        // Retry payloads are patches. Omission retains accepted work, while an
        // explicitly empty lane withdraws that lane's rejected attempts. This
        // is how the model says "that operation should not exist" without a new
        // tool or a fabricated replacement identity.
        const withdrawnContinuityKinds = new Set<string>()
        if (input.scene !== undefined && !hasSceneClaim(scene)) withdrawnContinuityKinds.add('scene')
        if (input.stateOperations?.length === 0) withdrawnContinuityKinds.add('state')
        if (input.threadOperations?.length === 0) withdrawnContinuityKinds.add('thread')
        if (input.threadFocus?.length === 0) withdrawnContinuityKinds.add('thread-focus')
        if (input.knowledgeOperations?.length === 0) withdrawnContinuityKinds.add('knowledge')
        const normalizedSummary = normalizeAnalysisSummary(summary)
        // An empty report must not be a *schema* rejection — that makes small
        // models loop on resubmitting the whole payload. It is an unsuccessful
        // call with a nudge, which finishAnalysis then reads consistently.
        // Returning ok:true while withholding the success marker would tell the
        // model its call succeeded and then, at finish, that it had falsely
        // claimed that same call.
        const signalCount =
          Number(normalizedSummary.value.length > 0) +
          events.length +
          mentions.length +
          candidateFragmentIds.length +
          contradictions.length +
          Number(hasSceneClaim(scene)) +
          stateOperations.length +
          threadOperations.length +
          threadFocus.length +
          knowledgeOperations.length
        if (signalCount === 0) {
          return {
            ok: false,
            note: 'Empty report: nothing was recorded. Call again with at least a summary of what the passage does.',
          }
        }

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
          threadFocus,
          knowledgeOperations,
        }, proseSegments, collector.continuityProjection, continuityRegistry)
        collector.continuityProjection = mergeContinuityProjection(
          collector.continuityProjection,
          normalizedProjection.projection,
        )

        // Partial acceptance is useful, but it is not completion. Keep rejected
        // identities outstanding until a later report successfully addresses
        // each one. This makes a four-item partial failure require four repairs,
        // rather than letting an unrelated clean retry erase the warning.
        unresolvedContinuity = unresolvedContinuity.filter((item) => !withdrawnContinuityKinds.has(item.kind))
        const acceptedContinuity = new Set<string>()
        const skippedScene = normalizedProjection.skipped.some((item) => item.kind === 'scene')
        if (!skippedScene && (
          scene.transition !== 'uncertain'
          || scene.line !== undefined
          || scene.location !== undefined
          || scene.time !== undefined
          || scene.elapsed !== undefined
        )) acceptedContinuity.add(`scene\u0000${scene.transition}`)
        for (const operation of normalizedProjection.projection.stateOperations) {
          acceptedContinuity.add(`state\u0000${operation.stateKey}`)
        }
        for (const operation of normalizedProjection.projection.threadOperations) {
          acceptedContinuity.add(`thread\u0000${operation.threadKey}`)
        }
        for (const focus of normalizedProjection.projection.threadFocus) {
          acceptedContinuity.add(`thread-focus\u0000${focus.threadKey}`)
        }
        for (const operation of normalizedProjection.projection.knowledgeOperations) {
          acceptedContinuity.add(`knowledge\u0000${operation.characterId}:${operation.knowledgeKey}`)
        }
        unresolvedContinuity = unresolvedContinuity.filter((item) => (
          !acceptedContinuity.has(`${item.kind}\u0000${item.key}`)
        ))
        for (const item of normalizedProjection.skipped) {
          const identity = `${item.kind}\u0000${item.key}`
          unresolvedContinuity = [
            ...unresolvedContinuity.filter((candidate) => `${candidate.kind}\u0000${candidate.key}` !== identity),
            item,
          ]
        }

        // A re-report replaces the summary but only extends the timeline: a
        // retry aimed at one bad citation must not shorten the record of what
        // happened. Each call contributes at most the working target, so a
        // verbose one cannot crowd out the calls after it.
        const reportedEvents = normalizeUniqueLines(events, 8)
        collector.events = normalizeUniqueLines([...collector.events, ...reportedEvents], MAX_TIMELINE_EVENTS)

        if (normalizedSummary.value.length > 0) collector.summaryUpdate = normalizedSummary.value
        else if (!collector.summaryUpdate) collector.summaryUpdate = summaryFromEvents(collector.events)

        // Anchor mentions to the prose: a highlight can only bind text that
        // actually occurs in the passage. Quote-wrapped reports are salvaged by
        // stripping; paraphrases are skipped and echoed back so the model can
        // re-report the exact wording in a later step.
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

        // Deduplicate by fragment+surface text (multiple terms can resolve to
        // the same fragment and should all highlight), clipped at the working
        // cap — dedup first so repeats never crowd out distinct mentions.
        const seen = new Set(collector.mentions.map(mentionKey))
        for (const m of anchoredMentions) {
          if (collector.mentions.length >= 60) break
          const key = mentionKey(m)
          if (seen.has(key)) continue
          seen.add(key)
          collector.mentions.push(m)
        }
        const existingCandidates = new Set(collector.candidateFragmentIds)
        for (const fragmentId of candidateFragmentIds) {
          if (collector.candidateFragmentIds.length >= 80) break
          if (existingCandidates.has(fragmentId)) continue
          existingCandidates.add(fragmentId)
          collector.candidateFragmentIds.push(fragmentId)
        }

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

        const skippedContradictions: Array<Skipped<{ description: string }>> = []
        const groundedContradictions: AnalysisCollector['contradictions'] = []
        for (const contradiction of contradictions) {
          // Storage-less consumers retain the legacy permissive shape. The
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
            fragmentIds: uniqueStrings(evidenceChecks.map((check) => check.fragmentId), 8),
            sourceSegments: citedSource.evidence.evidenceSegments,
            sourceEvidenceText: citedSource.evidence.evidenceText,
            conflictingEvidence,
          })
        }
        const contradictionKey = (contradiction: AnalysisCollector['contradictions'][number]) => (
          `${normalizeForDedupe(contradiction.description)}\u0000${[...contradiction.fragmentIds].sort().join(',')}`
        )
        for (const contradiction of groundedContradictions) {
          const existing = collector.contradictions.findIndex((item) => contradictionKey(item) === contradictionKey(contradiction))
          // A re-reported finding replaces its evidence and correction judgment
          // together. Omitted findings remain; an omitted reason on a restated
          // finding withdraws its authorization.
          if (existing >= 0) collector.contradictions[existing] = contradiction
          else if (collector.contradictions.length < 12) collector.contradictions.push(contradiction)
        }

        if (unresolvedContinuity.length === 0) successfulToolNames.add('reportAnalysis')
        else successfulToolNames.delete('reportAnalysis')
        return {
          ok: unresolvedContinuity.length === 0,
          ...(unresolvedContinuity.length > 0 ? {
            needsCorrection: true,
            note: 'Some continuity operations were not recorded. Repair every item in skippedContinuity before finishing; accepted report data has been retained.',
          } : {}),
          mentionCount: collector.mentions.length,
          candidateFragmentCount: collector.candidateFragmentIds.length,
          contradictionCount: collector.contradictions.length,
          eventCount: collector.events.length,
          stateOperationCount: collector.continuityProjection.stateOperations.length,
          threadOperationCount: collector.continuityProjection.threadOperations.length,
          focusedThreadCount: collector.continuityProjection.threadFocus.length,
          knowledgeOperationCount: collector.continuityProjection.knowledgeOperations.length,
          ...(normalizedSummary.truncated ? {
            summaryTruncated: true,
            summaryNote: `The reported summary was shortened to fit the ${MAX_STORED_ANALYSIS_SUMMARY_CHARS}-character storage limit.`,
          } : {}),
          ...(resolvedFragments.length > 0 ? {
            resolvedFragments,
            resolvedFragmentNote: 'Full records for what you just reported, not already in your context. Their sentences are numbered for correction targeting. Use them for directions and record maintenance; no further reads are needed for these.',
          } : {}),
          ...(unresolvedContinuity.length > 0 ? { skippedContinuity: unresolvedContinuity } : {}),
          ...(skippedMentions.length > 0 ? {
            skippedMentions,
            skippedMentionNote: 'These texts do not appear verbatim in the prose, so they cannot be highlighted. Report the exact wording the prose uses.',
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
    const resolveEvidence = async (
      kind: 'correction' | 'new-fragment',
      cited: number[],
      title: string | undefined,
      rationale: string | undefined,
    ): Promise<{ retained: RetainedProposalEvidence | null; error?: Record<string, unknown> }> => {
      let retained = kind === 'correction' ? retainedCorrectionEvidence : retainedNewRecordEvidence
      if (cited.length > 0) {
        const prose = await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId!)
        const resolved = citedEvidence(segmentText(prose?.content ?? ''), cited)
        const problem = citationProblem(resolved)
        if (problem) {
          return {
            retained: null,
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
        retained = {
          evidenceSegments: resolved.evidence.evidenceSegments,
          evidenceText: resolved.evidence.evidenceText,
          title,
          rationale,
        }
        if (kind === 'correction') retainedCorrectionEvidence = retained
        else retainedNewRecordEvidence = retained
      }
      if (!retained) {
        return {
          retained: null,
          error: {
            ok: false,
            proposalCount: collector.fragmentChangeProposals.length,
            queuedOperationCount: 0,
            invalid: 1,
            evidenceMatched: false,
            note: 'Cite the sentence numbers from the New Prose Fragment that establish this change. They are retained if a later retry needs to fix only the operations.',
          },
        }
      }
      return { retained }
    }

    /**
     * Queue everything eligible and report the rest, rather than failing the
     * batch on its worst member. All-or-nothing loses the sound operations in a
     * batch to one unusable sibling, and the model reads the resulting
     * `queuedOperationCount: 0` as a refusal and moves on rather than retrying.
     * This is how evidence already behaves here — a citation survives a
     * failed call so that a retry costs less than a redo.
     */
    const queueValidatedProposal = async (params: {
      toolName: 'proposeRecordCorrections' | 'proposeNewRecords'
      proposalKind: 'correction' | 'new-fragment'
      retained: RetainedProposalEvidence
      title?: string
      rationale?: string
      operations: FragmentChangeOperation[]
      /** Rejected before this call saw them, merged into the same report. */
      rejected?: AnalysisProposalSkipped[]
    }) => {
      const skipped: AnalysisProposalSkipped[] = [...(params.rejected ?? [])]
      const eligible: FragmentChangeOperation[] = []
      for (const operation of params.operations) {
        if (operation.action === 'replace_text') {
          const contractError = correctionContractError(operation)
          if (contractError) {
            skipped.push({ operationId: operation.operationId ?? '', action: operation.action, reason: contractError })
            continue
          }
        } else if (operation.action === 'create_fragment' && operation.content.length > MAX_NEW_FRAGMENT_CONTENT_CHARS) {
          skipped.push({
            operationId: operation.operationId ?? '',
            action: operation.action,
            reason: `A new fragment proposed for unattended application must stay within ${MAX_NEW_FRAGMENT_CONTENT_CHARS} characters.`,
          })
          continue
        }
        eligible.push(operation)
      }

      const validation = eligible.length > 0
        ? await validateOperations(opts.dataDir, opts.storyId, eligible, {
          allowedCreateTypes: allowedTypes,
          createTypeScopeDescription: 'librarian analysis proposals',
        })
        : { operations: [], results: [] as OperationValidation[] }
      for (const result of validation.results) {
        if (result.status !== 'valid') skipped.push(skippedOperation(result))
      }

      if (validation.operations.length === 0) {
        return {
          ok: false,
          proposalCount: collector.fragmentChangeProposals.length,
          queuedOperationCount: 0,
          invalid: skipped.length,
          evidenceMatched: true,
          evidenceRetained: true,
          ...operationEchoFields(validation.results),
          skipped,
          note: 'No operation was queued. The grounded evidence is retained; fix only the reported operations and retry.',
        }
      }

      const queuedResult = queueFragmentChangeProposal({
        collector,
        title: params.title ?? params.retained.title,
        rationale: params.rationale ?? params.retained.rationale,
        proposalKind: params.proposalKind,
        evidenceSegments: params.retained.evidenceSegments,
        evidenceText: params.retained.evidenceText,
        eligibilityReason: params.rationale ?? params.retained.rationale,
        // Semantic contradiction classification remains an LLM judgment. A
        // structurally grounded mistake is still possible, so canon corrections
        // stay visible for author review rather than writing unattended. New
        // named records remain safe to auto-apply.
        autoApplySafe: params.proposalKind === 'new-fragment',
        operations: validation.operations,
        validation: validation.results,
      })
      const duplicate = validation.operations.length > 0 && queuedResult.queued.length === 0
      successfulToolNames.add(params.toolName)
      // Only a fully accepted call is done with its citation; otherwise it stays
      // for the narrower retry, which would otherwise cost a fresh report.
      if (skipped.length === 0) {
        if (params.proposalKind === 'correction') retainedCorrectionEvidence = null
        else retainedNewRecordEvidence = null
      }
      return {
        ok: true,
        proposalCount: collector.fragmentChangeProposals.length,
        queuedOperationCount: queuedResult.queued.length,
        invalid: skipped.length,
        evidenceMatched: true,
        autoApplySafe: params.proposalKind === 'new-fragment',
        ...(skipped.length > 0 ? { evidenceRetained: true } : {}),
        ...(duplicate ? { duplicate: true, note: 'An identical fragment change proposal was already queued; not queued again.' } : {}),
        ...(skipped.length > 0 && !duplicate ? {
          note: 'The eligible operations were queued. The rest are reported above with the grounded evidence retained; resubmit only those, addressed as each reason directs.',
        } : {}),
        ...operationEchoFields(validation.results),
        skipped,
      }
    }

    // Every proposal-lane return path funnels through here so finishAnalysis can
    // tell "never attempted" from "attempted and left work behind". A partly
    // queued call counts as the latter: the queued operations are safe, and the
    // rejected ones would otherwise vanish with nothing asking after them.
    const recordProposalOutcome = <T extends { ok: boolean; invalid?: number }>(
      toolName: 'proposeRecordCorrections' | 'proposeNewRecords',
      result: T,
    ): T => {
      if (result.ok && !result.invalid) unfinishedProposalToolNames.delete(toolName)
      else unfinishedProposalToolNames.add(toolName)
      return result
    }

    tools.proposeRecordCorrections = tool({
      description: 'Propose an author-reviewed record correction only when a grounded reportAnalysis finding includes recordCorrectionReason establishing why that record is wrong. A prose error or unresolved conflict remains a finding, without rewriting the record. Name the cited sentence and corrected wording. Eligible corrections are queued individually and never written unattended.',
      inputSchema: librarianRecordCorrectionsInputSchema,
      execute: async ({ title, evidenceSegments = [], rationale, corrections = [] }) => {
        const record = <T extends { ok: boolean; invalid?: number }>(result: T) => recordProposalOutcome('proposeRecordCorrections', result)
        const evidence = await resolveEvidence('correction', evidenceSegments, title, rationale)
        if (evidence.error) return record(evidence.error as { ok: boolean })
        if (corrections.length === 0) {
          return record({
            ok: false,
            proposalCount: collector.fragmentChangeProposals.length,
            queuedOperationCount: 0,
            invalid: 1,
            evidenceMatched: true,
            evidenceRetained: true,
            note: 'Citation retained. Resubmit with at least one correction; evidenceSegments, title, and rationale may be omitted on the retry.',
          })
        }
        // Resolve each cited sentence into the exact span it addresses. The
        // model never states the old text, so it cannot get it wrong; an
        // unresolvable citation is reported against the numbering it saw.
        const unresolved: AnalysisProposalSkipped[] = []
        const operations: FragmentChangeOperation[] = []
        const resolved: Array<{
          fragmentId: string
          target: Fragment
          field: 'content' | 'description'
          current: string
          segment: TextSegment
          segments: TextSegment[]
          newText: string
          reason?: string
          wholeField: boolean
        }> = []
        for (const correction of corrections) {
          const field = correction.field ?? 'content'
          const target = await getFragment(opts.dataDir, opts.storyId, correction.fragmentId)
          const current = target?.[field]
          if (!target || typeof current !== 'string') {
            // Continuity memory names its keys the way the catalog names
            // records, so aiming a correction at one is a category error the
            // framework invited rather than a misread instruction. Saying only
            // that the target could not be read costs a whole extra report round
            // trip while the model works the distinction out unaided.
            const asContinuityKey = continuityKeyOwners.get(normalizeContinuityKey(correction.fragmentId))
            unresolved.push({
              operationId: '',
              action: 'replace_text',
              reason: asContinuityKey
                ? `${correction.fragmentId} is a ${asContinuityKey} key in continuity memory, not a reusable record. Change it with a reportAnalysis ${asContinuityKey} operation instead.`
                : `There is no reusable record ${correction.fragmentId}${field === 'content' ? '' : ` with a ${field} field`}. Correct only records whose numbered sentences you were shown.`,
            })
            continue
          }
          // A record merely recognised from the catalog would otherwise be
          // corrected at whichever sentence happens to hold the cited position.
          if (!numberedFragmentIds.has(correction.fragmentId)) {
            unresolved.push({
              operationId: '',
              action: 'replace_text',
              reason: `You have not been shown ${correction.fragmentId} with its sentences numbered, so its sentence numbers are not yours to cite. Read it with readFragments and correct the sentence you are shown.`,
            })
            continue
          }
          const segments = segmentText(current)
          const segment = segments.find((candidate) => candidate.index === correction.segment)
          // A single-sentence field is still correctable. Replacing the whole of
          // one is a rewrite rather than a localized edit, so it is held back
          // from *unattended* application in `unattendedProposalError`, which
          // re-checks against the record as it stands at apply time. Refusing it
          // outright here instead would put descriptions — capped at 250
          // characters, usually one sentence, and the field the catalog shows —
          // beyond correction entirely.
          if (!segment) {
            unresolved.push({
              operationId: '',
              action: 'replace_text',
              reason: `${correction.fragmentId}.${field} has ${segments.length} numbered sentences; ${correction.segment} is not one of them.`,
            })
            continue
          }
          const groundedTarget = collector.contradictions.some((contradiction) => (
            contradiction.conflictingEvidence?.some((conflict) => (
              conflict.fragmentId === correction.fragmentId
              && conflict.segments.includes(correction.segment)
            ))
          ))
          if (!groundedTarget) {
            unresolved.push({
              operationId: '',
              action: 'replace_text',
              reason: `${correction.fragmentId} sentence ${correction.segment} was not cited as the conflicting side of a grounded reportAnalysis contradiction. Record ordinary progression in continuity state; correct canon only through a reported contradiction.`,
            })
            continue
          }
          const correctionAuthorized = collector.contradictions.some((contradiction) => (
            contradiction.recordCorrectionReason?.trim()
            && contradiction.conflictingEvidence?.some((conflict) => (
              conflict.fragmentId === correction.fragmentId
              && conflict.segments.includes(correction.segment)
            ))
          ))
          if (!correctionAuthorized) {
            unresolved.push({
              operationId: '',
              action: 'replace_text',
              reason: 'The conflict is recorded for review, but does not authorize changing this record. Supply recordCorrectionReason in reportAnalysis only if evidence establishes that the record itself is wrong; otherwise leave the finding for prose review.',
            })
            continue
          }
          // The record was shown numbered, so the model writes the marker back
          // with its replacement; it is presentation, never content.
          resolved.push({
            fragmentId: correction.fragmentId,
            target,
            field,
            current,
            segment,
            segments,
            newText: stripSegmentMarker(correction.newText),
            reason: correction.reason,
            // Replacing the only sentence of a field rewrites the whole field.
            wholeField: current.trim() === segment.text.trim(),
          })
        }

        // One event is one proposal, so a record's edits stay together. How many
        // writes they take is the engine's problem: `set_fields` carries a base
        // hash and the shared validator will not let it share a fragment with
        // localized edits, so when any field of a record is replaced outright,
        // every edit to that record composes into one `set_fields`.
        const byFragment = new Map<string, typeof resolved>()
        for (const item of resolved) {
          byFragment.set(item.fragmentId, [...(byFragment.get(item.fragmentId) ?? []), item])
        }

        for (const [fragmentId, items] of byFragment) {
          if (!items.some((item) => item.wholeField)) {
            for (const item of items) {
              const twins = item.segments.filter((candidate) => candidate.text === item.segment.text)
              operations.push({
                action: 'replace_text',
                fragmentId,
                field: item.field,
                oldText: item.segment.text,
                newText: item.newText,
                replaceAll: false,
                // A sentence can repeat verbatim; the citation already says which.
                ...(twins.length > 1
                  ? { occurrence: twins.findIndex((candidate) => candidate.index === item.segment.index) + 1 }
                  : {}),
                ...(item.reason ? { reason: item.reason } : {}),
              })
            }
            continue
          }

          // Splice each cited span out of the field it belongs to, last first,
          // so an earlier replacement cannot shift the offsets of a later one.
          const fields: Record<string, string> = {}
          for (const item of items) {
            const edits = items.filter((other) => other.field === item.field)
            if (fields[item.field] !== undefined) continue
            fields[item.field] = edits
              .slice()
              .sort((a, b) => b.segment.start - a.segment.start)
              .reduce(
                (text, edit) => text.slice(0, edit.segment.start) + edit.newText + text.slice(edit.segment.end),
                item.current,
              )
          }
          const reasons = items.map((item) => item.reason).filter((reason): reason is string => !!reason)
          operations.push({
            action: 'set_fields',
            fragmentId,
            baseHash: fragmentBaseHash(items[0].target),
            fields,
            ...(reasons.length > 0 ? { reason: reasons.join(' ') } : {}),
          })
        }
        // Unresolvable targets are reported alongside whatever did resolve, not
        // instead of it. Each carries its own diagnosis, so the shared note
        // stays generic; a blanket line about sentence numbers would mislabel a
        // wrong-target failure.
        return record(await queueValidatedProposal({
          toolName: 'proposeRecordCorrections',
          proposalKind: 'correction',
          retained: evidence.retained!,
          title,
          rationale,
          operations,
          rejected: unresolved,
        }))
      },
    })

    tools.proposeNewRecords = tool({
      description: 'Create genuinely new reusable named story records established by accepted prose. Do not use this for events, temporary conditions, unnamed scenery, or psychological state.',
      inputSchema: librarianNewRecordsInputSchema,
      execute: async ({ title, evidenceSegments = [], rationale, newFragments = [] }) => {
        const record = <T extends { ok: boolean; invalid?: number }>(result: T) => recordProposalOutcome('proposeNewRecords', result)
        const evidence = await resolveEvidence('new-fragment', evidenceSegments, title, rationale)
        if (evidence.error) return record(evidence.error as { ok: boolean })
        if (newFragments.length === 0) {
          return record({
            ok: false,
            proposalCount: collector.fragmentChangeProposals.length,
            queuedOperationCount: 0,
            invalid: 1,
            evidenceMatched: true,
            evidenceRetained: true,
            note: 'Citation retained. Resubmit with at least one new reusable record; evidenceSegments, title, and rationale may be omitted on the retry.',
          })
        }
        return record(await queueValidatedProposal({
          toolName: 'proposeNewRecords',
          proposalKind: 'new-fragment',
          retained: evidence.retained!,
          title,
          rationale,
          operations: newFragments.map((operation) => ({ ...operation, action: 'create_fragment' as const })),
        }))
      },
    })
  }

  if (!opts?.disableDirections) {
    tools.proposeDirections = tool({
      description: 'Required when available: suggest 3-5 possible directions the story could go next, informed by the records reportAnalysis returned.',
      inputSchema: z.object({
        directions: z.array(suggestionDirectionSchema).min(3).max(5),
      }),
      execute: async ({ directions }) => {
        collector.directions = directions
        successfulToolNames.add('proposeDirections')
        return { ok: true }
      },
    })
  }

  if (opts?.includeFinishTool !== false) {
    tools.finishAnalysis = tool({
      description: 'Signal that the online analysis pass has completed all useful report, proposal, and direction tool calls. This does not record story data; it only ends the tool loop.',
      inputSchema: librarianFinishAnalysisInputSchema,
      execute: async ({ skipped = [] }) => {
        const abandoned = skipped.map((entry) => (
          typeof entry === 'string' ? { toolName: entry } : entry
        ))
        const skippedNames = new Set<string>(abandoned.map((entry) => entry.toolName))
        const missingRequired: string[] = []
        if (tools.reportAnalysis && !successfulToolNames.has('reportAnalysis')) missingRequired.push('reportAnalysis')
        // Record maintenance is optional, so a lane that was never called needs
        // no declaration. Requiring one anyway spends an extra finish round trip
        // whenever a successful correction is not accompanied by a skip note for
        // the untouched discovery lane. Only a lane left with work outstanding
        // must be retried or explicitly abandoned, and there the reason is
        // load-bearing: it is the only record of why a known-wrong proposal was
        // dropped rather than fixed.
        const unexplained: string[] = []
        for (const proposalToolName of ['proposeRecordCorrections', 'proposeNewRecords']) {
          if (!tools[proposalToolName] || !unfinishedProposalToolNames.has(proposalToolName)) continue
          if (!skippedNames.has(proposalToolName)) {
            missingRequired.push(proposalToolName)
            continue
          }
          const declared = abandoned.find((entry) => entry.toolName === proposalToolName)
          if (!declared?.reason) unexplained.push(proposalToolName)
        }
        if (tools.proposeDirections && !successfulToolNames.has('proposeDirections')) {
          missingRequired.push('proposeDirections')
        }

        if (missingRequired.length > 0 || unexplained.length > 0) {
          return {
            ok: false,
            missingRequired,
            ...(unexplained.length > 0 ? { unexplained } : {}),
            ...(unresolvedContinuity.length > 0 ? {
              continuityNeedsCorrection: true,
              skippedContinuity: unresolvedContinuity,
            } : {}),
            note: unresolvedContinuity.length > 0
              ? 'Finish only after reportAnalysis repairs every rejected continuity item. Accepted report data is already retained, so retry only the missing operations plus enough summary to make a non-empty report.'
              : 'Finish only after required tools succeed. A proposal call that failed or was only partly queued must be retried, or listed under skipped as {toolName, reason} saying why the rest was abandoned; a lane you never needed requires nothing.',
          }
        }
        return { ok: true, completed: [...successfulToolNames], skipped: abandoned }
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
