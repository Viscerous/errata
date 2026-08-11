import { createHash } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { suggestionDirectionSchema, type SuggestionDirection } from '../directions/schema'
import { getFragment, updateFragment } from '../fragments/storage'
import { FragmentIdSchema, type Fragment } from '../fragments/schema'
import { numberSentences, resolveSegments, segmentText, stripSegmentMarker, type TextSegment } from '../llm/segments'
import type { LibrarianFragmentChangeProposal, LibrarianMention } from './storage'
import type { ContinuityProjection, KnowledgeOperation, StateOperation, ThreadFocus, ThreadOperation } from './continuity-types'
import { normalizeContinuityKey } from '@/lib/continuity-keys'
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

/**
 * Write mention annotations onto the prose fragment immediately (meta-only, so it
 * creates no version). Called from reportAnalysis so highlights appear as soon
 * as mentions resolve, rather than waiting for the whole analysis run to finish.
 */
async function persistMentionAnnotations(
  dataDir: string,
  storyId: string,
  proseFragmentId: string,
  mentions: LibrarianMention[],
): Promise<void> {
  const prose = await getFragment(dataDir, storyId, proseFragmentId)
  if (!prose) return
  await updateFragment(dataDir, storyId, {
    ...prose,
    meta: { ...prose.meta, annotations: toMentionAnnotations(mentions) },
  })
}

// --- Collector ---

export interface AnalysisCollector {
  summaryUpdate: string
  structuredSummary: {
    events: string[]
    stateChanges: string[]
    openThreads: string[]
  }
  mentions: LibrarianMention[]
  candidateFragmentIds: string[]
  contradictions: Array<{
    description: string
    fragmentIds: string[]
    sourceSegments?: number[]
    sourceEvidenceText?: string
    conflictingEvidence?: Array<{ fragmentId: string; segments: number[]; evidenceText: string }>
  }>
  fragmentChangeProposals: LibrarianFragmentChangeProposal[]
  timelineEvents: Array<{ event: string; position: 'before' | 'during' | 'after' }>
  continuityProjection: ContinuityProjection
  directions: SuggestionDirection[]
}

export function createEmptyCollector(): AnalysisCollector {
  return {
    summaryUpdate: '',
    structuredSummary: {
      events: [],
      stateChanges: [],
      openThreads: [],
    },
    mentions: [],
    candidateFragmentIds: [],
    contradictions: [],
    fragmentChangeProposals: [],
    timelineEvents: [],
    continuityProjection: {
      version: 1,
      temporalFrame: { relation: 'uncertain' },
      stateOperations: [],
      threadOperations: [],
      threadFocus: [],
      knowledgeOperations: [],
    },
    directions: [],
  }
}

function normalizeUniqueLines(values: string[] | undefined, maxItems: number, maxItemChars = 200): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    const trimmed = value.trim().slice(0, maxItemChars)
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

export function renderStructuredSummary(structured: {
  events: string[]
  stateChanges: string[]
  openThreads: string[]
}): string {
  const parts: string[] = []
  if (structured.events.length > 0) {
    parts.push(`Events: ${structured.events.join('; ')}.`)
  }
  if (structured.stateChanges.length > 0) {
    parts.push(`State changes: ${structured.stateChanges.join('; ')}.`)
  }
  if (structured.openThreads.length > 0) {
    parts.push(`Open threads: ${structured.openThreads.join('; ')}.`)
  }

  return sentenceJoin(parts).trim()
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
 * one integer rather than a few hundred output characters. Timeline 9 lost four
 * of fourteen proposal calls to unquotable evidence; there is nothing to
 * mis-transcribe here.
 */
/**
 * How many cited sentences are kept. Brevity is a preference, not an invariant:
 * over-citing costs a longer stored evidence string and nothing else, so the
 * bound is applied when the citation is resolved rather than made a condition of
 * accepting the call. As a schema `.max()` it rejected the whole payload —
 * Timeline 10 lost a full reportAnalysis and proposeDirections round trip
 * because one knowledge operation cited nine sentences instead of eight.
 */
export const MAX_CITED_SEGMENTS = 8

const proseCitationSchema = z.array(z.number().int().positive()).default([])
  .describe(`Sentence numbers from the New Prose Fragment that show this. Cite the fewest that carry it; only the first ${MAX_CITED_SEGMENTS} are kept.`)

/** Conditional maintenance lanes may be abandoned after a failed attempt. */
const skippedToolNameSchema = z.enum(['proposeRecordCorrections', 'proposeNewRecords'])

const temporalFrameSchema = z.object({
  relation: z.enum(['forward', 'flashback', 'flash-forward', 'concurrent', 'uncertain']).default('uncertain')
    .describe('The passage relationship to the current narrative present. Use forward for an ordinary continuation; uncertain only when the frame truly cannot be determined.'),
  anchor: z.string().trim().max(200).optional()
    .describe('Optional story-time anchor in natural language, such as "three winters earlier".'),
  evidenceSegments: proseCitationSchema
    .describe('Sentence numbers carrying the temporal cue, when the prose gives one.'),
}).default({ relation: 'uncertain', evidenceSegments: [] })

/** The live registry, so an operation can pick an identity rather than spell one. */
export interface ContinuityKeyReference {
  key: string
  /** Human-readable identity already stored under the key. */
  label?: string
  /** Character id for knowledge, whose keys are scoped per character. */
  scope?: string
}

export interface ContinuityKeyRegistry {
  state?: Array<string | ContinuityKeyReference>
  thread?: Array<string | ContinuityKeyReference>
  knowledge?: Array<string | ContinuityKeyReference>
}

/**
 * A continuity key is only an identity if two observations of the same thing
 * land on the same key. Asking for a free string and describing the rule did not
 * achieve that on its own: Timeline 9 produced seven knowledge keys for seven
 * facts, five carrying an invented fragment-id prefix.
 *
 * Reuse is steered by naming the live keys at the point of use and by
 * canonicalizing whatever arrives, not by a closed enum. Splitting the field
 * into existingKey/newKey did enforce the choice, but enforcing it cost the
 * whole batched report whenever the model chose wrong — 11 of Timeline 11's 14
 * rejections, because a 12B cannot reliably pick between two sibling optional
 * fields. Normalization already collapses the spellings the enum was there to
 * collapse, so the enum was buying compliance the fold delivers anyway.
 */
const MAX_STEERED_REGISTRY_KEYS = 24

/** Bound on any continuity key, whether the model spelled it or it was derived. */
const MAX_CONTINUITY_KEY_CHARS = 100
const MAX_DERIVED_KEY_CHARS = 64

function registryKey(reference: string | ContinuityKeyReference): string {
  return typeof reference === 'string' ? reference : reference.key
}

function continuityKeyFields(
  existing: Array<string | ContinuityKeyReference> | undefined,
  noun: string,
  example: string,
  creationAction: 'set' | 'open' | 'learn',
) {
  // Sorted so the description is byte-identical whenever the key set is
  // unchanged. Registry order follows recency of update, which would otherwise
  // rewrite the tool block on every analysis and cost the prompt cache.
  const unique = [...new Set((existing ?? []).map((reference) => (
    normalizeContinuityKey(registryKey(reference))
  )))].filter(Boolean).sort()
  const reuse = unique.length > 0
    ? ` Reuse one of these exactly when the passage changes something already tracked: ${unique.slice(0, MAX_STEERED_REGISTRY_KEYS).join(', ')}.`
    : ''
  return {
    key: z.string().trim().max(MAX_CONTINUITY_KEY_CHARS).nullish()
      .describe(`The ${noun}.${reuse} For a genuinely new identity introduced by a ${creationAction} operation, you may omit this and the engine will derive it. Every other action must name the existing key. If you coin one, use snake_case naming the thing itself, such as ${example}; never include a character or fragment ID.`),
  }
}

function stateOperationSchemaFor(registry: ContinuityKeyRegistry) {
  return z.object({
    ...continuityKeyFields(registry.state, 'state identity', 'captivity_status', 'set'),
    action: z.enum(['set', 'clear']),
    subject: z.string().trim().min(1).max(160),
    value: z.string().trim().max(300).optional(),
    evidenceSegments: proseCitationSchema,
  })
}

function threadOperationSchemaFor(registry: ContinuityKeyRegistry) {
  return z.object({
    ...continuityKeyFields(registry.thread, 'unresolved question', 'who_betrayed_the_house', 'open'),
    action: z.enum(['open', 'advance', 'resolve', 'abandon']),
    label: z.string().trim().max(240).optional()
      .describe('Optional plain-language phrasing of the question. Omit it and the key is used.'),
    note: z.string().trim().max(300).optional(),
    relatedFragmentIds: z.array(FragmentIdSchema).max(40).default([]),
    evidenceSegments: proseCitationSchema,
  })
}

// Focus may name a thread opened in this call or inherit an aligned operation,
// so its key remains open-ended and optional at the schema boundary.
const threadFocusSchema = z.object({
  threadKey: z.string().trim().max(MAX_CONTINUITY_KEY_CHARS).nullish(),
  visibility: z.enum(['foreground', 'background']),
})

function knowledgeOperationSchemaFor(registry: ContinuityKeyRegistry) {
  return z.object({
    characterId: FragmentIdSchema,
    ...continuityKeyFields(registry.knowledge, 'fact identity', 'queen_identity', 'learn'),
    action: z.enum(['learn', 'correct', 'forget']),
    fact: z.string().trim().max(400).optional(),
    acquisition: z.enum(['witnessed', 'told', 'inferred', 'other']).default('other'),
    evidenceSegments: proseCitationSchema,
  })
}

export function buildReportAnalysisInputSchema(registry: ContinuityKeyRegistry = {}) {
  return z.object({
    summary: z.string().max(2400).default('').describe('A concise retrospective record of what had happened in the new prose fragment, written as past history rather than a scene to continue — a paragraph or two'),
    events: coercedStringArray
      .describe('Bullet-like event statements from the prose fragment — the few that matter, at most 8 are kept'),
    stateChanges: coercedStringArray
      .describe('What changed in goals, relationships, world state, or character condition — at most 8 are kept'),
    openThreads: coercedStringArray
      .describe('Unresolved continuity introduced or materially advanced by this prose. These are memory observations, not directions or promises that the next passage should resolve them — at most 8 are kept'),
    mentions: z.array(mentionInputSchema).max(150).default([])
      .describe('Distinct mentions of listed fragments in the new prose — at most one entry per fragment/text pair; a single mention highlights every occurrence of that text. Use exact prose text; never a bare pronoun.'),
    candidateFragmentIds: z.array(FragmentIdSchema).max(120).default([])
      .describe('Existing fragment IDs to return in full, even when the prose never names them. Two kinds: durable-memory candidates, and records this passage has made inaccurate. Your context lists every record with its description — use those to find the ones tied to whatever changed here.'),
    contradictions: z.array(z.object({
      description: z.string().describe('What the contradiction is'),
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
    timelineEvents: z.array(z.object({
      event: z.string().describe('Description of the significant event'),
      position: z.union([z.literal('before'), z.literal('during'), z.literal('after')])
        .describe('"before" for flashback, "during" for concurrent, "after" for sequential'),
    })).max(32).default([]),
    temporalFrame: temporalFrameSchema,
    stateOperations: z.array(stateOperationSchemaFor(registry)).max(80).default([])
      .describe('Keyed state deltas worth retaining after this prose leaves the recent window. Clear a prior key when the passage ends or supersedes it; omit momentary pose, sensation, emotion, and already-completed action.'),
    threadOperations: z.array(threadOperationSchemaFor(registry)).max(80).default([])
      .describe('Explicit lifecycle changes for unresolved narrative questions. Resolve completed questions, never repurpose a key, and remember that omission only makes a thread dormant.'),
    threadFocus: z.array(threadFocusSchema).max(80).default([])
      .describe('Snapshot of still-open threads relevant after this passage. Omitted live threads become dormant, not resolved. When this array aligns one-for-one with threadOperations, an omitted key inherits the key of the operation in the same position.'),
    knowledgeOperations: z.array(knowledgeOperationSchemaFor(registry)).max(120).default([])
      .describe('Only facts a specific character explicitly learns, corrects, or forgets and could later act upon. Do not store their desires, feelings, opinions, or facts merely visible to the reader.'),
  })
}

/** Registry-free shape for the context preview and the tool-name listing. */
export const reportAnalysisInputSchema = buildReportAnalysisInputSchema()

type ReportAnalysisInput = z.infer<ReturnType<typeof buildReportAnalysisInputSchema>>

function uniqueStrings(values: string[], maxItems: number): string[] {
  return [...new Set(values)].slice(0, maxItems)
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
): { evidenceSegments: number[]; evidenceText: string; invalid: number[] } {
  const resolved = resolveSegments(segments, cited.slice(0, MAX_CITED_SEGMENTS))
  return {
    evidenceSegments: resolved.indexes,
    evidenceText: resolved.text,
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
 * For creation operations, an omitted key can be matched exactly to a live
 * label or derived from the operation's descriptive field. Mutations remain
 * stricter: without an explicit, retry-inherited, or exact live identity they
 * are skipped rather than allowed to create a second thing accidentally.
 */
function chosenKey(operation: { key?: unknown }, derivedFrom?: string): string | null {
  const declared = typeof operation.key === 'string' ? normalizeContinuityKey(operation.key) : ''
  return declared || derivedContinuityKey(derivedFrom) || null
}

function citationProblem(
  resolved: { evidenceSegments: number[]; invalid: number[] },
): string | null {
  if (resolved.invalid.length > 0) {
    return `Cited sentence ${resolved.invalid.join(', ')} does not exist in the passage.`
  }
  if (resolved.evidenceSegments.length === 0) return 'No supporting sentence was cited.'
  return null
}

/**
 * Dropped work explains itself on the entry, never only in a sibling note
 * beside the list: the trace panel and the model both read entries. Mentions
 * once carried their explanation in a `skippedMentionNote` alone, so seven
 * losses in one run rendered as blank rows the moment the panel learned to
 * report refusals at all.
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
const knowledgeKeyOf = (operation: KnowledgeOperation) => `${operation.characterId}\u0000${operation.knowledgeKey}`

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

function uniquelyMatchingRegistryKey(
  references: Array<string | ContinuityKeyReference> | undefined,
  source: string | undefined,
  scope?: string,
): string | undefined {
  const identity = normalizeContinuityKey(source ?? '')
  if (!identity) return undefined
  const matches = new Set<string>()
  for (const reference of references ?? []) {
    if (typeof reference !== 'string' && reference.scope && reference.scope !== scope) continue
    const key = normalizeContinuityKey(registryKey(reference))
    const label = typeof reference === 'string' ? '' : normalizeContinuityKey(reference.label ?? '')
    if (identity === key || identity === label) matches.add(key)
  }
  return matches.size === 1 ? [...matches][0] : undefined
}

function retryAwareKey<T>(
  operation: { key?: unknown },
  derivedFrom: string | undefined,
  options: {
    allowDerived: boolean
    previous: T[]
    registry: Array<string | ContinuityKeyReference> | undefined
    scope?: string
    signature: string
    signatureOf: (item: T) => string
    keyOf: (item: T) => string
  },
): string | null {
  return chosenKey(operation)
    || uniquelyMatchingKey(options.previous, options.signature, options.signatureOf, options.keyOf)
    || uniquelyMatchingRegistryKey(options.registry, derivedFrom, options.scope)
    || (options.allowDerived ? chosenKey(operation, derivedFrom) : null)
}

function missingExistingKeyReason(lane: 'state' | 'thread' | 'knowledge', action: string): string {
  return `A ${lane} ${action} operation must name the existing key; no unambiguous retry or live-registry match was found.`
}

function normalizeContinuityProjection(
  input: Pick<ReportAnalysisInput,
    | 'temporalFrame'
    | 'stateOperations'
    | 'threadOperations'
    | 'threadFocus'
    | 'knowledgeOperations'>,
  segments: TextSegment[],
  previous?: ContinuityProjection,
  registry: ContinuityKeyRegistry = {},
): { projection: ContinuityProjection; skipped: Array<Skipped<{ kind: string; key: string }>> } {
  const skipped: Array<Skipped<{ kind: string; key: string }>> = []
  let temporalFrame = input.temporalFrame
  if (temporalFrame.relation !== 'forward' && temporalFrame.relation !== 'uncertain') {
    const resolved = citedEvidence(segments, temporalFrame.evidenceSegments)
    const problem = citationProblem(resolved)
    if (problem) {
      skipped.push({ kind: 'temporal-frame', key: temporalFrame.relation, reason: problem })
      temporalFrame = { relation: 'uncertain', evidenceSegments: [] }
    } else {
      temporalFrame = { ...temporalFrame, ...resolved }
    }
  }

  const stateOperations: StateOperation[] = []
  for (const operation of input.stateOperations) {
    const stateKey = retryAwareKey(
      operation,
      operation.subject,
      {
        allowDerived: operation.action === 'set',
        previous: previous?.stateOperations ?? [],
        registry: registry.state,
        signature: stateSignatureOf(operation),
        signatureOf: stateSignatureOf,
        keyOf: stateKeyOf,
      },
    )
    if (!stateKey) {
      skipped.push({
        kind: 'state',
        key: operation.subject,
        reason: operation.action === 'set'
          ? 'A state operation needs enough identity to derive a key.'
          : missingExistingKeyReason('state', operation.action),
      })
      continue
    }
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
    stateOperations.push({ ...operation, ...resolved, stateKey })
  }

  const threadOperations: ThreadOperation[] = []
  const threadKeysByInputIndex: Array<string | undefined> = []
  for (const [inputIndex, operation] of input.threadOperations.entries()) {
    const threadKey = retryAwareKey(
      operation,
      operation.label || operation.note,
      {
        allowDerived: operation.action === 'open',
        previous: previous?.threadOperations ?? [],
        registry: registry.thread,
        signature: threadSignatureOf(operation),
        signatureOf: threadSignatureOf,
        keyOf: threadKeyOf,
      },
    )
    if (!threadKey) {
      skipped.push({
        kind: 'thread',
        key: operation.label ?? '',
        reason: operation.action === 'open'
          ? 'A thread operation needs enough identity to derive a key.'
          : missingExistingKeyReason('thread', operation.action),
      })
      continue
    }
    const resolved = citedEvidence(segments, operation.evidenceSegments)
    const problem = citationProblem(resolved)
    if (problem) {
      skipped.push({ kind: 'thread', key: threadKey, reason: problem })
      continue
    }
    threadKeysByInputIndex[inputIndex] = threadKey
    threadOperations.push({
      ...operation,
      ...resolved,
      threadKey,
      relatedFragmentIds: uniqueStrings(operation.relatedFragmentIds, 20),
    })
  }

  const knowledgeOperations: KnowledgeOperation[] = []
  for (const operation of input.knowledgeOperations) {
    const knowledgeKey = retryAwareKey(
      operation,
      operation.fact,
      {
        allowDerived: operation.action === 'learn',
        previous: previous?.knowledgeOperations ?? [],
        registry: registry.knowledge,
        scope: operation.characterId,
        signature: knowledgeSignatureOf(operation),
        signatureOf: knowledgeSignatureOf,
        keyOf: (item) => item.knowledgeKey,
      },
    )
    if (!knowledgeKey) {
      skipped.push({
        kind: 'knowledge',
        key: operation.characterId,
        reason: operation.action === 'learn'
          ? 'A knowledge operation needs enough identity to derive a key.'
          : missingExistingKeyReason('knowledge', operation.action),
      })
      continue
    }
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
    knowledgeOperations.push({ ...operation, ...resolved, knowledgeKey })
  }

  const threadFocus: ThreadFocus[] = []
  const positionallyAlignedFocus = input.threadFocus.length === input.threadOperations.length
  for (const [inputIndex, focus] of input.threadFocus.entries()) {
    const explicitKey = normalizeContinuityKey(focus.threadKey ?? '')
    const threadKey = explicitKey || (positionallyAlignedFocus ? threadKeysByInputIndex[inputIndex] : undefined)
    if (!threadKey) {
      skipped.push({
        kind: 'thread-focus',
        key: '',
        reason: 'A thread focus entry must name its thread key or align with a successfully recorded thread operation.',
      })
      continue
    }
    threadFocus.push({ ...focus, threadKey })
  }

  return {
    projection: {
      version: 1,
      temporalFrame,
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
 * plain assignment made every retry a truncation: one passage reported two valid
 * thread operations and then seven empty sets, and only the empty set survived.
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
    // A bare `uncertain` is the schema default, so it carries no claim and must
    // not overwrite a frame an earlier call actually determined.
    temporalFrame: next.temporalFrame.relation === 'uncertain' ? previous.temporalFrame : next.temporalFrame,
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
 * against a record the model had only read. Timeline 9 shows what that bought:
 * one call failed outright on `oldText was not found`, and every call that
 * succeeded submitted a whole copied paragraph, so the "smallest correction"
 * rule had to be reconstructed server-side and still let two episode recaps
 * through. Addressing a sentence makes the scope structural — a paragraph
 * recap is not expressible — and removes the transcription step entirely.
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
export const librarianRecordCorrectionsInputSchema = z.object({
  title: z.string().max(100).optional(),
  evidenceSegments: proposalEvidenceSchema
    .describe('Sentence numbers from the New Prose Fragment that establish this change. Required on the first attempt; a retry may omit them because the tool retains the last grounded citation.'),
  rationale: z.string().trim().max(600).optional(),
  corrections: z.array(correctionProposalItemSchema).max(4).default([])
    .describe('Localized replacements for existing assertions made inaccurate by this prose, including through ordinary story progression.'),
})

export const librarianNewRecordsInputSchema = z.object({
  title: z.string().max(100).optional(),
  evidenceSegments: proposalEvidenceSchema
    .describe('Sentence numbers from the New Prose Fragment that establish this change. Required on the first attempt; a retry may omit them because the tool retains the last grounded citation.'),
  rationale: z.string().trim().max(600).optional(),
  newFragments: z.array(newFragmentProposalItemSchema).max(4).default([])
    .describe('Genuinely new reusable named records. Do not create event logs, current-condition notes, scene details, or duplicates.'),
})

/**
 * A bare tool name is accepted because it is the shape models reach for first,
 * and for a lane that was never called it is complete information — the gate
 * does not require those to be declared at all. Demanding {toolName, reason}
 * for them cost Timeline 10 a retry on five of twenty-three analyses and told
 * the gate nothing it went on to use.
 */
export const librarianFinishAnalysisInputSchema = z.object({
  completed: z.array(z.enum(['reportAnalysis', 'proposeRecordCorrections', 'proposeNewRecords', 'proposeDirections']))
    .default([])
    .describe('Tool names whose last call succeeded. Do not list a failed proposal call as completed.'),
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
    ...(params.title?.trim() ? { title: params.title.trim() } : {}),
    ...(params.rationale?.trim() ? { rationale: params.rationale.trim() } : {}),
    ...(params.proposalKind ? { proposalKind: params.proposalKind } : {}),
    ...(params.evidenceSegments?.length ? { evidenceSegments: params.evidenceSegments } : {}),
    ...(params.evidenceText ? { evidenceText: params.evidenceText } : {}),
    ...(params.eligibilityReason ? { eligibilityReason: params.eligibilityReason } : {}),
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
  /**
   * Proposal lanes whose most recent call left something undone — refused
   * outright, or queued in part. Record maintenance is optional, so never
   * calling a lane needs no declaration; walking away from work the lane
   * reported back does.
   */
  const unfinishedProposalToolNames = new Set<string>()
  /** Which continuity lane owns a key, so a correction aimed at one can say so. */
  const continuityKeyOwners = new Map<string, 'state' | 'thread' | 'knowledge'>()
  for (const lane of ['state', 'thread', 'knowledge'] as const) {
    for (const key of opts?.continuityKeys?.[lane] ?? []) {
      const normalized = normalizeContinuityKey(registryKey(key))
      if (normalized) continuityKeyOwners.set(normalized, lane)
    }
  }
  let retainedCorrectionEvidence: RetainedProposalEvidence | null = null
  let retainedNewRecordEvidence: RetainedProposalEvidence | null = null

  if (opts?.includeReportTool !== false) {
    tools.reportAnalysis = tool({
      description: 'Report the prose analysis in one batch: summary, mentions, temporal frame, keyed state changes, thread lifecycle/focus, explicit character knowledge changes, contradictions, and timeline events. Call once with everything you found. If a later step proves the report wrong or incomplete, call it again with the corrected set: the newest summary replaces the prior one, continuity entries it restates supersede their prior versions, and omitted continuity entries plus mentions, candidates, contradictions, and timeline events are retained.',
      inputSchema: buildReportAnalysisInputSchema(opts?.continuityKeys ?? {}),
      execute: async ({
        summary = '',
        events = [],
        stateChanges = [],
        openThreads = [],
        mentions = [],
        candidateFragmentIds = [],
        contradictions = [],
        timelineEvents = [],
        temporalFrame = { relation: 'uncertain', evidenceSegments: [] },
        stateOperations = [],
        threadOperations = [],
        threadFocus = [],
        knowledgeOperations = [],
      }) => {
        // An empty report still must not be a *schema* rejection — that makes
        // small models loop on resubmitting the whole payload. It is reported
        // as an unsuccessful call with a nudge, which finishAnalysis then reads
        // consistently. Returning ok:true here while withholding the success
        // marker told the model its call had succeeded and then, at finish,
        // that it had falsely claimed the very same call.
        const signalCount =
          Number(summary.trim().length > 0) +
          events.length +
          stateChanges.length +
          openThreads.length +
          mentions.length +
          candidateFragmentIds.length +
          contradictions.length +
          timelineEvents.length +
          Number(temporalFrame.relation !== 'uncertain') +
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
          temporalFrame,
          stateOperations,
          threadOperations,
          threadFocus,
          knowledgeOperations,
        }, proseSegments, collector.continuityProjection, opts?.continuityKeys ?? {})
        collector.continuityProjection = mergeContinuityProjection(
          collector.continuityProjection,
          normalizedProjection.projection,
        )

        const trimmedSummary = summary.trim().slice(0, 1200)
        const hasSummarySignal =
          trimmedSummary.length > 0 ||
          events.length > 0 ||
          stateChanges.length > 0 ||
          openThreads.length > 0
        if (hasSummarySignal) {
          const normalized = {
            events: normalizeUniqueLines(events, 8),
            stateChanges: normalizeUniqueLines(stateChanges, 8),
            openThreads: normalizeUniqueLines(openThreads, 8),
          }
          collector.structuredSummary = normalized
          collector.summaryUpdate = trimmedSummary.length > 0
            ? trimmedSummary
            : renderStructuredSummary(normalized)
        }

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
        // Both deltas are handed back here rather than demanded through
        // readFragments: this call already loaded every referenced fragment to
        // validate its ID, so requiring the model to fetch what the process is
        // holding bought nothing but round trips. Directions cannot outrank
        // context they did not see because the context arrives with the result.
        const resolvedFragments = deliverResolvedFragments(
          checkedFragments,
          [...anchoredMentions.map((mention) => mention.fragmentId), ...candidateFragmentIds],
          numberedFragmentIds,
        )

        // Persist annotations now so the prose highlights appear as soon as
        // mentions resolve, not at the end of the run.
        if (opts?.proseFragmentId && collector.mentions.length > 0) {
          await persistMentionAnnotations(opts.dataDir, opts.storyId, opts.proseFragmentId, collector.mentions)
        }
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
              : { evidenceSegments: [] as number[], evidenceText: '', invalid: [] as number[] }
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
            segments: check.resolved.evidenceSegments,
            evidenceText: check.resolved.evidenceText,
          }))
          groundedContradictions.push({
            description: contradiction.description,
            fragmentIds: uniqueStrings(evidenceChecks.map((check) => check.fragmentId), 8),
            sourceSegments: citedSource.evidenceSegments,
            sourceEvidenceText: citedSource.evidenceText,
            conflictingEvidence,
          })
        }
        const contradictionKeys = new Set(collector.contradictions.map((contradiction) => (
          `${normalizeForDedupe(contradiction.description)}\u0000${[...contradiction.fragmentIds].sort().join(',')}`
        )))
        for (const contradiction of groundedContradictions) {
          if (collector.contradictions.length >= 12) break
          const key = `${normalizeForDedupe(contradiction.description)}\u0000${[...contradiction.fragmentIds].sort().join(',')}`
          if (contradictionKeys.has(key)) continue
          contradictionKeys.add(key)
          collector.contradictions.push(contradiction)
        }

        const timelineKeys = new Set(collector.timelineEvents.map((event) => (
          `${event.position}\u0000${normalizeForDedupe(event.event)}`
        )))
        for (const event of timelineEvents) {
          if (collector.timelineEvents.length >= 12) break
          const key = `${event.position}\u0000${normalizeForDedupe(event.event)}`
          if (timelineKeys.has(key)) continue
          timelineKeys.add(key)
          collector.timelineEvents.push(event)
        }
        successfulToolNames.add('reportAnalysis')
        return {
          ok: true,
          mentionCount: collector.mentions.length,
          candidateFragmentCount: collector.candidateFragmentIds.length,
          contradictionCount: collector.contradictions.length,
          timelineEventCount: collector.timelineEvents.length,
          stateOperationCount: collector.continuityProjection.stateOperations.length,
          threadOperationCount: collector.continuityProjection.threadOperations.length,
          focusedThreadCount: collector.continuityProjection.threadFocus.length,
          knowledgeOperationCount: collector.continuityProjection.knowledgeOperations.length,
          ...(resolvedFragments.length > 0 ? {
            resolvedFragments,
            resolvedFragmentNote: 'Full records for what you just reported, not already in your context. Their sentences are numbered for correction targeting. Use them for directions and record maintenance; no further reads are needed for these.',
          } : {}),
          ...(normalizedProjection.skipped.length > 0 ? { skippedContinuity: normalizedProjection.skipped } : {}),
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
    Object.assign(tools, createFragmentTools(opts.dataDir, opts.storyId, {
      readOnly: true,
      numberedFragmentIds,
    }))
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
          evidenceSegments: resolved.evidenceSegments,
          evidenceText: resolved.evidenceText,
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
     * batch on its worst member. Timeline 13 sent three corrections to one
     * record and lost two sound ones because the third replaced a sentence with
     * itself; the model read `queuedOperationCount: 0` as a refusal and moved
     * on. This is how evidence already behaves here — a citation survives a
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
        autoApplySafe: true,
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
        autoApplySafe: true,
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
      description: 'Correct an assertion in an existing reusable record that accepted prose has made inaccurate. Name the numbered sentence to replace and supply its corrected wording. Cite a number only for a record you have been shown numbered; read it first otherwise. Eligible corrections are queued even when others in the same call are rejected.',
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
            // that the target could not be read sent Timeline 10 into a whole
            // extra report round trip to work the distinction out unaided.
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
          // from *unattended* application in `unattendedProposalError` — which
          // re-checks against the record as it stands at apply time. Refusing it
          // here instead destroyed the proposal outright, and descriptions are
          // both capped at 250 characters and the field the catalog shows, so
          // the most load-bearing surface in the story was the one correction
          // could never reach.
          if (!segment) {
            unresolved.push({
              operationId: '',
              action: 'replace_text',
              reason: `${correction.fragmentId}.${field} has ${segments.length} numbered sentences; ${correction.segment} is not one of them.`,
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

        // One event is one proposal, so a record's edits stay together. How
        // many writes they take is the engine's problem: `set_fields` carries a
        // base hash and the shared validator will not let it share a fragment
        // with localized edits, so when any field of a record is replaced
        // outright, every edit to that record composes into one `set_fields`.
        // Descriptions are capped at 250 characters and are usually a single
        // sentence, which is why this path exists at all — without it the field
        // the catalog shows could never be corrected.
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
        directions: z.array(suggestionDirectionSchema.extend({
          title: z.string().trim().min(1).describe('Short title for the direction (3-6 words)'),
          description: z.string().trim().min(1).describe('One sentence describing what would happen'),
          instruction: z.string().trim().min(1).describe('Instruction for the writer agent to follow this direction'),
        })).min(3).max(5),
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
      execute: async ({ completed = [], skipped = [] }) => {
        const abandoned = skipped.map((entry) => (
          typeof entry === 'string' ? { toolName: entry } : entry
        ))
        const skippedNames = new Set<string>(abandoned.map((entry) => entry.toolName))
        const falseCompleted = completed.filter((toolName) => !successfulToolNames.has(toolName))
        const missingRequired: string[] = []
        if (tools.reportAnalysis && !successfulToolNames.has('reportAnalysis')) missingRequired.push('reportAnalysis')
        // Record maintenance is optional, so a lane that was never called needs
        // no declaration. Timeline 9 spent an extra finish round trip on six of
        // sixteen analyses purely because a successful correction was not
        // accompanied by a skip note for the discovery lane. Only a lane left
        // with work outstanding must be retried or explicitly abandoned, and
        // there the reason is load-bearing: it is the only record of why a
        // known-wrong proposal was dropped rather than fixed.
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

        if (falseCompleted.length > 0 || missingRequired.length > 0 || unexplained.length > 0) {
          return {
            ok: false,
            falseCompleted,
            missingRequired,
            ...(unexplained.length > 0 ? { unexplained } : {}),
            note: 'Finish only after required tools succeed. A proposal call that failed or was only partly queued must be retried, or listed under skipped as {toolName, reason} saying why the rest was abandoned; a lane you never needed requires nothing.',
          }
        }
        return { ok: true, completed, skipped: abandoned }
      },
    })
  }

  return tools
}

/**
 * The analyze toolset. Single source for the runtime handler and the agent's
 * available-tools list, so the toggle path and the model stay in sync.
 *
 * Online analysis is a fused tool loop: report first, then read/propose as
 * needed. Deeper router/audit/backfill jobs can feed candidates into this same
 * shape; they are not separate observe/proposal analyze modes.
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
