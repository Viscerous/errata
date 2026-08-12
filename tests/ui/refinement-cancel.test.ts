// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@/lib/api'
import { eventStream } from './event-stream'

const { refine, cancel } = vi.hoisted(() => ({ refine: vi.fn(), cancel: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      agents: { ...actual.api.agents, cancel },
      librarian: { ...actual.api.librarian, refine },
    },
  }
})

import { RefinementPanel } from '@/components/refinement/RefinementPanel'

/** The tool result the librarian emits the moment an edit lands. */
const APPLIED_EDIT: ChatEvent = {
  type: 'tool-result',
  id: 'call-1',
  toolName: 'editFragments',
  result: {
    operations: [{
      action: 'set_fields',
      status: 'applied',
      target: { fragmentId: 'ch-vic' },
      diffs: [{ field: 'content', before: 'Terse.', after: 'Rather less terse.' }],
    }],
    appliedChanges: [{ kind: 'update', fragmentId: 'ch-vic' }],
  },
}

/** The prose the librarian streams while it works. */
const EXPLAINING: ChatEvent = { type: 'text', text: 'Reworking the sheet' }

/**
 * Arms the refine endpoint with a run that emits `script` then sits mid-run
 * until it is stopped, and collects the signals it was called with.
 */
function mockRefine(script: ChatEvent[] = []) {
  const signals: AbortSignal[] = []
  const runIds: string[] = []
  const servers = new Map<string, AbortController>()
  refine.mockImplementation(async (...args: unknown[]) => {
    const runId = args[3] as string
    const signal = args[4] as AbortSignal
    const server = new AbortController()
    runIds.push(runId)
    signals.push(signal)
    servers.set(runId, server)
    return eventStream([EXPLAINING, ...script], {
      onExhausted: 'hang',
      signal: server.signal,
      onAbort: 'finish',
    })
  })
  cancel.mockImplementation(async (_storyId: string, runId: string) => {
    servers.get(runId)?.abort()
    return { ok: true, active: true }
  })
  return { signals, runIds }
}

function renderPanel(onComplete: () => void, onClose: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(RefinementPanel, {
        storyId: 'story-1',
        fragmentId: 'ch-vic',
        fragmentName: 'Victoria',
        onComplete,
        onClose,
      }),
    ),
  )
  const byId = <T extends HTMLElement>(id: string) =>
    utils.container.querySelector<T>(`[data-component-id="${id}"]`)
  return { ...utils, byId }
}

async function startRefining(byId: ReturnType<typeof renderPanel>['byId'], instructions: string) {
  fireEvent.change(byId<HTMLTextAreaElement>('refinement-input')!, { target: { value: instructions } })
  await act(async () => { fireEvent.click(byId('refinement-submit')!) })
}

describe('cancelling a refinement', () => {
  afterEach(cleanup)

  beforeEach(() => {
    refine.mockReset()
    cancel.mockReset()
  })

  it('aborts the request rather than only closing the panel', async () => {
    const { signals, runIds } = mockRefine()
    const onComplete = vi.fn()
    const onClose = vi.fn()
    const { byId } = renderPanel(onComplete, onClose)
    await startRefining(byId, 'tighten the voice')

    await waitFor(() => expect(byId('refinement-stop')).toBeTruthy())
    expect(signals[0]?.aborted).toBe(false)

    await act(async () => { fireEvent.click(byId('refinement-stop')!) })

    await waitFor(() => expect(cancel).toHaveBeenCalledWith('story-1', runIds[0]))
    // Explicit cancellation leaves the response attached for finish.stopped.
    expect(signals[0]?.aborted).toBe(false)
    // Cancelling stops the run; it does not dismiss the panel out from under it.
    expect(onClose).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('returns to the form with the instructions intact so the run can be retried', async () => {
    mockRefine()
    const { byId } = renderPanel(vi.fn(), vi.fn())
    await startRefining(byId, 'tighten the voice')

    await waitFor(() => expect(byId('refinement-stop')).toBeTruthy())
    expect(byId('refinement-input')).toBeNull()

    await act(async () => { fireEvent.click(byId('refinement-stop')!) })

    await waitFor(() => {
      expect(byId<HTMLTextAreaElement>('refinement-input')?.value).toBe('tighten the voice')
    })
    // Cut short is not finished — the done state must not claim the fragment was updated.
    expect(byId('refinement-done')).toBeNull()
    expect(byId('refinement-cancelled')?.textContent).toContain('Refinement stopped')
  })

  it('does not infer completion from a tool result emitted before stop', async () => {
    mockRefine([APPLIED_EDIT])
    const onComplete = vi.fn()
    const { byId } = renderPanel(onComplete, vi.fn())
    await startRefining(byId, 'tighten the voice')

    await waitFor(() => expect(byId('refinement-stop')).toBeTruthy())
    await act(async () => { fireEvent.click(byId('refinement-stop')!) })

    await waitFor(() => expect(byId('refinement-cancelled')).toBeTruthy())
    expect(onComplete).not.toHaveBeenCalled()
    expect(byId('refinement-done')).toBeNull()
  })

  it('aborts the run when the panel unmounts', async () => {
    const { runIds } = mockRefine()
    const { byId, unmount } = renderPanel(vi.fn(), vi.fn())
    await startRefining(byId, 'tighten the voice')

    await waitFor(() => expect(byId('refinement-stop')).toBeTruthy())

    await act(async () => { unmount() })

    expect(cancel).toHaveBeenCalledWith('story-1', runIds[0])
  })
})
