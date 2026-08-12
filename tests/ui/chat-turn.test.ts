// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@/lib/api'
import { useChatTurn } from '@/components/chat/use-chat-turn'
import { eventStream } from './event-stream'

const completedStream = (events: ChatEvent[]) => eventStream([
  ...events,
  { type: 'finish', finishReason: 'stop', stepCount: 1 },
])

function stoppedTurn(events: ChatEvent[] = []) {
  const server = new AbortController()
  return {
    start: () => Promise.resolve(eventStream(events, {
      onExhausted: 'hang',
      signal: server.signal,
      onAbort: 'finish',
    })),
    cancel: async () => { server.abort() },
  }
}

describe('useChatTurn', () => {
  afterEach(cleanup)

  it('returns the text to the composer when a turn is stopped before it produces anything', async () => {
    const onCommit = vi.fn()
    const turn = stoppedTurn()
    const { result } = renderHook(() => useChatTurn({
      ...turn,
      onCommit,
    }))

    act(() => { result.current.setInput('what do you remember?') })

    let sent!: Promise<void>
    act(() => { sent = result.current.send() })
    expect(result.current.isStreaming).toBe(true)
    expect(result.current.input).toBe('')

    await act(async () => {
      result.current.stop()
      await sent
    })

    expect(result.current.input).toBe('what do you remember?')
    expect(result.current.messages).toEqual([])
    expect(result.current.error).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('rolls back a stopped turn even when a partial reply was streamed', async () => {
    const onCommit = vi.fn()
    const turn = stoppedTurn([{ type: 'text', text: 'I remember the' }])
    const { result } = renderHook(() => useChatTurn({
      ...turn,
      onCommit,
    }))

    act(() => { result.current.setInput('what do you remember?') })
    let sent!: Promise<void>
    act(() => { sent = result.current.send() })
    await act(async () => {
      result.current.stop()
      await sent
    })

    expect(result.current.input).toBe('what do you remember?')
    expect(result.current.messages).toEqual([])
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('returns the text and un-strands the message when a turn fails outright', async () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useChatTurn({
      start: () => Promise.reject(new Error('Provider unreachable')),
      cancel: vi.fn(),
      onCommit,
    }))

    act(() => { result.current.setInput('are you there?') })
    await act(async () => { await result.current.send() })

    expect(result.current.input).toBe('are you there?')
    expect(result.current.messages).toEqual([])
    expect(result.current.error).toBe('Provider unreachable')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('leaves earlier turns intact when a later one is rolled back', async () => {
    const second = new AbortController()
    let turn = 0
    const { result } = renderHook(() => useChatTurn({
      start: () => Promise.resolve(turn++ === 0
        ? completedStream([{ type: 'text', text: 'Yes.' }])
        : eventStream([], {
            onExhausted: 'hang',
            signal: second.signal,
            onAbort: 'finish',
          })),
      cancel: async () => { second.abort() },
    }))

    act(() => { result.current.setInput('first') })
    await act(async () => { await result.current.send() })

    act(() => { result.current.setInput('second') })
    let sent!: Promise<void>
    act(() => { sent = result.current.send() })
    await act(async () => {
      result.current.stop()
      await sent
    })

    expect(result.current.input).toBe('second')
    expect(result.current.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'Yes.' },
    ])
  })

  it('requests server cancellation when the chat unmounts mid-turn', async () => {
    const turn = stoppedTurn()
    const cancel = vi.spyOn(turn, 'cancel')
    const { result, unmount } = renderHook(() => useChatTurn(turn))

    act(() => { result.current.setInput('still there?') })
    let sent!: Promise<void>
    act(() => { sent = result.current.send() })
    act(() => { unmount() })
    await sent

    expect(cancel).toHaveBeenCalledOnce()
  })
})
