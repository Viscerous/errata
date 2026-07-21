/** In-memory registry tracking currently running agents for real-time UI feedback. */

import {
  createActivityBuffer,
  finishActivityBuffer,
  clearActivityBuffer,
  type ActivityBuffer,
} from './activity-stream'

export interface ActiveAgent {
  id: string
  runId?: string
  storyId: string
  branchId?: string
  agentName: string
  startedAt: string
  status: 'running' | 'cancelling'
}

export interface ActiveAgentOptions {
  runId?: string
  branchId?: string
  cancel?: () => void
}

interface ActiveEntry {
  agent: ActiveAgent
  /** The live-trace buffer, born and retired with the active marker. */
  buffer: ActivityBuffer
  timer: ReturnType<typeof setTimeout>
  cancel?: () => void
  settled: Promise<void>
  resolveSettled: () => void
}

const entries = new Map<string, ActiveEntry>()
const pendingCancellations = new Map<string, ReturnType<typeof setTimeout>>()
let counter = 0

const MAX_TTL_MS = 10 * 60 * 1000 // 10 minutes safety net

function cancellationKey(storyId: string, runId: string): string {
  return `${storyId}:${runId}`
}

export function registerActiveAgent(storyId: string, agentName: string, options: ActiveAgentOptions = {}): string {
  const id = `act-${++counter}-${Date.now().toString(36)}`
  const agent: ActiveAgent = {
    id,
    ...(options.runId ? { runId: options.runId } : {}),
    storyId,
    ...(options.branchId ? { branchId: options.branchId } : {}),
    agentName,
    startedAt: new Date().toISOString(),
    status: 'running',
  }
  // The live-trace buffer is created alongside the active marker, so it exists
  // the moment an agent appears active — no window for a subscriber to 404.
  const buffer = createActivityBuffer(storyId, agentName)
  const timer = setTimeout(() => finalize(id), MAX_TTL_MS) // auto-expire on missed cleanup
  let resolveSettled!: () => void
  const settled = new Promise<void>(resolve => { resolveSettled = resolve })
  entries.set(id, { agent, buffer, timer, cancel: options.cancel, settled, resolveSettled })

  if (options.runId) {
    const key = cancellationKey(storyId, options.runId)
    const pending = pendingCancellations.get(key)
    if (pending) {
      clearTimeout(pending)
      pendingCancellations.delete(key)
      agent.status = 'cancelling'
      options.cancel?.()
    }
  }
  return id
}

export function unregisterActiveAgent(id: string): void {
  finalize(id)
}

function finalize(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  // Retire this run's buffer specifically (not a lookup by name), so an
  // overlapping run of the same agent can't be torn down by mistake.
  finishActivityBuffer(entry.buffer)
  clearActivityBuffer(entry.buffer)
  clearTimeout(entry.timer)
  entries.delete(id)
  entry.resolveSettled()
}

export function getActiveAgentBuffer(id: string): ActivityBuffer | undefined {
  return entries.get(id)?.buffer
}

/**
 * Explicit cancellation by run ID. A short-lived pending marker closes the
 * race where Stop arrives while the generation request is still preparing.
 */
export function requestAgentCancellation(storyId: string, runId: string): boolean {
  const matches = [...entries.values()].filter(entry => entry.agent.storyId === storyId && entry.agent.runId === runId)
  if (matches.length === 0) {
    const key = cancellationKey(storyId, runId)
    const previous = pendingCancellations.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => pendingCancellations.delete(key), 30_000)
    timer.unref?.()
    pendingCancellations.set(key, timer)
    return false
  }

  for (const entry of matches) {
    entry.agent.status = 'cancelling'
    entry.cancel?.()
  }
  return true
}

/** Cancel and await every active agent pinned to a timeline before deletion. */
export async function cancelActiveAgentsForBranch(storyId: string, branchId: string): Promise<number> {
  const matches = [...entries.values()].filter(entry => (
    entry.agent.storyId === storyId && entry.agent.branchId === branchId
  ))
  for (const entry of matches) {
    entry.agent.status = 'cancelling'
    entry.cancel?.()
  }
  if (matches.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for timeline agents to stop')), 10_000)
    })
    try {
      await Promise.race([Promise.all(matches.map(entry => entry.settled)), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return matches.length
}

export function listActiveAgents(storyId?: string): ActiveAgent[] {
  const all = [...entries.values()].map(e => e.agent)
  return storyId ? all.filter(a => a.storyId === storyId) : all
}
