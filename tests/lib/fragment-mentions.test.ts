import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildAnnotationHighlighter } from '@/lib/fragment-mentions'

function collectHighlightedText(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(collectHighlightedText)
  if (!isValidElement(node)) return []
  return [String((node.props as { children?: ReactNode }).children ?? '')]
}

describe('fragment mention highlighting', () => {
  it('matches punctuated knowledge terms without matching inside longer words', () => {
    const transform = buildAnnotationHighlighter([
      { type: 'mention', fragmentId: 'kn-001', text: 'C++' },
      { type: 'mention', fragmentId: 'kn-002', text: '#13' },
    ], vi.fn())

    expect(transform).not.toBeNull()
    const result = transform!('C++ and #13 matter; C++17 is separate.')

    expect(collectHighlightedText(result)).toEqual(['C++', '#13'])
  })

  it('ignores empty mention terms', () => {
    const transform = buildAnnotationHighlighter([
      { type: 'mention', fragmentId: 'kn-001', text: '' },
    ], vi.fn())

    expect(transform).toBeNull()
  })
})
