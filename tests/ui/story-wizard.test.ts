// @vitest-environment jsdom
import React from 'react'
import { renderToString } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoryWizard } from '@/components/wizard/StoryWizard'
import type { StorySetupController } from '@/components/wizard/use-story-setup-controller'
import type { StorySetupChecklistItem } from '@/lib/api'

const controller: StorySetupController = {
  messages: [],
  input: '',
  setInput: () => undefined,
  streamingText: '',
  isStreaming: false,
  error: null,
  checklist: [],
  draftFragments: [],
  options: [],
  sessionLoaded: true,
  contextReady: true,
  hasExistingMaterial: false,
  send: () => undefined,
  start: () => undefined,
  assess: () => undefined,
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
    const readyChecklist: StorySetupChecklistItem[] = [
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

  it('does not surface Foundation ready when voice is covered but opening is still missing or partial', () => {
    const incompleteChecklist: StorySetupChecklistItem[] = [
      { key: 'starting-point', status: 'covered' as const, note: 'Premise set' },
      { key: 'premise', status: 'covered' as const, note: 'Satire' },
      { key: 'characters', status: 'covered' as const, note: 'Arthur' },
      { key: 'goal', status: 'covered' as const, note: 'Promotion' },
      { key: 'setting', status: 'covered' as const, note: 'Beige' },
      { key: 'voice', status: 'covered' as const, note: 'Deadpan' },
      { key: 'opening', status: 'missing' as const, note: '' },
    ]

    const { rerender } = render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        checklist: incompleteChecklist,
      },
      onClose: () => undefined,
    }))

    expect(screen.queryByRole('button', { name: 'Start writing' })).toBeNull()
    expect(screen.queryByText('Foundation ready')).toBeNull()

    // Even if opening is partial, foundation is not ready until opening is covered
    const partialOpeningChecklist = incompleteChecklist.map(item =>
      item.key === 'opening' ? { ...item, status: 'partial' as const, note: 'Thinking about first scene' } : item,
    )
    rerender(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        checklist: partialOpeningChecklist,
      },
      onClose: () => undefined,
    }))

    expect(screen.queryByRole('button', { name: 'Start writing' })).toBeNull()
    expect(screen.queryByText('Foundation ready')).toBeNull()
  })

  it('renders welcoming greeting on empty story without starting points', () => {
    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        messages: [],
      },
      onClose: () => undefined,
    }))

    expect(screen.getByText(/What kind of story would you like to tell/i)).toBeDefined()
    expect(screen.queryByText('A premise')).toBeNull()
    expect(screen.queryByText('A character')).toBeNull()
    expect(screen.queryByText('A scene or moment')).toBeNull()
  })

  it('keeps welcoming greeting visible when messages are present in transcript', () => {
    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        messages: [
          { role: 'user', content: 'I have a story about a clerk.' },
          { role: 'assistant', content: 'Tell me more about this clerk.' },
        ],
      },
      onClose: () => undefined,
    }))

    expect(screen.getByText(/What kind of story would you like to tell/i)).toBeDefined()
    expect(screen.getByText('I have a story about a clerk.')).toBeDefined()
    expect(screen.getByText('Tell me more about this clerk.')).toBeDefined()
  })

  it('offers explicit assessment button when opening a story with existing fragments', () => {
    const assess = vi.fn()
    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        messages: [],
        hasExistingMaterial: true,
        assess,
      },
      onClose: () => undefined,
    }))

    expect(screen.getByText(/This story already has established characters, notes, and world details/i)).toBeDefined()
    const assessBtn = screen.getByRole('button', { name: 'Assess existing foundation' })
    expect(assessBtn).toBeDefined()
    fireEvent.click(assessBtn)
    expect(assess).toHaveBeenCalledOnce()
  })

  it('offers explore button when story has working title and description, and invokes controller.start', () => {
    const start = vi.fn()
    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        messages: [],
        hasExistingMaterial: false,
        storyTitle: 'The Average Man',
        storyDescription: 'A satire of corporate promotion exams.',
        start,
      },
      onClose: () => undefined,
    }))

    expect(screen.getByText(/Welcome to Story Setup for "The Average Man"/i)).toBeDefined()
    const exploreBtn = screen.getByRole('button', { name: /Explore ideas for “The Average Man”/i })
    expect(exploreBtn).toBeDefined()
    fireEvent.click(exploreBtn)
    expect(start).toHaveBeenCalledOnce()
  })

  it('renders structured controller options as compact outline pill buttons and dispatches label on click', () => {
    const send = vi.fn()
    const structuredOptions = [
      { label: 'The Deadpan Tone' },
      { label: 'The Satirical Voice' },
    ]

    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        options: structuredOptions,
        send,
      },
      onClose: () => undefined,
    }))

    expect(screen.getByText('Suggestions')).toBeDefined()
    const deadpanBtn = screen.getByRole('button', { name: 'The Deadpan Tone' })
    const satiricalBtn = screen.getByRole('button', { name: 'The Satirical Voice' })
    expect(deadpanBtn).toBeDefined()
    expect(satiricalBtn).toBeDefined()

    // Clicking an option sends its label
    fireEvent.click(deadpanBtn)
    expect(send).toHaveBeenCalledWith('The Deadpan Tone')

    fireEvent.click(satiricalBtn)
    expect(send).toHaveBeenCalledWith('The Satirical Voice')
  })

  it('provides dual handoff actions when foundation is ready and invokes onStartWriting', () => {
    const onStartWriting = vi.fn()
    const onClose = vi.fn()
    const readyChecklist: StorySetupChecklistItem[] = [
      { key: 'starting-point', status: 'covered' as const, note: 'Premise set' },
      { key: 'premise', status: 'covered' as const, note: 'Satire' },
      { key: 'characters', status: 'covered' as const, note: 'Arthur' },
      { key: 'goal', status: 'covered' as const, note: 'Promotion' },
      { key: 'setting', status: 'covered' as const, note: 'Beige' },
      { key: 'voice', status: 'covered' as const, note: 'Deadpan' },
      { key: 'opening', status: 'covered' as const, note: 'Arthur sits down at his beige desk.' },
    ]

    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        checklist: readyChecklist,
      },
      onStartWriting,
      onClose,
    }))

    // Check that both action buttons are rendered in top bar (not duplicated in outline)
    const generateBtn = screen.getByRole('button', { name: 'Generate opening scene' })
    const writeBtn = screen.getByRole('button', { name: 'Start writing' })
    expect(generateBtn).toBeDefined()
    expect(writeBtn).toBeDefined()

    // Clicking generate passes mode: 'generate' and the opening summary
    fireEvent.click(generateBtn)
    expect(onStartWriting).toHaveBeenCalledWith({
      mode: 'generate',
      prompt: 'Arthur sits down at his beige desk.',
    })

    // Clicking write passes mode: 'write' and the opening summary
    fireEvent.click(writeBtn)
    expect(onStartWriting).toHaveBeenCalledWith({
      mode: 'write',
      prompt: 'Arthur sits down at his beige desk.',
    })
  })

  it('does not mutate welcome greeting when draft fragments or covered items arrive', () => {
    const { rerender } = render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        messages: [],
        hasExistingMaterial: false,
        storyTitle: 'The Average Man',
        storyDescription: 'A satire of corporate promotion exams.',
        initialGreeting: 'Welcome to Story Setup for "The Average Man". Starting from your premise—"A satire of corporate promotion exams"—we can explore early directions and characters together, or you can tell me where you\'d like to begin.',
      },
      onClose: () => undefined,
    }))

    expect(screen.getByText(/Welcome to Story Setup for "The Average Man"/i)).toBeDefined()
    expect(screen.queryByText(/This story already has established characters/i)).toBeNull()

    // Rerender with assistant messages and new draft fragments
    rerender(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        messages: [
          { role: 'assistant', content: 'Here are directions for Arthur.' },
        ],
        hasExistingMaterial: false,
        storyTitle: 'The Average Man',
        storyDescription: 'A satire of corporate promotion exams.',
        initialGreeting: 'Welcome to Story Setup for "The Average Man". Starting from your premise—"A satire of corporate promotion exams"—we can explore early directions and characters together, or you can tell me where you\'d like to begin.',
        draftFragments: [
          {
            key: 'ch-arthur',
            type: 'character',
            name: 'Arthur',
            description: 'Protagonist clerk',
            content: 'Arthur works at the ministry.',
          },
        ],
        checklist: [
          { key: 'starting-point', status: 'covered', note: 'Done' },
        ],
      },
      onClose: () => undefined,
    }))

    // Welcome greeting is still the original and has not mutated into the existing story greeting
    expect(screen.getByText(/Welcome to Story Setup for "The Average Man"/i)).toBeDefined()
    expect(screen.queryByText(/This story already has established characters/i)).toBeNull()
  })
})

