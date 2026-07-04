import { describe, expect, it } from 'vitest'
import { fieldRewriteExcerpt, spanDiffExcerpt } from '@/server/fragments/change-operations'
import { diffRows, diffWords } from '@/lib/diff'

describe('spanDiffExcerpt', () => {
  it('gives before/after identical surrounding context so only the span differs', () => {
    const prefix = 'Elias Thorne is a '
    const suffix = ' fisherman who distrusts the harbor guild.'
    const { before, after } = spanDiffExcerpt(prefix, 'wary', 'guarded', suffix)

    expect(before).toBe('Elias Thorne is a wary fisherman who distrusts the harbor guild.')
    expect(after).toBe('Elias Thorne is a guarded fisherman who distrusts the harbor guild.')

    // The client word diff over these excerpts flags only the replaced span.
    const segs = diffWords(before, after)
    expect(segs.filter((s) => s.type === 'remove').map((s) => s.text)).toEqual(['wary'])
    expect(segs.filter((s) => s.type === 'add').map((s) => s.text)).toEqual(['guarded'])
  })

  it('adds matching ellipsis markers when context is trimmed on both sides', () => {
    const prefix = `${'a'.repeat(300)}X`
    const suffix = `Y${'b'.repeat(300)}`
    const { before, after } = spanDiffExcerpt(prefix, 'old', 'new', suffix, 10)

    expect(before.startsWith('...')).toBe(true)
    expect(after.startsWith('...')).toBe(true)
    expect(before.endsWith('...')).toBe(true)
    expect(after.endsWith('...')).toBe(true)
    // Same lead/tail on both sides — the only difference is old → new.
    expect(before.replace('old', '')).toBe(after.replace('new', ''))
  })
})

describe('fieldRewriteExcerpt', () => {
  it('surfaces a paragraph appended past the truncation window', () => {
    // Reproduces the Iris Bakker set_fields rewrite: a long field gains a final
    // paragraph well beyond char 900, where naive truncation showed nothing.
    const body = 'Sentence number '.repeat(120).trim() // ~1900 chars
    const before = body
    const after = `${body}\n\nWhile she functions as Victoria's envelope, she is susceptible to private intensity.`

    const excerpt = fieldRewriteExcerpt(before, after)
    expect(excerpt.before).not.toBe(excerpt.after)

    const rows = diffRows(excerpt.before, excerpt.after)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.type === 'add' && r.text.includes('susceptible to private intensity'))).toBe(true)
  })

  it('reports no change when the field is unchanged', () => {
    const body = 'unchanged content here'
    const excerpt = fieldRewriteExcerpt(body, body)
    expect(diffRows(excerpt.before, excerpt.after)).toEqual([])
  })

  it('centers on a mid-field edit rather than the start', () => {
    const head = 'A'.repeat(500)
    const tail = 'B'.repeat(500)
    const excerpt = fieldRewriteExcerpt(`${head} wary ${tail}`, `${head} guarded ${tail}`)
    const rows = diffRows(excerpt.before, excerpt.after)
    const modify = rows.find((r) => r.type === 'modify')
    expect(modify && modify.type === 'modify' ? modify.segments : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'remove', text: 'wary' }),
        expect.objectContaining({ type: 'add', text: 'guarded' }),
      ]),
    )
  })
})
