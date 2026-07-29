import { describe, it, expect } from 'vitest'
import { generateFragmentId, PREFIXES } from '@/lib/fragment-ids'

describe('generateFragmentId', () => {
  it('generates IDs with correct prefix for each built-in type', () => {
    expect(generateFragmentId('prose')).toMatch(/^pr-[a-z0-9]{6}$/)
    expect(generateFragmentId('character')).toMatch(/^ch-[a-z0-9]{6}$/)
    expect(generateFragmentId('guideline')).toMatch(/^gl-[a-z0-9]{6}$/)
    expect(generateFragmentId('knowledge')).toMatch(/^kn-[a-z0-9]{6}$/)
    expect(generateFragmentId('image')).toMatch(/^im-[a-z0-9]{6}$/)
    expect(generateFragmentId('icon')).toMatch(/^ic-[a-z0-9]{6}$/)
  })

  /**
   * Draws from the whole suffix space rather than asserting a sample came back
   * collision-free. The IDs are consonant-vowel alternating for pronounceability,
   * so the space is 13^3 * 5^3 = 274,625 — not 36^6. A sample of 100 collides on
   * about 1 run in 55 (birthday: 1 - e^(-100*99/2*274625)), which this test used
   * to call "extremely unlikely" and fail on intermittently.
   *
   * Callers must not assume uniqueness from generation alone: a space this size
   * needs a collision check per creation, which `createFragment` enforces by
   * refusing to overwrite.
   */
  it('draws suffixes spread across the available space', () => {
    const ids = Array.from({ length: 2000 }, () => generateFragmentId('prose'))

    expect(ids.every(id => /^pr-[bdfgkmnprstvz][aeiou][bdfgkmnprstvz][aeiou][bdfgkmnprstvz][aeiou]$/.test(id))).toBe(true)
    // Every position must vary; a pool stuck on one character would still satisfy
    // the format above while collapsing the space.
    for (let position = 0; position < 6; position++) {
      const distinct = new Set(ids.map(id => id.slice(3)[position]))
      expect(distinct.size, `position ${position} should vary`).toBe(position % 2 === 0 ? 13 : 5)
    }
    // Loose upper bound on duplicates: ~7 expected at this sample size, so 60 is
    // unreachable by chance yet still catches a badly narrowed space.
    expect(ids.length - new Set(ids).size).toBeLessThan(60)
  })

  it('falls back to first 4 chars for unknown types', () => {
    const id = generateFragmentId('custom')
    expect(id).toMatch(/^cust-[a-z0-9]{6}$/)
  })
})

describe('PREFIXES', () => {
  it('has entries for all built-in types', () => {
    expect(PREFIXES.prose).toBe('pr')
    expect(PREFIXES.character).toBe('ch')
    expect(PREFIXES.guideline).toBe('gl')
    expect(PREFIXES.knowledge).toBe('kn')
    expect(PREFIXES.image).toBe('im')
    expect(PREFIXES.icon).toBe('ic')
  })
})
