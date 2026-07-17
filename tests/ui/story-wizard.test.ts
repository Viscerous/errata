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
    expect(html).not.toContain('Begin your story')
    expect(html).not.toContain('Step 1 of')
  })
})
