import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@/lib/api/types'
import { consumeGenerationStream } from '@/components/prose/generation-stream'

function eventStream(events: ChatEvent[]): ReadableStream<ChatEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event)
      controller.close()
    },
  })
}

describe('generation stream reader', () => {
  it('folds text, thoughts, directions, and completion metadata in one place', async () => {
    const onProgress = vi.fn()
    const result = await consumeGenerationStream(eventStream([
      { type: 'phase', phase: 'prewriting' },
      { type: 'prewriter-text', text: 'First brief' },
      { type: 'prewriter-reset' },
      { type: 'prewriter-text', text: 'Final brief' },
      { type: 'tool-call', id: 'tool-1', toolName: 'lookup', args: { name: 'Mara' } },
      { type: 'tool-error', id: 'tool-1', toolName: 'lookup', error: 'Not found' },
      { type: 'reasoning', text: 'Draft' },
      { type: 'reasoning', text: 'ing' },
      { type: 'text', text: 'One ' },
      { type: 'text', text: 'line.' },
      { type: 'prewriter-directions', directions: [{ title: 'Wait', description: 'Hold the moment', instruction: 'Slow down.' }] },
      { type: 'generation-rejected', reason: 'Incomplete', code: 'incomplete_finish', finishReason: 'length' },
      { type: 'finish', finishReason: 'stop', stepCount: 2, stopped: true },
    ]), onProgress)

    expect(result.text).toBe('One line.')
    expect(result.thoughts).toEqual([
      { type: 'phase', phase: 'prewriting' },
      { type: 'prewriter-text', text: 'Final brief' },
      { type: 'tool-call', id: 'tool-1', toolName: 'lookup', args: { name: 'Mara' } },
      { type: 'tool-error', id: 'tool-1', toolName: 'lookup', error: 'Not found' },
      { type: 'reasoning', text: 'Drafting' },
    ])
    expect(result.directions?.[0]?.instruction).toBe('Slow down.')
    expect(result.rejectionReason).toBe('Incomplete')
    expect(result.stopped).toBe(true)
    expect(onProgress).toHaveBeenLastCalledWith({ text: 'One line.', thoughts: result.thoughts })
  })

  it('returns clarification questions independently of prose', async () => {
    const result = await consumeGenerationStream(eventStream([
      { type: 'clarify-questions', round: 0, questions: [{ header: 'Tone', question: 'Which tone?', multiSelect: false, options: [{ label: 'Warm' }, { label: 'Cold' }] }] },
      { type: 'finish', finishReason: 'tool-calls', stepCount: 1 },
    ]))

    expect(result.text).toBe('')
    expect(result.questions?.[0]?.header).toBe('Tone')
    expect(result.stopped).toBe(false)
  })
})
