import { resolveAgentRuntime } from '../llm/client'
import {
  getStory,
  getFragment,
  updateFragment,
} from '../fragments/storage'
import { withBranch } from '../fragments/branches'
import { withKeyLock } from '../async-lock'
import {
  saveAnalysis,
  getState,
  saveState,
  type LibrarianAnalysis,
} from './storage'
import { analysisSourceRevision } from './continuity-source'
import { SUMMARY_CONTRACT_VERSION } from './summary-contract'
import {
  applyFragmentChangeProposal,
  markFragmentChangeProposalApplied,
  markFragmentChangeProposalStale,
  ProposalApplyError,
  ProposalNeedsAuthorError,
  ProposalValidationError,
} from './suggestions'
import { createLogger } from '../logging'
import { timelineEventsFor, toMentionAnnotations } from './analysis-tools'
import { appendToStoredTrace, getActivityBuffer, pushActivityEvent, type ActivityStreamEvent } from '../agents/activity-stream'
import { runLibrarianPipeline } from './pipeline'

const logger = createLogger('librarian-agent')

function updateRecentMentionsForFragment(
  current: Record<string, string[]>,
  sourceFragmentId: string,
  mentionedFragmentIds: string[],
): Record<string, string[]> {
  const next: Record<string, string[]> = {}

  for (const [mentionedId, sourceIds] of Object.entries(current)) {
    const remainingSourceIds = [...new Set(sourceIds)].filter((id) => id !== sourceFragmentId)
    if (remainingSourceIds.length > 0) {
      next[mentionedId] = remainingSourceIds
    }
  }

  for (const mentionedId of mentionedFragmentIds) {
    const sourceIds = next[mentionedId] ?? []
    if (!sourceIds.includes(sourceFragmentId)) {
      next[mentionedId] = [...sourceIds, sourceFragmentId]
    }
  }

  return next
}

/** How much story timeline the state file carries; the panel reads the tail. */
const MAX_STATE_TIMELINE_EVENTS = 200

/**
 * A fragment owns its stretch of the timeline, so re-analyzing one replaces its
 * entries where they already sit rather than appending a second copy at the end.
 */
function updateTimelineForFragment(
  current: Array<{ event: string; fragmentId: string }>,
  fragmentId: string,
  events: Array<{ event: string }>,
): Array<{ event: string; fragmentId: string }> {
  const others = current.filter((entry) => entry.fragmentId !== fragmentId)
  // Everything before the fragment's first entry is another fragment's, so that
  // index is already the insertion point in the filtered list.
  const first = current.findIndex((entry) => entry.fragmentId === fragmentId)
  const insertAt = first === -1 ? others.length : first
  return [
    ...others.slice(0, insertAt),
    ...events.map((event) => ({ event: event.event, fragmentId })),
    ...others.slice(insertAt),
  ].slice(-MAX_STATE_TIMELINE_EVENTS)
}

export async function runLibrarian(
  dataDir: string,
  storyId: string,
  fragmentId: string,
  options: { abortSignal?: AbortSignal; idleTimeoutMs?: number } = {},
): Promise<LibrarianAnalysis> {
  // Serialize analysis runs per story. Concurrent runs would clobber state.json,
  // the live SSE buffer, and the analysis index through unguarded read-modify-write.
  return withKeyLock(`librarian:${storyId}`, () =>
    withBranch(dataDir, storyId, () => runLibrarianInner(dataDir, storyId, fragmentId, options)),
  )
}

async function runLibrarianInner(
  dataDir: string,
  storyId: string,
  fragmentId: string,
  options: { abortSignal?: AbortSignal; idleTimeoutMs?: number },
): Promise<LibrarianAnalysis> {
  const requestLogger = logger.child({ storyId })
  requestLogger.info('Starting librarian analysis...', { fragmentId })

  // Load story and fragment data
  const story = await getStory(dataDir, storyId)
  if (!story) {
    requestLogger.error('Story not found', { storyId })
    throw new Error(`Story ${storyId} not found`)
  }

  const fragment = await getFragment(dataDir, storyId, fragmentId)
  if (!fragment) {
    requestLogger.error('Fragment not found', { fragmentId })
    throw new Error(`Fragment ${fragmentId} not found`)
  }

  // Load current librarian state for context
  const state = await getState(dataDir, storyId)

  const runtime = await resolveAgentRuntime(dataDir, storyId, 'librarian.analyze', story)
  const disableSuggestions = story.settings?.disableLibrarianSuggestions === true

  // The active registry owns the live buffer; collect the trace locally for the
  // persisted analysis and mirror it onto that buffer when one exists.
  const liveBuffer = getActivityBuffer(storyId, 'librarian.analyze')
  const traceEvents: ActivityStreamEvent[] = []
  const emit = (event: ActivityStreamEvent) => {
    appendToStoredTrace(traceEvents, event)
    if (liveBuffer) pushActivityEvent(liveBuffer, event)
  }

  const pipeline = await runLibrarianPipeline({
    dataDir,
    storyId,
    story,
    fragment,
    runtime,
    requestLogger,
    emit,
    abortSignal: options.abortSignal,
    idleTimeoutMs: options.idleTimeoutMs,
  })
  const {
    collector,
    mentionedFragmentIds,
    candidateFragmentIds,
    candidateFragments,
    passes,
  } = pipeline

  // Build the analysis
  const analysisId = `la-${Date.now().toString(36)}`
  const analysis: LibrarianAnalysis = {
    id: analysisId,
    createdAt: new Date().toISOString(),
    fragmentId,
    sourceRevision: analysisSourceRevision(fragment),
    summaryUpdate: collector.summaryUpdate,
    summaryContractVersion: SUMMARY_CONTRACT_VERSION,
    continuityProjection: collector.continuityProjection,
    mentions: collector.mentions,
    candidateFragmentIds,
    candidateFragments,
    contradictions: collector.contradictions,
    timelineEvents: timelineEventsFor(collector.events, collector.continuityProjection.temporalFrame),
    fragmentChangeProposals: collector.fragmentChangeProposals.map((proposal) => ({
      ...proposal,
      sourceFragmentId: fragmentId,
    })),
    directions: collector.directions,
    analyzeLanes: pipeline.analyzeLanes,
    passes,
    trace: traceEvents as LibrarianAnalysis['trace'],
  }

  const autoApplySuggestions = story.settings?.autoApplyLibrarianSuggestions === true && !disableSuggestions
  if (autoApplySuggestions && analysis.fragmentChangeProposals.length > 0) {
    requestLogger.info('Auto-applying librarian suggestions', {
      proposalCount: analysis.fragmentChangeProposals.length,
    })
    for (let index = 0; index < analysis.fragmentChangeProposals.length; index += 1) {
      const proposal = analysis.fragmentChangeProposals[index]
      if (proposal.autoApplySafe !== true) {
        requestLogger.warn('Leaving proposal pending because it did not pass the unattended-apply contract', {
          proposalIndex: index,
          proposalKind: proposal.proposalKind ?? 'legacy',
        })
        continue
      }
      try {
        const result = await applyFragmentChangeProposal({
          dataDir,
          storyId,
          analysis,
          proposalIndex: index,
          reason: 'auto-apply',
        })
        markFragmentChangeProposalApplied({
          analysis,
          proposalIndex: index,
          result,
          autoApplied: true,
        })
      } catch (error) {
        if (error instanceof ProposalApplyError) {
          // Record the partial application so it stays visible and revertible.
          markFragmentChangeProposalApplied({
            analysis,
            proposalIndex: index,
            result: error.partial,
            autoApplied: true,
          })
        } else if (error instanceof ProposalNeedsAuthorError) {
          // Sound, but not something to write unattended. Manual accept skips
          // the unattended gate, so leave it pending for the author instead of
          // dismissing the correction on their behalf.
          requestLogger.info('Proposal left pending for author review', {
            proposalIndex: index,
            reason: error.message,
          })
        } else if (error instanceof ProposalValidationError) {
          // Nothing was written; an earlier proposal in this run typically
          // already landed the same change. Mark stale so the user is not
          // shown a pending proposal whose accept can only fail.
          markFragmentChangeProposalStale({
            analysis,
            proposalIndex: index,
            reason: error.message,
            validation: error.results,
          })
        }
        requestLogger.error('Failed to auto-apply fragment change proposal', {
          proposalIndex: index,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  // Mentions remain source annotations. Summary history lives only in the
  // source-linked analysis artifact; duplicating it into mutable prose metadata
  // creates a second, staleable authority.
  const hasMentions = collector.mentions.length > 0

  if (hasMentions) {
    const proseFragment = await getFragment(dataDir, storyId, fragmentId)
    if (proseFragment) {
      const updatedMeta = { ...proseFragment.meta }
      updatedMeta.annotations = toMentionAnnotations(collector.mentions)

      await updateFragment(dataDir, storyId, {
        ...proseFragment,
        meta: updatedMeta,
      })
      requestLogger.debug('Saved librarian metadata to prose fragment', {
        fragmentId,
        annotationCount: collector.mentions.length,
      })
    }
  }

  // Update librarian state
  requestLogger.debug('Updating librarian state...')
  const updatedMentions = updateRecentMentionsForFragment(
    state.recentMentions,
    fragmentId,
    mentionedFragmentIds,
  )

  const updatedState = {
    lastAnalyzedFragmentId: fragmentId,
    recentMentions: updatedMentions,
    timeline: updateTimelineForFragment(state.timeline, fragmentId, analysis.timelineEvents),
  }

  // The source-linked analysis is the level-0 summary contribution. Context
  // derives memory from these records; no append-log artifact is maintained.
  await saveAnalysis(dataDir, storyId, analysis)
  await saveState(dataDir, storyId, updatedState)
  requestLogger.info('Analysis saved', { analysisId })

  if (pipeline.completionError) {
    throw new Error(`Librarian analysis ${analysisId} was saved but did not fully complete: ${pipeline.completionError}`)
  }

  return analysis
}
