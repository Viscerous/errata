import React from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { ConfirmProvider } from '@/components/ui/confirm-dialog'
import { TimelineTabs } from '@/components/prose/TimelineTabs'

describe('TimelineTabs', () => {
  it('keeps timeline actions without a competing visibility button', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToString(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          ConfirmProvider,
          null,
          React.createElement(TimelineTabs, {
            storyId: 'story-test',
            branches: [
              { id: 'main', name: 'Main', order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
              { id: 'branch', name: 'Branch', order: 1, parentBranchId: 'main', createdAt: '2026-01-01T00:00:00.000Z' },
            ],
            activeBranchId: 'main',
            rootBranchId: 'main',
          }),
        ),
      ),
    )

    expect(html).toContain('data-component-id="timeline-tab-main"')
    expect(html).toContain('data-component-id="timeline-tab-branch"')
    expect(html).toContain('data-component-id="timeline-create-button"')
    expect(html).not.toContain('timeline-hide-button')
  })
})
