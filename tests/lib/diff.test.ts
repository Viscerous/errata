import { describe, expect, it } from 'vitest'
import { collapseContext, diffLines, diffRows, diffWords, hasChanges, type DiffRow, type WordSegment } from '@/lib/diff'

describe('diffLines', () => {
  it('marks identical content as all context', () => {
    const ops = diffLines('A\nB\nC', 'A\nB\nC')
    expect(hasChanges(ops)).toBe(false)
    expect(ops.map((o) => o.type)).toEqual(['context', 'context', 'context'])
  })

  it('reports a single inserted line as one add, not a cascade', () => {
    // The old positional diff would flag every line after the insertion as changed.
    const ops = diffLines('A\nB\nC', 'A\nNEW\nB\nC')
    expect(ops).toEqual([
      { type: 'context', text: 'A' },
      { type: 'add', text: 'NEW' },
      { type: 'context', text: 'B' },
      { type: 'context', text: 'C' },
    ])
  })

  it('reports a single deleted line as one remove', () => {
    const ops = diffLines('A\nB\nC', 'A\nC')
    expect(ops).toEqual([
      { type: 'context', text: 'A' },
      { type: 'remove', text: 'B' },
      { type: 'context', text: 'C' },
    ])
  })

  it('aligns a replacement as remove followed by add', () => {
    const ops = diffLines('Line 1\nold\nLine 3', 'Line 1\nnew\nLine 3')
    expect(ops.filter((o) => o.type === 'remove').map((o) => o.text)).toEqual(['old'])
    expect(ops.filter((o) => o.type === 'add').map((o) => o.text)).toEqual(['new'])
  })

  it('handles empty sides', () => {
    expect(diffLines('', '')).toEqual([])
    expect(diffLines('', 'X').map((o) => o.type)).toEqual(['add'])
    expect(diffLines('X', '').map((o) => o.type)).toEqual(['remove'])
  })
})

describe('diffWords', () => {
  it('highlights only the changed words within a paragraph', () => {
    const before = 'Elias is wary of strangers and speaks softly.'
    const after = 'Elias is guarded around strangers and speaks softly.'
    const segs = diffWords(before, after)
    // Reconstructing each side from the segments returns the originals.
    expect(segs.filter((s) => s.type !== 'add').map((s) => s.text).join('')).toBe(before)
    expect(segs.filter((s) => s.type !== 'remove').map((s) => s.text).join('')).toBe(after)
    // The unchanged tail is context, not repainted.
    expect(segs.some((s) => s.type === 'context' && s.text === 'strangers')).toBe(true)
    expect(segs.filter((s) => s.type === 'remove').map((s) => s.text)).toContain('wary')
    expect(segs.filter((s) => s.type === 'add').map((s) => s.text)).toContain('guarded')
  })
})

describe('diffRows word-level pairing', () => {
  const modifySegments = (rows: DiffRow[]): WordSegment[] | undefined => {
    const modify = rows.find((r) => r.type === 'modify')
    return modify && modify.type === 'modify' ? modify.segments : undefined
  }

  it('pairs an edited paragraph into an inline modify row', () => {
    const before = 'Elias Thorne is a wary fisherman who distrusts the harbor guild.'
    const after = 'Elias Thorne is a guarded fisherman who distrusts the harbor guild.'
    const rows = diffRows(before, after)
    const segs = modifySegments(rows)
    expect(segs).toBeDefined()
    expect(segs!.filter((s) => s.type === 'remove').map((s) => s.text)).toContain('wary')
    expect(segs!.filter((s) => s.type === 'add').map((s) => s.text)).toContain('guarded')
    // No standalone whole-line remove/add for the edited paragraph.
    expect(rows.some((r) => r.type === 'remove')).toBe(false)
    expect(rows.some((r) => r.type === 'add')).toBe(false)
  })

  it('keeps dissimilar paragraphs as separate remove/add lines, not confetti', () => {
    const before = 'The tide came in quietly before dawn.'
    const after = 'A dragon razed three villages overnight.'
    const rows = diffRows(before, after)
    expect(modifySegments(rows)).toBeUndefined()
    expect(rows.some((r) => r.type === 'remove')).toBe(true)
    expect(rows.some((r) => r.type === 'add')).toBe(true)
  })
})

describe('collapseContext', () => {
  it('returns nothing when there are no changes', () => {
    expect(collapseContext(diffLines('A\nB', 'A\nB'))).toEqual([])
  })

  it('collapses long unchanged runs into a gap, keeping context around changes', () => {
    const before = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n')
    const after = before.replace('L10', 'CHANGED')
    const rows = diffRows(before, after, 2)

    const gaps = rows.filter((r) => r.type === 'gap')
    expect(gaps).toHaveLength(2) // leading run before the change, trailing run after
    // Change plus 2 lines of context on each side is preserved verbatim.
    expect(rows.some((r) => r.type === 'remove' && r.text === 'L10')).toBe(true)
    expect(rows.some((r) => r.type === 'add' && r.text === 'CHANGED')).toBe(true)
    expect(rows.some((r) => r.type === 'context' && r.text === 'L8')).toBe(true)
    expect(rows.some((r) => r.type === 'context' && r.text === 'L12')).toBe(true)
    // A line far from the change is hidden inside a gap.
    expect(rows.some((r) => r.type === 'context' && r.text === 'L0')).toBe(false)
  })
})
