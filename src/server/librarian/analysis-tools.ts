import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { getFragment, updateFragment } from '../fragments/storage'
import { FragmentIdSchema } from '../fragments/schema'
import type { LibrarianFragmentChangeProposal, LibrarianMention } from './storage'
import { createFragmentTools } from '../llm/tools'
import {
  type FragmentChangeOperation,
  type OperationValidation,
  OPERATION_GUIDANCE,
  operationEchoFields,
  proposeFragmentChangesSchema,
  unknownFragmentIdsMessage,
  validateOperations,
} from '../fragments/change-operations'

const mentionTextSchema = z.string().trim().min(1).describe('The exact name, title, or key term as it appears in the prose, copied verbatim — no added quotes, no paraphrase')

// Wrapping quotes and edge punctuation a model habitually adds around a term.
const MENTION_EDGE_TRIM_RE = /^["'‚„“”«»`‘’]+|["'‚„“”«»`‘’.,!?;:]+$/g

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
  contradictions: Array<{ description: string; fragmentIds: string[] }>
  fragmentChangeProposals: LibrarianFragmentChangeProposal[]
  timelineEvents: Array<{ event: string; position: 'before' | 'during' | 'after' }>
  directions: Array<{ title: string; description: string; instruction: string }>
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
    contradictions: [],
    fragmentChangeProposals: [],
    timelineEvents: [],
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
]).catch(undefined as unknown as string)

const coercedStringArray = z.array(coercedStringItem).max(200).default([])
  .transform((arr) => arr.filter((item): item is string => typeof item === 'string' && item.length > 0))

export const reportAnalysisInputSchema = z.object({
  summary: z.string().max(2400).default('').describe('A concise summary of what happened in the new prose fragment — a paragraph or two'),
  events: coercedStringArray
    .describe('Bullet-like event statements from the prose fragment — the few that matter, at most 8 are kept'),
  stateChanges: coercedStringArray
    .describe('What changed in goals, relationships, world state, or character condition — at most 8 are kept'),
  openThreads: coercedStringArray
    .describe('Unresolved questions or threads introduced/advanced by this prose — at most 8 are kept'),
  mentions: z.array(mentionInputSchema).max(150).default([])
    .describe('Distinct mentions of listed fragments in the new prose — at most one entry per fragment/text pair; a single mention highlights every occurrence of that text. Use exact prose text; never a bare pronoun.'),
  contradictions: z.array(z.object({
    description: z.string().describe('What the contradiction is'),
    fragmentIds: z.array(z.string()).describe('IDs of the fragments involved'),
  })).max(32).default([]),
  timelineEvents: z.array(z.object({
    event: z.string().describe('Description of the significant event'),
    position: z.union([z.literal('before'), z.literal('during'), z.literal('after')])
      .describe('"before" for flashback, "during" for concurrent, "after" for sequential'),
  })).max(32).default([]),
})

type AnalysisProposalSkipped = {
  operationId: string
  action: FragmentChangeOperation['action']
  target?: OperationValidation['target']
  reason: string
  errors?: string[]
}

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
    operations: queued,
    validation: params.validation.filter((result) => queuedIds.has(result.operationId)),
  })
  return { queued, alreadyQueued }
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
    customFragmentTypes?: Array<{ type: string; name: string }>;
  },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {
    reportAnalysis: tool({
      description: 'Report the prose analysis in one batch: summary, structured signals, mentions, contradictions, and timeline events. Call once with everything you found.',
      inputSchema: reportAnalysisInputSchema,
      execute: async ({
        summary = '',
        events = [],
        stateChanges = [],
        openThreads = [],
        mentions = [],
        contradictions = [],
        timelineEvents = [],
      }) => {
        // An empty report is not an error — schema-level rejection makes small
        // models loop on resubmitting. Acknowledge it and nudge instead.
        const signalCount =
          Number(summary.trim().length > 0) +
          events.length +
          stateChanges.length +
          openThreads.length +
          mentions.length +
          contradictions.length +
          timelineEvents.length
        if (signalCount === 0) {
          return {
            ok: true,
            note: 'Empty report: nothing was recorded. Call again with at least a summary if the prose contains anything noteworthy.',
          }
        }

        if (opts) {
          const uniqueIds = [...new Set<string>([
            ...mentions.map(m => m.fragmentId),
            ...contradictions.flatMap(c => c.fragmentIds),
          ].filter((id): id is string => typeof id === 'string'))]

          const checks = await Promise.all(
            uniqueIds.map(async (fid) => ({
              fid,
              exists: Boolean(await getFragment(opts.dataDir, opts.storyId, fid)),
            })),
          )
          const invalidIds = checks.filter((check) => !check.exists).map((check) => check.fid)
          if (invalidIds.length > 0) {
            throw new Error(unknownFragmentIdsMessage(invalidIds))
          }
        }

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
        const skippedMentions: Array<{ fragmentId: string; text: string }> = []
        let anchoredMentions = mentions
        if (opts?.proseFragmentId) {
          const prose = await getFragment(opts.dataDir, opts.storyId, opts.proseFragmentId)
          const proseLower = prose?.content.toLowerCase()
          if (proseLower) {
            anchoredMentions = []
            for (const m of mentions) {
              const anchored = anchorMentionText(m.text, proseLower)
              if (anchored == null) {
                skippedMentions.push({ fragmentId: m.fragmentId, text: m.text })
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
        // Persist annotations now so the prose highlights appear as soon as
        // mentions resolve, not at the end of the run.
        if (opts?.proseFragmentId && collector.mentions.length > 0) {
          await persistMentionAnnotations(opts.dataDir, opts.storyId, opts.proseFragmentId, collector.mentions)
        }
        collector.contradictions.push(...contradictions.slice(0, Math.max(0, 12 - collector.contradictions.length)))
        collector.timelineEvents.push(...timelineEvents.slice(0, Math.max(0, 12 - collector.timelineEvents.length)))
        return {
          ok: true,
          mentionCount: collector.mentions.length,
          contradictionCount: collector.contradictions.length,
          timelineEventCount: collector.timelineEvents.length,
          ...(skippedMentions.length > 0 ? {
            skippedMentions,
            skippedMentionNote: 'These texts do not appear verbatim in the prose, so they cannot be highlighted. Report the exact wording the prose uses.',
          } : {}),
        }
      },
    }),
    ...(opts ? createFragmentTools(opts.dataDir, opts.storyId, { readOnly: true }) : {}),
  }

  if (!opts?.disableSuggestions) {
    const customTypes = opts?.customFragmentTypes ?? []
    const allowedTypes = ['character', 'knowledge', ...customTypes.map(t => t.type)]

    tools.proposeFragmentChanges = tool({
      description: `Propose memory-fragment changes from the new prose in \`operations\`. ${OPERATION_GUIDANCE} Does not apply changes.`,
      inputSchema: proposeFragmentChangesSchema,
      execute: async ({ title, rationale, operations }) => {
        const skipped: AnalysisProposalSkipped[] = []
        const executableOperations = opts
          ? operations
          : operations.filter((operation) => operation.action === 'create_fragment')

        if (!opts) {
          for (const operation of operations) {
            if (operation.action === 'create_fragment') continue
            skipped.push({
              operationId: operation.operationId ?? '',
              action: operation.action,
              reason: 'Fragment edit proposals are not available without story storage context.',
            })
          }
        }

        const validation = await validateOperations(opts?.dataDir ?? '', opts?.storyId ?? '', executableOperations, {
          allowedCreateTypes: allowedTypes,
          createTypeScopeDescription: 'librarian analysis proposals',
        })
        for (const result of validation.results) {
          if (result.status !== 'valid') skipped.push(skippedOperation(result))
        }

        const validOperationIds = new Set(
          validation.results
            .filter((result) => result.status === 'valid')
            .map((result) => result.operationId),
        )
        const queuedOperations = validation.operations.filter((operation) =>
          validOperationIds.has(operation.operationId ?? '')
        )
        const queuedValidation = validation.results.filter((result) =>
          validOperationIds.has(result.operationId)
        )

        // A duplicate is a success from the model's perspective (the change is
        // already queued), so it does not count against `ok` or `invalid` — it
        // only earns an acknowledging note so the model doesn't resubmit. A
        // retried batch typically resubmits already-queued operations alongside
        // the fixed one; only the genuinely new operations queue.
        let queuedResult: ReturnType<typeof queueFragmentChangeProposal> = { queued: [], alreadyQueued: [] }
        if (queuedOperations.length > 0) {
          queuedResult = queueFragmentChangeProposal({
            collector,
            title,
            rationale,
            operations: queuedOperations,
            validation: queuedValidation,
          })
        }
        const duplicate = queuedOperations.length > 0 && queuedResult.queued.length === 0

        return {
          ok: skipped.length === 0,
          proposalCount: collector.fragmentChangeProposals.length,
          queuedOperationCount: queuedResult.queued.length,
          invalid: skipped.length,
          ...(duplicate ? { duplicate: true, note: 'An identical fragment change proposal was already queued; not queued again.' } : {}),
          ...(!duplicate && queuedResult.alreadyQueued.length > 0 ? {
            alreadyQueuedOperationIds: queuedResult.alreadyQueued.map((operation) => operation.operationId ?? ''),
            note: 'Some operations were already queued by an earlier proposal and were not queued again.',
          } : {}),
          ...operationEchoFields(validation.results),
          skipped,
        }
      },
    })
  }

  if (!opts?.disableDirections) {
    tools.proposeDirections = tool({
      description: 'Suggest 3-5 possible directions the story could go next.',
      inputSchema: z.object({
        directions: z.array(z.object({
          title: z.string().describe('Short title for the direction (3-6 words)'),
          description: z.string().describe('One sentence describing what would happen'),
          instruction: z.string().describe('Instruction for the writer agent to follow this direction'),
        })).min(3).max(5),
      }),
      execute: async ({ directions }) => {
        collector.directions = directions
        return { ok: true }
      },
    })
  }

  return tools
}

/**
 * The analyze toolset. Single source for the runtime handler and the agent's
 * available-tools list, so the toggle path and the model stay in sync.
 *
 * The characters in the recent prose are preloaded into context in full, and
 * knowledge sits in context in full, so the pass proposes changes against the
 * sheets it already holds. readFragments is the fallback for reading any other
 * fragment before proposing an edit.
 */
export function createLibrarianAnalyzeTools(
  collector: AnalysisCollector,
  opts: { 
    dataDir: string; 
    storyId: string; 
    proseFragmentId?: string; 
    disableDirections?: boolean; 
    disableSuggestions?: boolean;
    customFragmentTypes?: Array<{ type: string; name: string }>;
  },
): ToolSet {
  return createAnalysisTools(collector, opts)
}

/** Tool names the analyze agent exposes — drives the toggle list with no drift. */
export function listLibrarianAnalyzeToolNames(): string[] {
  return Object.keys(createLibrarianAnalyzeTools(createEmptyCollector(), { dataDir: '', storyId: '' }))
}
