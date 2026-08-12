import { describe, expect, it } from 'vitest'
import { createEventStream } from '@/server/agents/create-event-stream'

async function readEvents(stream: ReadableStream<string>): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader()
  const events: Array<Record<string, unknown>> = []
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) events.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return events
}

describe('createEventStream cancellation contract', () => {
  it('closes an attached stream with finish.stopped when the run is aborted', async () => {
    const abortController = new AbortController()
    let enteredPendingRead!: () => void
    const pendingRead = new Promise<void>(resolve => { enteredPendingRead = resolve })

    async function* source() {
      yield { type: 'text-delta', text: 'Partial' }
      enteredPendingRead()
      await new Promise<void>(() => {})
    }

    const result = createEventStream(source(), undefined, abortController.signal)
    const eventsPromise = readEvents(result.eventStream)
    await pendingRead
    abortController.abort()

    await expect(result.completion).rejects.toMatchObject({ name: 'AbortError' })
    await expect(eventsPromise).resolves.toEqual([
      { type: 'text', text: 'Partial' },
      { type: 'finish', finishReason: 'stop', stepCount: 0, stopped: true },
    ])
  })
})
