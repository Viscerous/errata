// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { generateAndSave, cancel } = vi.hoisted(() => ({
  generateAndSave: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      generation: { ...actual.api.generation, generateAndSave },
      agents: { ...actual.api.agents, cancel },
      branches: { ...actual.api.branches, list: async () => ({ activeBranchId: 'main', branches: [] }) },
      librarian: {
        ...actual.api.librarian,
        getStatus: async () => ({ runStatus: 'idle' }),
        listAnalyses: async () => [],
      },
      stories: { ...actual.api.stories, get: async () => null },
      config: { ...actual.api.config, getProviders: async () => null },
    },
  }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import { InlineGenerationInput, type InlineGenerationHandoff } from '@/components/prose/InlineGenerationInput'
import { eventStream } from './event-stream'

function renderInput(props?: {
  handoff?: InlineGenerationHandoff | null
  onConsumeHandoff?: () => void
  onGenerationStart?: (prompt: string, inputMode: any) => void
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(TooltipProvider, null,
        React.createElement(InlineGenerationInput, {
          storyId: 'story-1',
          isGenerating: false,
          handoff: props?.handoff,
          onConsumeHandoff: props?.onConsumeHandoff,
          onGenerationStart: props?.onGenerationStart ?? (() => {}),
          onGenerationStream: () => {},
          onGenerationComplete: () => {},
          onGenerationError: () => {},
        }),
      ),
    ),
  )
  const textarea = utils.container.querySelector<HTMLTextAreaElement>(
    '[data-component-id="inline-generation-input"]',
  )!
  return { ...utils, textarea }
}

async function write(textarea: HTMLTextAreaElement, container: HTMLElement, prompt: string) {
  fireEvent.change(textarea, { target: { value: prompt } })
  const submit = container.querySelector<HTMLButtonElement>(
    '[data-component-id="inline-generation-submit"]',
  )!
  await act(async () => { fireEvent.click(submit) })
}

describe('stopping a prose generation', () => {
  // The suite shares one document across its fork, so a render left standing is
  // visible to whichever file runs next.
  afterEach(cleanup)

  beforeEach(() => {
    localStorage.clear()
    generateAndSave.mockReset()
    cancel.mockReset()
    cancel.mockResolvedValue({ ok: true, active: true })
  })

  it('leaves the prompt in the composer when the run reports it was stopped', async () => {
    // A stopped run closes its stream as cleanly as a finished one — only the
    // flag separates them.
    generateAndSave.mockResolvedValue(eventStream([
      { type: 'text', text: 'The door swung' },
      { type: 'finish', finishReason: 'stop', stepCount: 1, stopped: true },
    ]))

    const { textarea, container } = renderInput()
    await write(textarea, container, 'open the door')

    await waitFor(() => expect(textarea.value).toBe('open the door'))
  })

  it('clears the prompt when the run finishes on its own', async () => {
    generateAndSave.mockResolvedValue(eventStream([
      { type: 'text', text: 'The door swung open.' },
      { type: 'finish', finishReason: 'stop', stepCount: 1 },
    ]))

    const { textarea, container } = renderInput()
    await write(textarea, container, 'open the door')

    await waitFor(() => expect(textarea.value).toBe(''))
  })

  it('submits Direct with Enter while reserving Shift+Enter for a newline', async () => {
    generateAndSave.mockResolvedValue(eventStream([
      { type: 'finish', finishReason: 'stop', stepCount: 1 },
    ]))
    const { textarea } = renderInput()
    fireEvent.change(textarea, { target: { value: 'open the door' } })

    expect(fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })).toBe(true)
    expect(generateAndSave).not.toHaveBeenCalled()

    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(false)
    await waitFor(() => expect(generateAndSave).toHaveBeenCalledOnce())
  })

  it('keeps Ctrl+Enter only for adding a directly written section', () => {
    const { container } = renderInput()
    fireEvent.click(container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Write prose directly"]')!)
    const prose = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Write your prose directly..."]')!

    expect(container.textContent).toContain('Ctrl+Enter')
    expect(fireEvent.keyDown(prose, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(prose, { key: 'Enter', ctrlKey: true })).toBe(false)
  })

  it('triggers immediate generation and consumes handoff when mode is generate', async () => {
    generateAndSave.mockResolvedValue(eventStream([
      { type: 'finish', finishReason: 'stop', stepCount: 1 },
    ]))
    const onConsumeHandoff = vi.fn()
    const onGenerationStart = vi.fn()

    renderInput({
      handoff: { mode: 'generate', prompt: 'Arthur sits down at his beige desk.' },
      onConsumeHandoff,
      onGenerationStart,
    })

    await waitFor(() => expect(onConsumeHandoff).toHaveBeenCalledOnce())
    await waitFor(() => expect(onGenerationStart).toHaveBeenCalledWith('Arthur sits down at his beige desk.', 'direct'))
    expect(generateAndSave).toHaveBeenCalledWith(
      'story-1',
      'Arthur sits down at his beige desk.',
      expect.any(AbortSignal),
      expect.objectContaining({ inputMode: 'direct' }),
    )
  })

  it('prefills textarea without generating when mode is write', async () => {
    const onConsumeHandoff = vi.fn()
    const onGenerationStart = vi.fn()

    const { textarea } = renderInput({
      handoff: { mode: 'write', prompt: 'Arthur examines the missing requisition form.' },
      onConsumeHandoff,
      onGenerationStart,
    })

    await waitFor(() => expect(onConsumeHandoff).toHaveBeenCalledOnce())
    expect(textarea.value).toBe('Arthur examines the missing requisition form.')
    expect(onGenerationStart).not.toHaveBeenCalled()
    expect(generateAndSave).not.toHaveBeenCalled()
  })
})
