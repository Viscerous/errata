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
import { InlineGenerationInput } from '@/components/prose/InlineGenerationInput'
import { eventStream } from './event-stream'

function renderInput() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(TooltipProvider, null,
        React.createElement(InlineGenerationInput, {
          storyId: 'story-1',
          isGenerating: false,
          onGenerationStart: () => {},
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
})
