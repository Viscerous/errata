import { describe, it, expect, afterEach } from 'vitest'
import {
  createActivityBuffer,
  getActivityBuffer,
  pushActivityEvent,
  finishActivityBuffer,
  clearActivityBuffer,
  createActivitySSE,
  type ActivityStreamEvent,
} from '@/server/agents/activity-stream'

const STORY = 'stream-test-story'
const AGENT = 'test.agent'

afterEach(() => {
  const buffer = getActivityBuffer(STORY, AGENT)
  if (buffer) clearActivityBuffer(buffer)
})

describe('activity-stream', () => {
  describe('createActivityBuffer', () => {
    it('creates a new buffer keyed by story + agent', () => {
      const buffer = createActivityBuffer(STORY, AGENT)
      expect(buffer.storyId).toBe(STORY)
      expect(buffer.agentName).toBe(AGENT)
      expect(buffer.events).toEqual([])
      expect(buffer.done).toBe(false)
    })

    it('replaces an existing live buffer for the same agent', () => {
      const first = createActivityBuffer(STORY, AGENT)
      pushActivityEvent(first, { type: 'text', text: 'hello' })
      expect(first.done).toBe(false)

      const second = createActivityBuffer(STORY, AGENT)
      expect(first.done).toBe(true) // first was finalized
      expect(second.events).toEqual([]) // second is fresh
    })

    it('keeps buffers for different agents separate', () => {
      const a = createActivityBuffer(STORY, 'agent.one')
      const b = createActivityBuffer(STORY, 'agent.two')
      pushActivityEvent(a, { type: 'text', text: 'one' })
      expect(b.events).toEqual([])
      clearActivityBuffer(a)
      clearActivityBuffer(b)
    })
  })

  describe('getActivityBuffer', () => {
    it('returns null when no buffer exists', () => {
      expect(getActivityBuffer('nope', 'nope')).toBeNull()
    })

    it('returns the current buffer', () => {
      const buffer = createActivityBuffer(STORY, AGENT)
      expect(getActivityBuffer(STORY, AGENT)).toBe(buffer)
    })
  })

  describe('pushActivityEvent', () => {
    it('adds events and wakes waiting subscribers', () => {
      const buffer = createActivityBuffer(STORY, AGENT)
      let woken = false
      buffer.waiters.push(() => { woken = true })
      pushActivityEvent(buffer, { type: 'text', text: 'wake up' })
      expect(buffer.events).toHaveLength(1)
      expect(woken).toBe(true)
      expect(buffer.waiters).toHaveLength(0)
    })
  })

  describe('finishActivityBuffer', () => {
    it('marks done and stores an error', () => {
      const buffer = createActivityBuffer(STORY, AGENT)
      finishActivityBuffer(buffer, 'something broke')
      expect(buffer.done).toBe(true)
      expect(buffer.error).toBe('something broke')
    })
  })

  describe('clearActivityBuffer', () => {
    it('removes the buffer', () => {
      const buffer = createActivityBuffer(STORY, AGENT)
      expect(getActivityBuffer(STORY, AGENT)).not.toBeNull()
      clearActivityBuffer(buffer)
      expect(getActivityBuffer(STORY, AGENT)).toBeNull()
    })

    it('does not evict a newer buffer installed for the same agent', () => {
      const first = createActivityBuffer(STORY, AGENT)
      const second = createActivityBuffer(STORY, AGENT)
      clearActivityBuffer(first) // stale — should be a no-op
      expect(getActivityBuffer(STORY, AGENT)).toBe(second)
      clearActivityBuffer(second)
    })
  })

  describe('createActivitySSE', () => {
    it('returns null when no buffer exists', () => {
      expect(createActivitySSE('nope', 'nope')).toBeNull()
    })

    it('replays buffered events and follows live', async () => {
      const buffer = createActivityBuffer(STORY, AGENT)
      pushActivityEvent(buffer, { type: 'text', text: 'first' })
      pushActivityEvent(buffer, { type: 'text', text: 'second' })

      const stream = createActivitySSE(STORY, AGENT)
      expect(stream).not.toBeNull()
      const reader = stream!.getReader()

      const r1 = await reader.read()
      expect(r1.done).toBe(false)
      expect((JSON.parse(r1.value!) as { text: string }).text).toBe('first')

      const r2 = await reader.read()
      expect((JSON.parse(r2.value!) as { text: string }).text).toBe('second')

      pushActivityEvent(buffer, { type: 'finish', finishReason: 'stop', stepCount: 1 })
      finishActivityBuffer(buffer)

      const r3 = await reader.read()
      expect((JSON.parse(r3.value!) as ActivityStreamEvent).type).toBe('finish')

      const r4 = await reader.read()
      expect(r4.done).toBe(true)
    })

    it('handles an already-finished buffer', async () => {
      const buffer = createActivityBuffer(STORY, AGENT)
      pushActivityEvent(buffer, { type: 'text', text: 'done' })
      finishActivityBuffer(buffer)

      const stream = createActivitySSE(STORY, AGENT)
      const reader = stream!.getReader()

      expect((await reader.read()).done).toBe(false)
      expect((await reader.read()).done).toBe(true)
    })
  })
})
