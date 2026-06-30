import type { Fragment } from '../fragments/schema'
import { createLogger } from '../logging'
import { getActiveBranchId, withBranch } from '../fragments/branches'
import { clearAnalysisIndexEntry } from './storage'

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

export type LibrarianRunStatus = 'idle' | 'scheduled' | 'running' | 'error'

export interface LibrarianRuntimeStatus {
  runStatus: LibrarianRunStatus
  pendingFragmentId: string | null
  runningFragmentId: string | null
  lastError: string | null
  updatedAt: string
}

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
  const branchId = await getActiveBranchId(dataDir, storyId)

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
    await withBranch(dataDir, storyId, () => invokeAgent({
      dataDir,
      storyId,
      agentName: 'librarian.analyze',
      input: { fragmentId: fragment.id },
    }), branchId)
    requestLogger.info('Librarian analysis completed', { fragmentId: fragment.id, durationMs: Date.now() - startTime })
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    requestLogger.error('Librarian analysis failed', { fragmentId: fragment.id, error: lastError })
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

/**
 * Schedule librarian re-analysis after a prose fragment changes, from any code path
 * (HTTP route or librarian tool). No-ops for non-prose or immaterial changes; marks the
 * analysis stale for the UI indicator and schedules the run.
 */
export function reanalyzeAfterProseChange(
  dataDir: string,
  storyId: string,
  before: Fragment,
  after: Fragment,
): void {
  if (after.type !== 'prose' || !hasMaterialProseChange(before, after)) return
  clearAnalysisIndexEntry(dataDir, storyId, after.id).catch(() => {})
  Promise.resolve(triggerLibrarian(dataDir, storyId, after)).catch((err) => {
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
