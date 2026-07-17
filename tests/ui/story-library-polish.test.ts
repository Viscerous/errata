import { describe, expect, it } from 'vitest'

import { getStoryDisplayName } from '../../src/lib/story-display'

describe('story library display names', () => {
  it('keeps a meaningful story name', () => {
    expect(getStoryDisplayName('  The Long Road  ')).toBe('The Long Road')
  })

  it('gives unnamed stories a readable fallback', () => {
    expect(getStoryDisplayName('')).toBe('Untitled story')
    expect(getStoryDisplayName('   ')).toBe('Untitled story')
  })
})
