import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import {
  createStory,
  createFragment,
  getFragment,
  generateUnusedFragmentId,
} from '@/server/fragments/storage'
import { applyOperations } from '@/server/fragments/change-operations'
import * as fragmentIds from '@/lib/fragment-ids'

/**
 * Fragment id suffixes alternate consonants and vowels to stay pronounceable, so
 * the space is 13^3 * 5^3 = 274,625 per type — small enough that a fresh id can
 * already be taken, with the odds rising as a story grows. `createFragment`
 * refuses to overwrite, so an unchecked id makes a collision fail the write.
 */
describe('generateUnusedFragmentId', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  const storyId = 'story-collide'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    const now = new Date().toISOString()
    await createStory(dataDir, {
      id: storyId,
      name: 'Collide',
      description: '',
      coverImage: null,
      createdAt: now,
      updatedAt: now,
      settings: makeTestSettings(),
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup()
  })

  async function seed(id: string) {
    await createFragment(dataDir, storyId, {
      id, type: 'knowledge', name: id, description: '', content: '',
      tags: [], refs: [], sticky: false, placement: 'user',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      order: 0, meta: {}, archived: false, version: 1, versions: [],
    } as never)
  }

  it('skips an id that is already taken', async () => {
    await seed('kn-babebi')
    // First draw collides, second is free.
    const spy = vi.spyOn(fragmentIds, 'generateFragmentId')
      .mockReturnValueOnce('kn-babebi')
      .mockReturnValueOnce('kn-bobubi')

    const id = await generateUnusedFragmentId(dataDir, storyId, 'knowledge')

    expect(id).not.toBe('kn-babebi')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('gives up rather than looping forever', async () => {
    await seed('kn-babebi')
    vi.spyOn(fragmentIds, 'generateFragmentId').mockReturnValue('kn-babebi')

    await expect(generateUnusedFragmentId(dataDir, storyId, 'knowledge', 3))
      .rejects.toThrow(/after 3 attempts/)
  })

  it('lets the librarian create a fragment whose first id was taken', async () => {
    await seed('kn-babebi')
    vi.spyOn(fragmentIds, 'generateFragmentId')
      .mockReturnValueOnce('kn-babebi')
      .mockReturnValueOnce('kn-dodedi')

    const result = await applyOperations(dataDir, storyId, [{
      action: 'create_fragment',
      type: 'knowledge',
      name: 'The Cyprian Society',
      description: 'A society that notices things.',
      content: 'Members keep each other honest by keeping each other watched.',
      reason: 'introduced in the passage',
    }] as never)

    expect(result.map(entry => entry.status), JSON.stringify(result, null, 2)).toEqual(['applied'])
    expect(await getFragment(dataDir, storyId, 'kn-dodedi')).toBeTruthy()
    // The pre-existing fragment is untouched.
    expect((await getFragment(dataDir, storyId, 'kn-babebi'))?.name).toBe('kn-babebi')
  })
})
