import React from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { StoryWizard } from '@/components/wizard/StoryWizard'

describe('StoryWizard', () => {
  it('opens as an unstructured story conversation rather than a step form', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const html = renderToString(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(StoryWizard, {
          storyId: 'story-test',
          onComplete: () => undefined,
        }),
      ),
    )

    expect(html).toContain('Shape your story')
    expect(html).toContain('Tell Errata whatever you have')
    expect(html).toContain('Nothing is saved until you create the story')
    expect(html).toContain('Create story')
    expect(html).toContain('Story checklist')
    expect(html).toContain('Starting point')
    expect(html).toContain('What it is about')
    expect(html).toContain('Characters')
    expect(html).toContain('Goal and stakes')
    expect(html).toContain('Setting')
    expect(html).toContain('Voice and tone')
    expect(html).toContain('Opening direction')
    expect(html).toContain('Draft fragments')
    expect(html).toContain('Fragments will appear here as the idea takes shape')
    expect(html).not.toContain('Begin your story')
    expect(html).not.toContain('Step 1 of')
  })
})
