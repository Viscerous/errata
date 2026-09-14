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

    act(() => result.current.assess())

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

    act(() => result.current.assess())

    await waitFor(() => expect(result.current.error).toContain('Invalid checklist'))
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

    act(() => result.current.assess())

    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('What remains unresolved?'))
    expect(result.current.error).toBeNull()
    expect(result.current.checklist[0]).toEqual(checklist[0])
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

    act(() => result.current.assess())

    await waitFor(() => expect(result.current.error).toContain('before asking its next question'))
  })

  it('explains an offline model connection and recovers when retried', async () => {
    chat.mockRejectedValueOnce(new Error('socket hang up'))
    chat.mockResolvedValueOnce(new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-result',
          id: 'ok-1',
          toolName: 'updateStorySetup',
          result: { saved: false, checklist: [], fragments: [] },
        })
        controller.enqueue({ type: 'text', text: 'Where would you like to begin?' })
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

    act(() => result.current.assess())

    await waitFor(() => expect(result.current.error).toContain('Start or reconnect its backend'))
    expect(chat).toHaveBeenCalledTimes(1)

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Where would you like to begin?'))
    expect(result.current.error).toBeNull()
  })

  it('preserves covered checklist items when incoming turns mark them partial during refinement', async () => {
    chat.mockResolvedValueOnce(new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-result',
          id: 'turn-1',
          toolName: 'updateStorySetup',
          result: {
            saved: true,
            checklist: [
              { key: 'starting-point', status: 'covered', note: 'Office premise' },
              { key: 'characters', status: 'covered', note: 'Arthur and Manager' },
            ],
            fragments: [],
          },
        })
        controller.enqueue({ type: 'text', text: 'Tell me about the manager.' })
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

    act(() => result.current.assess())

    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Tell me about the manager.'))
    const charactersItem = result.current.checklist.find(i => i.key === 'characters')
    expect(charactersItem?.status).toBe('covered')

    chat.mockResolvedValueOnce(new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-result',
          id: 'turn-2',
          toolName: 'updateStorySetup',
          result: {
            saved: true,
            checklist: [
              { key: 'starting-point', status: 'covered', note: 'Office premise' },
              // Incoming turn regressed characters to partial while asking a follow-up
              { key: 'characters', status: 'partial', note: 'Exploring manager style' },
            ],
            fragments: [],
          },
        })
        controller.enqueue({ type: 'text', text: 'Which manager style do you prefer?' })
        controller.close()
      },
    }))

    act(() => result.current.send('The manager is lazy.'))
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Which manager style do you prefer?'))

    // The covered status was ratcheted and did not regress to partial
    const updatedItem = result.current.checklist.find(i => i.key === 'characters')
    expect(updatedItem?.status).toBe('covered')
    expect(updatedItem?.note).toBe('Exploring manager style')
  })

  it('captures structured options from tool results and clears them on send', async () => {
    chat.mockResolvedValueOnce(new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-result',
          id: 'turn-1',
          toolName: 'updateStorySetup',
          result: {
            saved: true,
            checklist: [
              { key: 'starting-point', status: 'covered', note: 'Office premise' },
            ],
            fragments: [],
            options: [
              { label: 'The Deadpan Tone', description: 'Dry and satirical' },
              { label: 'The Surreal Absurdism', value: 'Surreal corporate dream logic' },
            ],
          },
        })
        controller.enqueue({ type: 'text', text: 'Which voice fits best?' })
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

    act(() => result.current.assess())

    await waitFor(() => expect(result.current.options.length).toBe(2))
    expect(result.current.options).toEqual([
      { label: 'The Deadpan Tone', description: 'Dry and satirical' },
      { label: 'The Surreal Absurdism', value: 'Surreal corporate dream logic' },
    ])

    // When the user responds or sends an option, options are cleared
    chat.mockResolvedValueOnce(new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-result',
          id: 'turn-2',
          toolName: 'updateStorySetup',
          result: {
            saved: true,
            checklist: [
              { key: 'starting-point', status: 'covered', note: 'Office premise' },
              { key: 'voice', status: 'covered', note: 'Deadpan tone' },
            ],
            fragments: [],
            options: [],
          },
        })
        controller.enqueue({ type: 'text', text: 'Voice is saved.' })
        controller.close()
      },
    }))

    act(() => result.current.send('The Deadpan Tone'))
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Voice is saved.'))
    expect(result.current.options).toEqual([])
  })

  it('reflects hasExistingMaterial when hasStoryFragments is true', () => {
    const { result } = renderHook(
      () => useStorySetupController({
        storyId: 'story-test',
        sessionScope: 'main',
        contentRevision: 'revision-1',
        active: true,
        hasStoryFragments: true,
        storyTitle: 'The Average Man',
        storyDescription: 'Corporate satire',
      }),
      { wrapper: makeWrapper() },
    )

    expect(result.current.hasExistingMaterial).toBe(true)
    expect(result.current.storyTitle).toBe('The Average Man')
    expect(result.current.storyDescription).toBe('Corporate satire')
  })

  it('invokes chat in continue mode with empty history when start is called', async () => {
    chat.mockResolvedValueOnce(new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-result',
          id: 'turn-start',
          toolName: 'updateStorySetup',
          result: {
            saved: true,
            checklist: [
              { key: 'starting-point', status: 'covered', note: 'Corporate premise' },
            ],
            fragments: [],
            options: [{ label: 'Corporate Panopticon' }],
          },
        })
        controller.enqueue({ type: 'text', text: 'Here are a few ways we could develop this story...' })
        controller.close()
      },
    }))

    const { result } = renderHook(
      () => useStorySetupController({
        storyId: 'story-test',
        sessionScope: 'main',
        contentRevision: 'revision-1',
        active: true,
        storyTitle: 'The Average Man',
      }),
      { wrapper: makeWrapper() },
    )

    act(() => result.current.start())

    await waitFor(() => expect(chat).toHaveBeenCalledWith(
      'story-test',
      [],
      'continue',
      expect.any(AbortSignal),
    ))

    await waitFor(() => expect(result.current.messages.length).toBe(1))
    expect(result.current.messages[0].content).toBe('Here are a few ways we could develop this story...')
    expect(result.current.options).toEqual([{ label: 'Corporate Panopticon' }])
  })
})

