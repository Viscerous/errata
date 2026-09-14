// @vitest-environment jsdom
import React from 'react'
import { renderToString } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractAssistantSuggestions, StoryWizard } from '@/components/wizard/StoryWizard'
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

  describe('extractAssistantSuggestions', () => {
    it('extracts bulleted and numbered bold options while stripping punctuation', () => {
      const text = [
        'Which dynamic feels more comedic?',
        '*   **The Apathetic Wall:** The manager is bored.',
        '*   **The Power Tripper:** The manager treats this as power.',
        '*   **The Mirror:** The manager is also a completionist.',
      ].join('\n')

      expect(extractAssistantSuggestions(text)).toEqual([
        'The Apathetic Wall',
        'The Power Tripper',
        'The Mirror',
      ])

      const numbered = [
        'Which kind of tests should we focus on?',
        '1. **Academic exams**: high stakes',
        '2. **Surreal trials**: dream logic',
      ].join('\n')

      expect(extractAssistantSuggestions(numbered)).toEqual([
        'Academic exams',
        'Surreal trials',
      ])
    })

    it('ignores category recaps and single-item lists', () => {
      const recap = [
        'Here is what we have:',
        '* **Premise:** Office story',
        '* **Characters:** Arthur',
        '* **Tone:** Deadpan',
      ].join('\n')
      expect(extractAssistantSuggestions(recap)).toEqual([])

      const single = '* **Only Option:** Lone option.'
      expect(extractAssistantSuggestions(single)).toEqual([])
    })

    it('ignores sequential steps, exploratory questions, and non-choice lists', () => {
      const sequence = [
        'Here is how the opening scene could progress:',
        '1. **First:** Arthur enters the office.',
        '2. **Next:** He discovers the missing stamp.',
        '3. **Finally:** Henderson confronts him.',
      ].join('\n')
      expect(extractAssistantSuggestions(sequence)).toEqual([])

      const steps = [
        '1. **Step 1:** Establish the floor plan.',
        '2. **Step 2:** Decide the company hierarchy.',
      ].join('\n')
      expect(extractAssistantSuggestions(steps)).toEqual([])

      const questions = [
        'Consider these questions as we explore the setting:',
        '* **Where does Arthur hide his files?**',
        '* **Why does the manager refuse to speak?**',
      ].join('\n')
      expect(extractAssistantSuggestions(questions)).toEqual([])

      const unpromptedInfo = [
        'I have noted these elements of the office:',
        '* **The Fluorescent Lights:** Flickering at 60Hz.',
        '* **The Gray Partition:** Separating Arthur from the window.',
      ].join('\n')
      expect(extractAssistantSuggestions(unpromptedInfo)).toEqual([])
    })
  })

  it('renders suggestion buttons for assistant options and sends clicked option', () => {
    const send = vi.fn()
    const content = [
      'What kind of voice do you envision?',
      '* **The Deadpan Observer:** Dry and satirical.',
      '* **The Earnest Professional:** First-person and oblivious.',
      '* **The HR File:** Memos and reports.',
    ].join('\n')

    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        messages: [
          { role: 'user', content: 'Let us figure out the voice.' },
          { role: 'assistant', content },
        ],
        send,
      },
      onClose: () => undefined,
    }))

    expect(screen.getByText('Suggestions')).toBeDefined()
    const earnestBtn = screen.getByRole('button', { name: 'The Earnest Professional' })
    expect(earnestBtn).toBeDefined()
    fireEvent.click(earnestBtn)
    expect(send).toHaveBeenCalledWith('The Earnest Professional')
  })

  it('renders structured controller options with descriptions and dispatches selection on click', () => {
    const send = vi.fn()
    const structuredOptions = [
      { label: 'The Deadpan Tone', description: 'Third-person limited, dry British humor', value: 'Deadpan tone with dry wit' },
      { label: 'The Satirical Voice', description: 'Institutional absurdity and memos' },
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
    expect(screen.getByText('The Deadpan Tone')).toBeDefined()
    expect(screen.getByText('Third-person limited, dry British humor')).toBeDefined()
    expect(screen.getByText('The Satirical Voice')).toBeDefined()
    expect(screen.getByText('Institutional absurdity and memos')).toBeDefined()

    // Clicking an option with a value sends that value
    fireEvent.click(screen.getByRole('button', { name: /The Deadpan Tone/ }))
    expect(send).toHaveBeenCalledWith('Deadpan tone with dry wit')

    // Clicking an option without a value sends the label
    fireEvent.click(screen.getByRole('button', { name: /The Satirical Voice/ }))
    expect(send).toHaveBeenCalledWith('The Satirical Voice')
  })

  it('prefers structured controller options over regex-scraped assistant suggestions', () => {
    const send = vi.fn()
    const content = [
      'Here are markdown suggestions:',
      '* **Markdown One:** Old regex option.',
      '* **Markdown Two:** Another old regex option.',
    ].join('\n')

    render(React.createElement(StoryWizard, {
      controller: {
        ...controller,
        messages: [
          { role: 'assistant', content },
        ],
        options: [
          { label: 'Structured One', description: 'Explicit model choice' },
        ],
        send,
      },
      onClose: () => undefined,
    }))

    expect(screen.getByText('Structured One')).toBeDefined()
    expect(screen.getByText('Explicit model choice')).toBeDefined()
    expect(screen.queryByText('Markdown One')).toBeNull()
    expect(screen.queryByText('Markdown Two')).toBeNull()
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

    // Check that both action buttons are rendered
    const generateBtns = screen.getAllByRole('button', { name: 'Generate opening scene' })
    const writeBtns = screen.getAllByRole('button', { name: 'Write in manuscript' })
    expect(generateBtns.length).toBeGreaterThanOrEqual(1)
    expect(writeBtns.length).toBeGreaterThanOrEqual(1)

    // Clicking generate passes mode: 'generate' and the opening summary
    fireEvent.click(generateBtns[0])
    expect(onStartWriting).toHaveBeenCalledWith({
      mode: 'generate',
      prompt: 'Arthur sits down at his beige desk.',
    })

    // Clicking write passes mode: 'write' and the opening summary
    fireEvent.click(writeBtns[0])
    expect(onStartWriting).toHaveBeenCalledWith({
      mode: 'write',
      prompt: 'Arthur sits down at his beige desk.',
    })
  })
})

