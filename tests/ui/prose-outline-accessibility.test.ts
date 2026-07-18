import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { ProseOutlinePanel } from '@/components/prose/ProseOutlinePanel'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Fragment } from '@/lib/api'

const fragments: Fragment[] = [
  {
    id: 'pr-one',
    type: 'prose',
    name: '',
    description: 'Opening',
    content: 'Once upon a time.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
    meta: {},
    archived: false,
  },
  {
    id: 'pr-two',
    type: 'prose',
    name: '',
    description: 'Continuation',
    content: 'The story continued.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 1,
    meta: {},
    archived: false,
  },
]

describe('ProseOutlinePanel accessibility', () => {
  it('names its icon-only outline controls', () => {
    const client = new QueryClient()
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          TooltipProvider,
          null,
          createElement(ProseOutlinePanel, {
            storyId: 'story-one',
            fragments,
            activeIndex: 0,
            open: true,
            onJump: vi.fn(),
          }),
        ),
      ),
    )

    expect(html).toContain('aria-label="Reorder sections"')
    expect(html).toContain('aria-label="Add chapter"')
  })
})
