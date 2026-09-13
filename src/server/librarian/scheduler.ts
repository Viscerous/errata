import type { Fragment } from '@/contracts/story'
import { createLogger } from '../logging'
import { getActiveBranchId, getScopedBranchId, isBranchDeleting, withBranch } from '../fragments/branches'
import { getStory, getFragment } from '../fragments/storage'
import { revertAllAppliedProposalsForFragment } from './suggestions'
import { getAgentBlockConfig } from '../agents/agent-block-storage'
import { listActiveAgents, requestAgentCancellation } from '../agents/active-registry'
import { clearAnalysisIndexEntry, clearFragmentFromState, setAnalysisFailure } from './storage'
import type { LibrarianRuntimeStatus } from '@/contracts/librarian'

export type {
  LibrarianRunStatus,
  LibrarianRuntimeStatus,
} from '@/contracts/librarian'

interface QueuedRun {
  dataDir: string
  fragment: Fragment
  branchId: string
}

interface SchedulerState {
  running: boolean
  /** Latest trigger that arrived while a run was in flight or held; supersedes earlier ones. */
  queued: QueuedRun | null
}

const scheduler = new Map<string, SchedulerState>()
const runtimeStatus = new Map<string, LibrarianRuntimeStatus>()
/** Per-story count of active agent runs that defer analysis until they finish. */
const holds = new Map<string, number>()
const logger = createLogger('librarian')

function makeDefaultStatus(): LibrarianRuntimeStatus {
  return {
    runStatus: 'idle',
    pendingFragmentId: null,
    runningFragmentId: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  }
}

function setRuntimeStatus(storyId: string, patch: Partial<LibrarianRuntimeStatus>): void {
  const base = runtimeStatus.get(storyId) ?? makeDefaultStatus()
  runtimeStatus.set(storyId, {
    ...base,
    ...patch,
    updatedAt: new Date().toISOString(),
  })
}

/**
 * Schedule a librarian analysis for a story. Analysis is one of the longest steps, so a
 * run starts immediately when the story is idle. Triggers arriving while a run is in
 * flight or held are coalesced to the latest fragment and run once the story settles.
 */
interface ActiveRun {
  promise: Promise<void>
  resolve: () => void
}

const activeRuns = new Set<ActiveRun>()

function trackRun(promise: Promise<void>): void {
  let resolveExternal!: () => void
  const wrapper = new Promise<void>((resolve) => {
    resolveExternal = resolve
    promise.then(() => resolve(), () => resolve())
  })

  const runObj = { promise: wrapper, resolve: resolveExternal }
  activeRuns.add(runObj)
  wrapper.finally(() => {
    activeRuns.delete(runObj)
  })
}

/** Wait for all currently executing analyses to finish (useful for tests to avoid race conditions). */
export async function awaitPending(): Promise<void> {
  while (activeRuns.size > 0) {
    await Promise.all(Array.from(activeRuns).map((r) => r.promise))
  }
}

export async function triggerLibrarian(
  dataDir: string,
  storyId: string,
  fragment: Fragment,
): Promise<void> {
  const requestLogger = logger.child({ storyId })

  // Capture the active branch at trigger time, before any in-flight run can switch it.
  const branchId = getScopedBranchId(storyId) ?? await getActiveBranchId(dataDir, storyId)
  if (isBranchDeleting(storyId, branchId)) {
    requestLogger.debug('Ignoring analysis for a timeline being deleted', { fragmentId: fragment.id, branchId })
    return
  }

  const state = scheduler.get(storyId) ?? { running: false, queued: null }
  scheduler.set(storyId, state)

  const held = (holds.get(storyId) ?? 0) > 0
  if (state.running || held) {
    requestLogger.debug('Deferring re-analysis', { fragmentId: fragment.id, branchId, reason: held ? 'held' : 'running' })
    state.queued = { dataDir, fragment, branchId }
    setRuntimeStatus(storyId, {
      runStatus: state.running ? 'running' : 'scheduled',
      pendingFragmentId: fragment.id,
    })
    return
  }

  state.running = true
  trackRun(runAnalysis(dataDir, storyId, fragment, branchId))
}

async function runAnalysis(
  dataDir: string,
  storyId: string,
  fragment: Fragment,
  branchId: string,
): Promise<void> {
  const requestLogger = logger.child({ storyId })
  setRuntimeStatus(storyId, {
    runStatus: 'running',
    pendingFragmentId: null,
    runningFragmentId: fragment.id,
    lastError: null,
  })

  let lastError: string | null = null
  try {
    requestLogger.info('Starting librarian analysis...', { fragmentId: fragment.id, branchId })
    const startTime = Date.now()
    // Imported lazily: the agents runtime cycles back through the llm tools, and
    // it's only needed here at run time.
    const { invokeAgent } = await import('../agents')
    await withBranch(dataDir, storyId, async () => {
      await invokeAgent({
        dataDir,
        storyId,
        agentName: 'librarian.analyze',
        input: { fragmentId: fragment.id },
      })
      await setAnalysisFailure(dataDir, storyId, fragment.id, null).catch((err) => {
        requestLogger.error('Could not clear resolved analysis warning', { error: err instanceof Error ? err.message : String(err) })
      })
    }, branchId)
    requestLogger.info('Librarian analysis completed', { fragmentId: fragment.id, durationMs: Date.now() - startTime })
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    requestLogger.error('Librarian analysis failed', { fragmentId: fragment.id, error: lastError })
    const currentFragment = await withBranch(dataDir, storyId, () => getFragment(dataDir, storyId, fragment.id), branchId).catch(() => null)
    if (!currentFragment || currentFragment.archived) {
      requestLogger.info('Fragment was archived or removed; skipping recording failure', { fragmentId: fragment.id })
    } else {
      await withBranch(dataDir, storyId, () => setAnalysisFailure(dataDir, storyId, fragment.id, lastError), branchId).catch((writeError) => {
        requestLogger.error('Could not record analysis warning', { error: writeError instanceof Error ? writeError.message : String(writeError) })
      })
    }
  }

  // Drain the latest queued trigger (no idle flicker between coalesced runs, so the UI's
  // running → idle/error edge fires once). A held trigger waits for its release to flush.
  const state = scheduler.get(storyId)
  const held = (holds.get(storyId) ?? 0) > 0
  if (state?.queued && !held) {
    const next = state.queued
    state.queued = null
    trackRun(runAnalysis(next.dataDir, storyId, next.fragment, next.branchId))
    return
  }
  if (state) state.running = false
  setRuntimeStatus(storyId, {
    runStatus: lastError ? 'error' : state?.queued ? 'scheduled' : 'idle',
    pendingFragmentId: state?.queued?.fragment.id ?? null,
    runningFragmentId: null,
    lastError,
  })
  // Maintain story memory only after the foreground Analyze queue is fully
  // idle. This is a separate visible activity and never extends Analyze's
  // model-facing contract.
  const { requestSummaryRollupMaintenance } = await import('./summary-rollup-maintenance')
  requestSummaryRollupMaintenance(dataDir, storyId, branchId)
}

/**
 * Suspend librarian analysis for a story while an agent run edits it, returning a release
 * function. Otherwise a run editing prose across several tool steps kicks off (and then
 * supersedes) a full analysis per step; deferring to run end collapses that to a single
 * analysis of the final state. Refcounted for concurrent runs.
 */
export function holdLibrarianAnalysis(storyId: string): () => void {
  holds.set(storyId, (holds.get(storyId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (holds.get(storyId) ?? 1) - 1
    if (remaining > 0) {
      holds.set(storyId, remaining)
      return
    }
    holds.delete(storyId)
    const state = scheduler.get(storyId)
    if (state && !state.running && state.queued) {
      const next = state.queued
      state.queued = null
      state.running = true
      trackRun(runAnalysis(next.dataDir, storyId, next.fragment, next.branchId))
    }
  }
}

function hasMaterialProseChange(before: Fragment, after: Fragment): boolean {
  return before.name !== after.name
    || before.description !== after.description
    || before.content !== after.content
}

export async function isAutoAnalysisDisabled(dataDir: string, storyId: string): Promise<boolean> {
  const [story, librarianConfig] = await Promise.all([
    getStory(dataDir, storyId),
    getAgentBlockConfig(dataDir, storyId, 'librarian.analyze'),
  ])
  return story?.settings.disableLibrarianAutoAnalysis === true
    || librarianConfig.disableAutoAnalysis === true
}

/** Retire the analysis-derived effects of prose that changed or left the active chain. */
export async function invalidateLibrarianForFragment(
  dataDir: string,
  storyId: string,
  fragmentId: string,
): Promise<void> {
  let revertError: unknown
  try {
    await revertAllAppliedProposalsForFragment(dataDir, storyId, fragmentId)
  } catch (error) {
    revertError = error
  }
  // Even a conflicting revert must not leave the old report marked current.
  const cleanup = await Promise.allSettled([
    clearAnalysisIndexEntry(dataDir, storyId, fragmentId),
    clearFragmentFromState(dataDir, storyId, fragmentId),
  ])
  const errors = [
    ...(revertError ? [revertError] : []),
    ...cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason),
  ]
  if (errors.length > 0) {
    throw new Error(`Could not fully invalidate analysis for ${fragmentId}: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ')}`)
  }
}

/**
 * Schedule librarian re-analysis after a prose fragment changes, from any code path
 * (HTTP route or librarian tool). No-ops for non-prose or immaterial changes; marks the
 * analysis stale for the UI indicator and schedules the run.
 */
export async function reanalyzeAfterProseChange(
  dataDir: string,
  storyId: string,
  before: Fragment,
  after: Fragment,
): Promise<void> {
  if (after.type !== 'prose' || !hasMaterialProseChange(before, after)) return
  try {
    await invalidateLibrarianForFragment(dataDir, storyId, after.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.child({ storyId }).error('Could not fully invalidate analysis after prose change', {
      fragmentId: after.id,
      error: message,
    })
    await setAnalysisFailure(dataDir, storyId, after.id, message)
    return
  }
  if (await isAutoAnalysisDisabled(dataDir, storyId)) return
  await triggerLibrarian(dataDir, storyId, after).catch((err) => {
    logger.child({ storyId }).error('triggerLibrarian failed after prose change', {
      fragmentId: after.id,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/** Reset all scheduler bookkeeping (useful for tests). Does not abort an in-flight run. */
export function clearPending(): void {
  for (const [storyId, state] of scheduler.entries()) {
    state.queued = null
    state.running = false
    setRuntimeStatus(storyId, {
      runStatus: 'idle',
      pendingFragmentId: null,
      runningFragmentId: null,
    })
  }
  scheduler.clear()
  holds.clear()

  for (const run of activeRuns) {
    run.resolve()
  }
  activeRuns.clear()
}

/** Remove deferred work for a specific fragment before it is archived or replaced. */
export function cancelPendingLibrarianForFragment(storyId: string, fragmentId: string): void {
  const state = scheduler.get(storyId)
  if (!state?.queued || state.queued.fragment.id !== fragmentId) return
  state.queued = null
  setRuntimeStatus(storyId, {
    pendingFragmentId: null,
    runStatus: state.running ? 'running' : 'idle',
  })
}

/** Ask an active analysis of this passage to stop before its lifecycle changes. */
export function cancelLibrarianForFragment(storyId: string, fragmentId: string): void {
  cancelPendingLibrarianForFragment(storyId, fragmentId)
  if (runtimeStatus.get(storyId)?.runningFragmentId !== fragmentId) return
  for (const agent of listActiveAgents(storyId)) {
    if (agent.agentName === 'librarian.analyze' && agent.runId) {
      requestAgentCancellation(storyId, agent.runId)
    }
  }
}

/** Remove deferred work for a timeline before its active agents are cancelled. */
export function cancelPendingLibrarianForBranch(storyId: string, branchId: string): void {
  const state = scheduler.get(storyId)
  if (!state?.queued || state.queued.branchId !== branchId) return
  state.queued = null
  setRuntimeStatus(storyId, {
    pendingFragmentId: null,
    runStatus: state.running ? 'running' : 'idle',
  })
}

/** Number of stories with a running or queued analysis (useful for tests). */
export function getPendingCount(): number {
  let count = 0
  for (const state of scheduler.values()) {
    if (state.running || state.queued) count++
  }
  return count
}

export function getLibrarianRuntimeStatus(storyId: string): LibrarianRuntimeStatus {
  return runtimeStatus.get(storyId) ?? makeDefaultStatus()
}

/** Whether background memory work may proceed without competing with Analyze. */
export function isLibrarianAnalysisIdle(storyId: string): boolean {
  const state = scheduler.get(storyId)
  return !state?.running && !state?.queued && (holds.get(storyId) ?? 0) === 0
}
