import React from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
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
  it('opens as an unstructured story conversation rather than a step form', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const html = renderToString(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(StoryWizard, { controller, onComplete: () => undefined }),
      ),
    )

    expect(html).toContain('Shape your story')
    expect(html).toContain('Tell Errata whatever you have')
    expect(html).toContain('Fragments are saved as the conversation develops')
    expect(html).toContain('Open story')
    expect(html).toContain('Story checklist')
    expect(html).toContain('explored')
    expect(html).toContain('existing story material')
    expect(html).toContain('Starting point')
    expect(html).toContain('What it is about')
    expect(html).toContain('Characters')
    expect(html).toContain('Goal and stakes')
    expect(html).toContain('Setting')
    expect(html).toContain('Voice and tone')
    expect(html).toContain('Opening direction')
    expect(html).toContain('Story fragments')
    expect(html).toContain('Fragments will appear here as the idea takes shape')
    expect(html).toContain('data-component-id="story-setup-composer-column"')
    expect(html).not.toContain('Begin your story')
    expect(html).not.toContain('Step 1 of')
    expect(html).not.toContain('Create story')
  })
})
