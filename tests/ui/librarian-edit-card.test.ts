import { describe, it, expect } from 'vitest'
import { isAppliedEditResult, collectChanges } from '@/components/chat/LibrarianEditCard'

describe('isAppliedEditResult', () => {
  it('accepts a result with at least one applied operation', () => {
    expect(isAppliedEditResult({ operations: [{ action: 'set_fields', status: 'applied' }] })).toBe(true)
  })

  it('rejects a propose result where nothing was applied', () => {
    expect(isAppliedEditResult({ operations: [{ action: 'set_fields', status: 'valid' }] })).toBe(false)
  })

  it('rejects non-apply shapes', () => {
    expect(isAppliedEditResult(null)).toBe(false)
    expect(isAppliedEditResult({ ok: true })).toBe(false)
    expect(isAppliedEditResult('done')).toBe(false)
  })
})

describe('collectChanges', () => {
  it('classifies edit, create, and archive verbs and inverse intent', () => {
    const changes = collectChanges([
      { action: 'set_fields', status: 'applied', target: { fragmentId: 'ch-abc' }, diffs: [{ field: 'content', before: 'a', after: 'b' }] },
      { action: 'create_fragment', status: 'applied', createdFragmentId: 'kn-new', diffs: [{ field: 'content', before: '', after: 'fresh' }] },
      { action: 'archive_fragment', status: 'applied', target: { fragmentId: 'gd-old' } },
    ])
    expect(changes.map((c) => [c.fragmentId, c.verb, c.created])).toEqual([
      ['ch-abc', 'edited', false],
      ['kn-new', 'created', true],
      ['gd-old', 'archived', false],
    ])
  })

  it('collapses multiple applied ops on one fragment into a single entry with merged diffs', () => {
    const changes = collectChanges([
      { action: 'replace_text', status: 'applied', target: { fragmentId: 'ch-abc' }, diffs: [{ field: 'content', before: 'x', after: 'y' }] },
      { action: 'replace_text', status: 'applied', target: { fragmentId: 'ch-abc' }, diffs: [{ field: 'content', before: 'm', after: 'n' }] },
    ])
    expect(changes).toHaveLength(1)
    expect(changes[0].fragmentId).toBe('ch-abc')
    expect(changes[0].diffs).toHaveLength(2)
  })

  it('ignores operations that were not applied', () => {
    const changes = collectChanges([
      { action: 'set_fields', status: 'invalid', target: { fragmentId: 'ch-bad' } },
      { action: 'set_fields', status: 'applied', target: { fragmentId: 'ch-ok' }, diffs: [{ field: 'name', before: 'p', after: 'q' }] },
    ])
    expect(changes.map((c) => c.fragmentId)).toEqual(['ch-ok'])
  })
})
