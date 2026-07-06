import { describe, it, expect } from 'vitest'
import { drainAgentStream } from '@/server/agents/drain-agent-stream'
import type { AgentStreamEvent } from '@/server/agents/stream-types'

async function* fullStreamOf(parts: Array<{ type: string; [key: string]: unknown }>): AsyncGenerator<unknown> {
  for (const part of parts) yield part
}

describe('drainAgentStream', () => {
  it('accumulates text, reasoning, tool calls, step count, and finish reason', async () => {
    const events: AgentStreamEvent[] = []
    const result = await drainAgentStream(fullStreamOf([
      { type: 'reasoning-delta', text: 'thinking... ' },
      { type: 'text-delta', text: 'Once ' },
      { type: 'text-delta', text: 'upon a time.' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'readFragments', input: { id: 'ch-0001' } },
      { type: 'tool-result', toolCallId: 't1', toolName: 'readFragments', output: { name: 'Alice' } },
      { type: 'finish-step' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ]), (e) => events.push(e))

    expect(result).toEqual({
      fullText: 'Once upon a time.',
      fullReasoning: 'thinking... ',
      toolCalls: [{ toolName: 'readFragments', args: { id: 'ch-0001' }, result: { name: 'Alice' } }],
      stepCount: 2,
      finishReason: 'stop',
    })

    // onEvent receives normalized events for everything except finish-step/finish
    // (those are summarized in the returned result, not emitted individually).
    expect(events).toEqual([
      { type: 'reasoning', text: 'thinking... ' },
      { type: 'text', text: 'Once ' },
      { type: 'text', text: 'upon a time.' },
      { type: 'tool-call', id: 't1', toolName: 'readFragments', args: { id: 'ch-0001' } },
      { type: 'tool-result', id: 't1', toolName: 'readFragments', result: { name: 'Alice' } },
    ])
  })

  it('correlates a tool-result to its own tool-call args when interleaved', async () => {
    const result = await drainAgentStream(fullStreamOf([
      { type: 'tool-call', toolCallId: 'a', toolName: 'listFragments', input: { type: 'character' } },
      { type: 'tool-call', toolCallId: 'b', toolName: 'readFragments', input: { id: 'ch-0002' } },
      { type: 'tool-result', toolCallId: 'b', toolName: 'readFragments', output: 'bob-sheet' },
      { type: 'tool-result', toolCallId: 'a', toolName: 'listFragments', output: ['ch-0001', 'ch-0002'] },
    ]))

    expect(result.toolCalls).toEqual([
      { toolName: 'readFragments', args: { id: 'ch-0002' }, result: 'bob-sheet' },
      { toolName: 'listFragments', args: { type: 'character' }, result: ['ch-0001', 'ch-0002'] },
    ])
  })

  it('defaults finishReason to unknown and works with no onEvent callback at all', async () => {
    const result = await drainAgentStream(fullStreamOf([
      { type: 'text-delta', text: 'hello' },
    ]))
    expect(result.finishReason).toBe('unknown')
    expect(result.fullText).toBe('hello')
  })

  it('fails when the stream stops producing parts without closing', async () => {
    async function* stalledStream(): AsyncGenerator<unknown> {
      yield { type: 'text-delta', text: 'partial' }
      await new Promise(() => {})
    }

    await expect(drainAgentStream(stalledStream(), undefined, { idleTimeoutMs: 5 }))
      .rejects.toThrow('Agent stream idle timeout')
  })

  it('fails promptly when the abort signal fires', async () => {
    const controller = new AbortController()
    async function* stalledStream(): AsyncGenerator<unknown> {
      await new Promise(() => {})
    }

    const drained = drainAgentStream(stalledStream(), undefined, { abortSignal: controller.signal })
    controller.abort()

    await expect(drained).rejects.toThrow('Agent stream aborted')
  })
})
