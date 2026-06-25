/** In-memory registry tracking currently running agents for real-time UI feedback. */

import {
  createActivityBuffer,
  finishActivityBuffer,
  clearActivityBuffer,
  type ActivityBuffer,
} from './activity-stream'

export interface ActiveAgent {
  id: string
  storyId: string
  agentName: string
  startedAt: string
}

interface ActiveEntry {
  agent: ActiveAgent
  /** The live-trace buffer, born and retired with the active marker. */
  buffer: ActivityBuffer
  timer: ReturnType<typeof setTimeout>
}

const entries = new Map<string, ActiveEntry>()
let counter = 0

const MAX_TTL_MS = 10 * 60 * 1000 // 10 minutes safety net

export function registerActiveAgent(storyId: string, agentName: string): string {
  const id = `act-${++counter}-${Date.now().toString(36)}`
  const agent: ActiveAgent = { id, storyId, agentName, startedAt: new Date().toISOString() }
  // The live-trace buffer is created alongside the active marker, so it exists
  // the moment an agent appears active — no window for a subscriber to 404.
  const buffer = createActivityBuffer(storyId, agentName)
  const timer = setTimeout(() => finalize(id), MAX_TTL_MS) // auto-expire on missed cleanup
  entries.set(id, { agent, buffer, timer })
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
}

export function listActiveAgents(storyId?: string): ActiveAgent[] {
  const all = [...entries.values()].map(e => e.agent)
  return storyId ? all.filter(a => a.storyId === storyId) : all
}
