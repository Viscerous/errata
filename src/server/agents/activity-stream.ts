// In-memory event buffer for live agent activity streaming — one buffer per
// (story, agent), replayable from the start and followed live.

import type { AgentStreamEvent } from './stream-types'

export type ActivityStreamEvent = AgentStreamEvent | { type: 'error'; error: string }

export interface ActivityBuffer {
  key: string
  storyId: string
  agentName: string
  events: ActivityStreamEvent[]
  done: boolean
  error?: string
  // Waiting subscribers — resolved when new events arrive.
  waiters: Array<() => void>
}

const buffers = new Map<string, ActivityBuffer>()

function keyFor(storyId: string, agentName: string): string {
  return `${storyId}::${agentName}`
}

export function createActivityBuffer(storyId: string, agentName: string): ActivityBuffer {
  const key = keyFor(storyId, agentName)
  // Replace any live buffer for the same agent (a new run supersedes the old).
  const existing = buffers.get(key)
  if (existing && !existing.done) {
    finishActivityBuffer(existing, 'Superseded by a new run')
  }

  const buffer: ActivityBuffer = {
    key,
    storyId,
    agentName,
    events: [],
    done: false,
    waiters: [],
  }
  buffers.set(key, buffer)
  return buffer
}

export function getActivityBuffer(storyId: string, agentName: string): ActivityBuffer | null {
  return buffers.get(keyFor(storyId, agentName)) ?? null
}

export function pushActivityEvent(buffer: ActivityBuffer, event: ActivityStreamEvent): void {
  buffer.events.push(event)
  const waiters = buffer.waiters.splice(0)
  for (const wake of waiters) wake()
}

export function finishActivityBuffer(buffer: ActivityBuffer, error?: string): void {
  buffer.done = true
  if (error) buffer.error = error
  const waiters = buffer.waiters.splice(0)
  for (const wake of waiters) wake()
}

/** Drop the buffer from the map — but only if it's still the current one, so a
 *  finishing run can't evict the buffer a newer run just installed. In-flight
 *  subscribers keep their own reference and drain normally. */
export function clearActivityBuffer(buffer: ActivityBuffer): void {
  if (buffers.get(buffer.key) === buffer) {
    buffers.delete(buffer.key)
  }
}

/**
 * A ReadableStream<string> of NDJSON lines that replays all buffered events from
 * the beginning and then follows live. Returns null if no buffer exists.
 */
export function createActivitySSE(storyId: string, agentName: string): ReadableStream<string> | null {
  const buffer = buffers.get(keyFor(storyId, agentName))
  if (!buffer) return null

  let cursor = 0

  return new ReadableStream<string>({
    async pull(controller) {
      while (cursor < buffer.events.length) {
        controller.enqueue(JSON.stringify(buffer.events[cursor++]) + '\n')
      }

      if (buffer.done) {
        controller.close()
        return
      }

      await new Promise<void>((resolve) => {
        buffer.waiters.push(resolve)
      })

      while (cursor < buffer.events.length) {
        controller.enqueue(JSON.stringify(buffer.events[cursor++]) + '\n')
      }

      if (buffer.done) {
        controller.close()
      }
    },
  })
}
