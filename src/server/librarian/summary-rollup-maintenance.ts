import { beginAgentRun, type AgentRunHandle } from '../agents/agent-run'
import { listActiveAgents } from '../agents/active-registry'
import { getScopedBranchId, isBranchDeleting, withBranch } from '../fragments/branches'
import { createLogger } from '../logging'
import {
  deriveNextSummaryRollupNode,
  type SummaryRollupNode,
} from './summary-rollups'

/**
 * Low-priority orchestration for recursive story memory. Projection only marks
 * demand; this module owns wake-ups, foreground yielding, retries, activity
 * reporting, and timeline-safe cancellation. Roll-up derivation itself remains
 * a stateless one-node operation in summary-rollups.ts.
 */

interface MaintenanceRequest {
  dataDir: string
  storyId: string
  branchId: string
}

interface MaintenanceFailure {
  at: number
  count: number
}

interface MaintenanceJob extends MaintenanceRequest {
  dirty: boolean
  cancelled: boolean
  failure?: MaintenanceFailure
  timer?: ReturnType<typeof setTimeout>
  promise?: Promise<void>
  controller?: AbortController
}

const logger = createLogger('summary-rollup-maintenance')
const jobs = new Map<string, MaintenanceJob>()
// Activity buffers are keyed by story and agent name, so only one timeline per
// story may occupy the Memory lane at once.
const runningStories = new Set<string>()

const IDLE_RECHECK_MS = 500
// Bound one visible activity below the registry's ten-minute safety TTL. A
// remaining backlog immediately schedules another pass.
const MAX_NODES_PER_PASS = 8

function maintenanceKey(dataDir: string, storyId: string, branchId: string): string {
  return `${dataDir}\u0000${storyId}\u0000${branchId}`
}

function getJob(dataDir: string, storyId: string, branchId: string): MaintenanceJob {
  const key = maintenanceKey(dataDir, storyId, branchId)
  let job = jobs.get(key)
  if (!job) {
    job = { dataDir, storyId, branchId, dirty: false, cancelled: false }
    jobs.set(key, job)
  }
  return job
}

function forgetSettledJob(job: MaintenanceJob): void {
  if (job.dirty || job.timer || job.promise || job.controller) return
  jobs.delete(maintenanceKey(job.dataDir, job.storyId, job.branchId))
}

/** One minute, doubling to half an hour. */
function retryDelayMs(consecutiveFailures: number): number {
  return Math.min(60_000 * 2 ** (consecutiveFailures - 1), 30 * 60_000)
}

async function canRunMaintenance(storyId: string): Promise<boolean> {
  if (listActiveAgents(storyId).some((agent) => agent.agentName !== 'librarian.rollup')) return false
  // Lazy because Analyze releases maintenance, while maintenance also needs to
  // observe Analyze's short scheduler-only transitions.
  const { isLibrarianAnalysisIdle } = await import('./scheduler')
  return isLibrarianAnalysisIdle(storyId)
}

function schedule(job: MaintenanceJob, delayMs = 0): void {
  if (job.cancelled || job.timer) return
  job.timer = setTimeout(() => {
    job.timer = undefined
    const promise = runScheduled(job)
    job.promise = promise
    void promise.catch((error) => {
      logger.child({ storyId: job.storyId }).error('Summary roll-up scheduler failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }).finally(() => {
      if (job.promise === promise) job.promise = undefined
      forgetSettledJob(job)
    })
  }, delayMs)
  job.timer.unref?.()
}

async function drain(job: MaintenanceJob): Promise<void> {
  const controller = new AbortController()
  job.controller = controller
  let run: AgentRunHandle | undefined
  const nodes: SummaryRollupNode[] = []
  const seen = new Set<string>()

  try {
    await withBranch(job.dataDir, job.storyId, async () => {
      while (nodes.length < MAX_NODES_PER_PASS) {
        if (job.cancelled) return
        if (!await canRunMaintenance(job.storyId)) {
          job.dirty = true
          return
        }
        const node = await deriveNextSummaryRollupNode(job.dataDir, job.storyId, {
          abortSignal: controller.signal,
          onModelStart: () => {
            run ??= beginAgentRun(job.storyId, 'librarian.rollup', {
              reason: 'story-memory-maintenance',
            }, { branchId: job.branchId, abortController: controller })
          },
          onEvent: (event) => run?.pushEvent(event),
        })
        if (!node || seen.has(node.id)) return
        seen.add(node.id)
        nodes.push(node)
      }
      job.dirty = true
    }, job.branchId)

    run?.finish('success', {
      output: {
        nodesCreated: nodes.length,
        highestLevel: nodes.reduce((highest, node) => Math.max(highest, node.level), 0),
        coverageStart: nodes[0]?.coverageStart,
        coverageEnd: nodes.at(-1)?.coverageEnd,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    run?.finish(controller.signal.aborted ? 'aborted' : 'error', { error: message })
    throw error
  } finally {
    if (job.controller === controller) job.controller = undefined
  }
}

async function runScheduled(job: MaintenanceJob): Promise<void> {
  if (!job.dirty || job.cancelled) return
  if (isBranchDeleting(job.storyId, job.branchId)) {
    job.dirty = false
    job.failure = undefined
    return
  }
  if (job.failure) {
    const remaining = retryDelayMs(job.failure.count) - (Date.now() - job.failure.at)
    if (remaining > 0) {
      schedule(job, remaining)
      return
    }
  }
  if (runningStories.has(job.storyId) || !await canRunMaintenance(job.storyId)) {
    schedule(job, IDLE_RECHECK_MS)
    return
  }
  // Cancellation can arrive while the idle check is awaiting its lazy import.
  if (!job.dirty || job.cancelled) return

  job.dirty = false
  runningStories.add(job.storyId)
  try {
    await drain(job)
    job.failure = undefined
  } catch (error) {
    if (job.cancelled || isBranchDeleting(job.storyId, job.branchId)) return
    job.dirty = true
    const count = (job.failure?.count ?? 0) + 1
    job.failure = { at: Date.now(), count }
    logger.child({ storyId: job.storyId }).warn('Summary roll-up maintenance failed', {
      consecutiveFailures: count,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    runningStories.delete(job.storyId)
    if (job.dirty) schedule(job)
  }
}

/** Mark branch-scoped demand during projection without starting model work. */
export function markSummaryRollupNeeded(dataDir: string, storyId: string): void {
  const branchId = getScopedBranchId(storyId)
  if (branchId) getJob(dataDir, storyId, branchId).dirty = true
}

/** Release previously marked demand outside the caller's hot path. */
export function queueSummaryRollupMaintenance(dataDir: string, storyId: string, branchId?: string): void {
  const resolvedBranchId = branchId ?? getScopedBranchId(storyId)
  if (!resolvedBranchId) return
  const job = jobs.get(maintenanceKey(dataDir, storyId, resolvedBranchId))
  if (job?.dirty) schedule(job)
}

/** Proactively maintain the recursive tree after Analyze. */
export function requestSummaryRollupMaintenance(dataDir: string, storyId: string, branchId?: string): void {
  const resolvedBranchId = branchId ?? getScopedBranchId(storyId)
  if (!resolvedBranchId) return
  const job = getJob(dataDir, storyId, resolvedBranchId)
  job.dirty = true
  schedule(job)
}

/** Cancel queued or running memory work before its timeline is deleted. */
export async function cancelSummaryRollupMaintenance(
  dataDir: string,
  storyId: string,
  branchId: string,
): Promise<void> {
  const job = jobs.get(maintenanceKey(dataDir, storyId, branchId))
  if (!job) return
  job.cancelled = true
  job.dirty = false
  job.failure = undefined
  if (job.timer) {
    clearTimeout(job.timer)
    job.timer = undefined
  }
  job.controller?.abort()
  await job.promise?.catch(() => {})
  forgetSettledJob(job)
}
