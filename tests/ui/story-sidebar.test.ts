import React from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children),
}))

import { HelpProvider } from '@/hooks/use-help'
import { SidebarProvider } from '@/components/ui/sidebar'
import { StorySidebar } from '@/components/sidebar/StorySidebar'

describe('StorySidebar', () => {
  beforeAll(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  })

  it('keeps story setup directly available after the wizard closes', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToString(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          HelpProvider,
          null,
          React.createElement(
            SidebarProvider,
            null,
            React.createElement(StorySidebar, {
              storyId: 'story-test',
              story: undefined,
              activeSection: null,
              onSectionChange: () => undefined,
              onLaunchWizard: () => undefined,
              enabledPanelPlugins: [],
            }),
          ),
        ),
      ),
    )

    expect(html).toContain('Story setup')
    expect(html).toContain('data-component-id="sidebar-story-setup"')
  })
})
