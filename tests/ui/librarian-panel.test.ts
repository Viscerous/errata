import { describe, expect, it } from 'vitest'
import { computeLineDiff } from '@/components/sidebar/LibrarianPanel'

describe('computeLineDiff', () => {
  it('handles completely identical strings', () => {
    const before = 'This is line 1\nThis is line 2'
    const after = 'This is line 1\nThis is line 2'
    const diff = computeLineDiff(before, after)
    expect(diff.beforeLines).toEqual([])
    expect(diff.afterLines).toEqual([])
  })

  it('detects simple line replacements and filters identical context', () => {
    const before = 'Line 1\nLine 2 (old)\nLine 3'
    const after = 'Line 1\nLine 2 (new)\nLine 3'
    const diff = computeLineDiff(before, after)
    expect(diff.beforeLines).toEqual(['Line 2 (old)'])
    expect(diff.afterLines).toEqual(['Line 2 (new)'])
  })

  it('handles empty inputs', () => {
    const diff = computeLineDiff('', '')
    expect(diff.beforeLines).toEqual([])
    expect(diff.afterLines).toEqual([])
  })

  it('handles text insertion (before is empty)', () => {
    const diff = computeLineDiff('', 'Line 1\nLine 2')
    expect(diff.beforeLines).toEqual([])
    expect(diff.afterLines).toEqual(['Line 1', 'Line 2'])
  })

  it('handles text removal (after is empty)', () => {
    const diff = computeLineDiff('Line 1\nLine 2', '')
    expect(diff.beforeLines).toEqual(['Line 1', 'Line 2'])
    expect(diff.afterLines).toEqual([])
  })

  it('handles alignment when newlines are added', () => {
    const before = 'A\nB\nC'
    const after = 'A\nB\nD\nC'
    const diff = computeLineDiff(before, after)
    expect(diff.beforeLines).toEqual([])
    expect(diff.afterLines).toEqual(['D'])
  })
})
