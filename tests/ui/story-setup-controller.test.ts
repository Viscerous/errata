// @vitest-environment jsdom
import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      storySetup: { ...actual.api.storySetup, chat },
    },
  }
})

import { useStorySetupController } from '@/components/wizard/use-story-setup-controller'

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    React.createElement(QueryClientProvider, { client: queryClient }, children)
  )
}

describe('useStorySetupController', () => {
  beforeEach(() => {
    window.localStorage.clear()
    chat.mockReset()
  })

  it('keeps one in-flight turn when the Story Setup surface hides and reopens', async () => {
    let requestSignal: AbortSignal | undefined
    chat.mockImplementation(async (
      _storyId: string,
      _messages: unknown[],
      _mode: string,
      signal: AbortSignal,
    ) => {
      requestSignal = signal
      return new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            controller.error(error)
          }, { once: true })
        },
      })
    })

    const { result, rerender, unmount } = renderHook(
      ({ active }) => useStorySetupController({
        storyId: 'story-test',
        sessionScope: 'main',
        contentRevision: 'revision-1',
        active,
      }),
      { initialProps: { active: true }, wrapper: makeWrapper() },
    )

    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1))
    expect(result.current.isStreaming).toBe(true)

    rerender({ active: false })
    expect(requestSignal?.aborted).toBe(false)

    rerender({ active: true })
    await act(async () => undefined)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(result.current.isStreaming).toBe(true)

    unmount()
    expect(requestSignal?.aborted).toBe(true)
  })

  it('does not accept an assessment that ends without a valid setup snapshot', async () => {
    chat.mockResolvedValue(new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'tool-error', id: 'bad-1', toolName: 'updateStorySetup', error: 'Invalid checklist' })
        controller.enqueue({ type: 'finish', finishReason: 'stop', stepCount: 3 })
        controller.close()
      },
    }))

    const { result } = renderHook(
      () => useStorySetupController({
        storyId: 'story-test',
        sessionScope: 'main',
        contentRevision: 'revision-1',
        active: true,
      }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => expect(result.current.error).toContain('Invalid checklist'))
    expect(result.current.contextReady).toBe(false)
    expect(result.current.isStreaming).toBe(false)
    expect(window.localStorage.length).toBe(0)
  })

  it('accepts a read-only assessment only after its tool result arrives', async () => {
    const checklist = [
      { key: 'starting-point' as const, status: 'covered' as const, note: 'Existing draft' },
    ]
    chat.mockResolvedValue(new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-result',
          id: 'ok-1',
          toolName: 'updateStorySetup',
          result: { saved: false, checklist, fragments: [] },
        })
        controller.enqueue({ type: 'text', text: 'What remains unresolved?' })
        controller.enqueue({ type: 'finish', finishReason: 'stop', stepCount: 2 })
        controller.close()
      },
    }))

    const { result } = renderHook(
      () => useStorySetupController({
        storyId: 'story-test',
        sessionScope: 'main',
        contentRevision: 'revision-1',
        active: true,
      }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => expect(result.current.contextReady).toBe(true))
    expect(result.current.error).toBeNull()
    expect(result.current.checklist[0]).toEqual(checklist[0])
    expect(result.current.messages.at(-1)?.content).toBe('What remains unresolved?')
  })

  it('requires a conversational response after a valid snapshot', async () => {
    chat.mockResolvedValue(new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-result',
          id: 'ok-1',
          toolName: 'updateStorySetup',
          result: { saved: false, checklist: [], fragments: [] },
        })
        controller.enqueue({ type: 'finish', finishReason: 'length', stepCount: 3 })
        controller.close()
      },
    }))

    const { result } = renderHook(
      () => useStorySetupController({
        storyId: 'story-test',
        sessionScope: 'main',
        contentRevision: 'revision-1',
        active: true,
      }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => expect(result.current.error).toContain('before asking its next question'))
    expect(result.current.contextReady).toBe(false)
  })
})
