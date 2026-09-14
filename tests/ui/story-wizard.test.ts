// @vitest-environment jsdom
import React from 'react'
import { renderToString } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoryWizard } from '@/components/wizard/StoryWizard'
import type { StorySetupController } from '@/components/wizard/use-story-setup-controller'

const controller: StorySetupController = {
  messages: [],
  input: '',
  setInput: () => undefined,
  streamingText: '',
  isStreaming: false,
  error: null,
  checklist: [],
  draftFragments: [],
  sessionLoaded: true,
  contextReady: true,
  send: () => undefined,
  stop: () => undefined,
  retry: () => undefined,
}

describe('StoryWizard', () => {
  afterEach(cleanup)

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('opens as an unstructured story conversation rather than a step form', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const html = renderToString(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(StoryWizard, { controller, onClose: () => undefined }),
      ),
    )

    expect(html).toContain('Story setup')
    expect(html).toContain('Tell Errata whatever you have')
    expect(html).toContain('Saved as the conversation develops')
    expect(html).toContain('Back to story')
    expect(html).toContain('Story outline')
    expect(html).toContain('Suggestions, not requirements')
    expect(html).toContain('Starting point')
    expect(html).toContain('What it is about')
    expect(html).toContain('Characters')
    expect(html).toContain('Goal and stakes')
    expect(html).toContain('Setting')
    expect(html).toContain('Voice and tone')
    expect(html).toContain('Opening direction')
    expect(html).toContain('Fragments')
    expect(html).toContain('Fragments will appear here as the idea takes shape')
    expect(html).toContain('data-component-id="story-setup-composer-column"')
    expect(html).not.toContain('Begin your story')
    expect(html).not.toContain('Step 1 of')
    expect(html).not.toContain('Create story')
  })

  it('keeps the conversation actions and return navigation available', () => {
    const send = vi.fn()
    const stop = vi.fn()
    const onClose = vi.fn()
    const activeController = { ...controller, input: 'A premise', send, stop }
    const { rerender } = render(React.createElement(StoryWizard, { controller: activeController, onClose }))

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(send).toHaveBeenCalledWith('A premise')
    fireEvent.click(screen.getByRole('button', { name: 'Back to story' }))
    expect(onClose).toHaveBeenCalledOnce()

    rerender(React.createElement(StoryWizard, { controller: { ...activeController, isStreaming: true }, onClose }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop Errata' }))
    expect(stop).toHaveBeenCalledOnce()
  })

  it('shows a retryable connection failure without enabling the composer', () => {
    const retry = vi.fn()
    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        contextReady: false,
        error: 'Could not connect to the configured model. Start or reconnect its backend, then retry.',
        retry,
      },
      onClose: () => undefined,
    }))

    expect(screen.getByRole('alert').textContent).toContain('Could not connect to the configured model')
    expect(screen.getByRole('textbox', { name: 'Your story idea' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry story setup' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('surfaces Start writing CTA when the story outline and opening are ready', () => {
    const onClose = vi.fn()
    const readyChecklist = [
      { key: 'starting-point', status: 'covered' as const, note: 'Premise set' },
      { key: 'premise', status: 'covered' as const, note: 'Satire' },
      { key: 'characters', status: 'covered' as const, note: 'Arthur' },
      { key: 'goal', status: 'covered' as const, note: 'Promotion' },
      { key: 'setting', status: 'covered' as const, note: 'Beige' },
      { key: 'voice', status: 'covered' as const, note: 'Deadpan' },
      { key: 'opening', status: 'covered' as const, note: 'Office scale' },
    ]

    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        checklist: readyChecklist,
      },
      onClose,
    }))

    const startButtons = screen.getAllByRole('button', { name: 'Start writing' })
    expect(startButtons.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(startButtons[0])
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getAllByText('Foundation ready').length).toBeGreaterThanOrEqual(1)
  })
})

