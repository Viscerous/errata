import { describe, expect, it } from 'vitest'
import { normalizeContinuityKey } from '@/lib/continuity-keys'

describe('continuity key normalization', () => {
  // Every key below is verbatim from the Timeline 9 dev run, where seven
  // knowledge operations produced seven distinct keys and no reuse at all.
  it('strips the fabricated fragment-id prefix the model invents', () => {
    expect(normalizeContinuityKey('ch-zinozi|mpamba_view_of_her')).toBe('mpamba_view_of_her')
    expect(normalizeContinuityKey('kn-zinozi|high-priestess-role')).toBe('high_priestess_role')
    expect(normalizeContinuityKey('kn-zinozi|taking-of-breath-nature')).toBe('taking_of_breath_nature')
  })

  it('collapses the two id prefixes the model alternated for one character', () => {
    expect(normalizeContinuityKey('ch-zinozi|mpamba_view_of_her'))
      .toBe(normalizeContinuityKey('kn-zinozi|mpamba_view_of_her'))
  })

  it('only strips a delimited id prefix, so a key may still begin with a word like kn', () => {
    expect(normalizeContinuityKey('ch-zinozi|kn-bright-ground-meaning')).toBe('kn_bright_ground_meaning')
    expect(normalizeContinuityKey('knife_location')).toBe('knife_location')
  })

  it('unifies separator drift within a single run', () => {
    expect(normalizeContinuityKey('victoria_trial-of-two-grounds')).toBe('victoria_trial_of_two_grounds')
    expect(normalizeContinuityKey('Victoria Trial Of Two Grounds')).toBe('victoria_trial_of_two_grounds')
  })

  it('leaves an already-canonical key untouched', () => {
    expect(normalizeContinuityKey('mpamba_outreach_status')).toBe('mpamba_outreach_status')
    expect(normalizeContinuityKey('victoria_physical_condition')).toBe('victoria_physical_condition')
  })

  // Timeline 11 accepted a literal `_` as a thread key, because the 12B put the
  // real key in `label`. The live registry becomes a closed enum in the tool
  // schema, so `_` then became the only thread key the model was permitted to
  // reuse for the remainder of the timeline.
  it('rejects a key carrying no identity rather than admitting it to the registry', () => {
    expect(normalizeContinuityKey('_')).toBe('')
    expect(normalizeContinuityKey('|||')).toBe('')
    expect(normalizeContinuityKey('   ')).toBe('')
    expect(normalizeContinuityKey('  ch-abcdef|  ')).toBe('')
  })
})
