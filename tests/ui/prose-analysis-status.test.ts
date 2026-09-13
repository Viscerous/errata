// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProseBlock } from '@/components/prose/ProseBlock'
import { ConfirmProvider } from '@/components/ui/confirm-dialog'
import type { Fragment } from '@/lib/api'

const fragment: Fragment = {
  id: 'pr-one',
  type: 'prose',
  name: '',
  description: 'A prompt',
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
}

function renderBlock(hasAnalysis: boolean, analysisWarning?: string, shownFragment: Fragment = fragment) {
  const onAnalyze = vi.fn()
  const result = render(
    createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(ConfirmProvider, null,
        createElement(ProseBlock, {
          storyId: 'story-one',
          fragment: shownFragment,
          displayIndex: 0,
          sectionIndex: 0,
          chainEntry: null,
          isLast: true,
          onSelect: vi.fn(),
          onAnalyze,
          hasAnalysis,
          analysisWarning,
          quickSwitch: false,
        }),
      ),
    ),
  )
  return { ...result, onAnalyze }
}

describe('prose analysis status', () => {
  afterEach(cleanup)

  it('labels the reroll field as a protagonist move for Play passages', () => {
    const playFragment: Fragment = {
      ...fragment,
      description: 'I raise my hand. "Wait," I say.',
      meta: { generatedFrom: 'I raise my hand. "Wait," I say.', generatedFromMode: 'play' },
    }
    renderBlock(false, undefined, playFragment)
    fireEvent.click(screen.getByTitle('Click to edit protagonist move and regenerate'))
    expect(screen.getByPlaceholderText('Edit protagonist move...')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reroll move' })).toBeTruthy()
  })

  it('leaves a completed passage unmarked and offers Re-analyze', () => {
    const { container } = renderBlock(true)
    expect(container.querySelector('[data-component-id="prose-pr-one-analysis-status"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-component-id="prose-pr-one-select"]')!)
    expect(screen.getByRole('button', { name: 'Re-analyze' })).toBeTruthy()
  })

  it('leaves a never-attempted passage unmarked and offers Analyze', () => {
    const { container } = renderBlock(false)
    expect(container.querySelector('[data-component-id="prose-pr-one-analysis-status"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-component-id="prose-pr-one-select"]')!)
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeTruthy()
  })

  it.each([false, true])('marks an incomplete passage and offers Retry analysis (saved analysis: %s)', (hasAnalysis) => {
    const { container, onAnalyze } = renderBlock(hasAnalysis, 'LLM failed')
    const status = container.querySelector('[data-component-id="prose-pr-one-analysis-status"]')
    expect(status?.getAttribute('aria-label')).toBe('Retry incomplete analysis')
    expect(status?.getAttribute('title')).toContain('LLM failed')
    fireEvent.click(status!)
    expect(onAnalyze).toHaveBeenCalledWith('pr-one')
    fireEvent.click(container.querySelector('[data-component-id="prose-pr-one-select"]')!)
    expect(screen.getByRole('button', { name: 'Retry analysis' })).toBeTruthy()
  })
})
