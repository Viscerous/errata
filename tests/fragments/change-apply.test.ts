import { describe, it, expect, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory, createFragment, getFragment, updateFragmentVersioned } from '@/server/fragments/storage'
import { applyOperationsWithSnapshot, revertAppliedChanges, RevertConflictError } from '@/server/fragments/change-apply'
import type { StoryMeta, Fragment } from '@/server/fragments/schema'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-ca',
    name: 'Story',
    description: '',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeFragment(overrides: Partial<Fragment> = {}): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'ch-0001',
    type: 'character',
    name: 'Alice',
    description: 'A guard',
    content: 'Alice serves the guard.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    archived: false,
    version: 1,
    versions: [],
    ...overrides,
  }
}

describe('applyOperationsWithSnapshot + revertAppliedChanges', () => {
  let cleanup: (() => Promise<void>) | undefined
  const storyId = 'story-ca'

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  async function setup() {
    const tmp = await createTempDir()
    cleanup = tmp.cleanup
    await createStory(tmp.path, makeStory())
    return tmp.path
  }

  it('captures a snapshot that reverts an edit back to its pre-apply state', async () => {
    const dataDir = await setup()
    await createFragment(dataDir, storyId, makeFragment())

    const { appliedChanges } = await applyOperationsWithSnapshot(dataDir, storyId, [
      { action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'serves the guard', newText: 'left the guard', replaceAll: false },
    ])
    expect((await getFragment(dataDir, storyId, 'ch-0001'))?.content).toBe('Alice left the guard.')

    const result = await revertAppliedChanges(dataDir, storyId, appliedChanges)
    expect(result.updatedFragmentIds).toEqual(['ch-0001'])
    expect((await getFragment(dataDir, storyId, 'ch-0001'))?.content).toBe('Alice serves the guard.')
  })

  it('archives a created fragment on revert', async () => {
    const dataDir = await setup()

    const { appliedChanges } = await applyOperationsWithSnapshot(dataDir, storyId, [
      { action: 'create_fragment', type: 'knowledge', name: 'Lore', description: 'A fact', content: 'The sky is blue.' },
    ])
    const createdId = appliedChanges[0].fragmentId
    expect((await getFragment(dataDir, storyId, createdId))?.archived).toBe(false)

    await revertAppliedChanges(dataDir, storyId, appliedChanges)
    expect((await getFragment(dataDir, storyId, createdId))?.archived).toBe(true)
  })

  it('refuses to revert when the fragment changed since it was applied', async () => {
    const dataDir = await setup()
    await createFragment(dataDir, storyId, makeFragment())

    const { appliedChanges } = await applyOperationsWithSnapshot(dataDir, storyId, [
      { action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'serves the guard', newText: 'left the guard', replaceAll: false },
    ])

    // A hand-edit after the apply moves the baseHash off the recorded snapshot.
    await updateFragmentVersioned(dataDir, storyId, 'ch-0001', { content: 'Alice retired entirely.' }, { reason: 'manual' })

    await expect(revertAppliedChanges(dataDir, storyId, appliedChanges)).rejects.toBeInstanceOf(RevertConflictError)
    // The hand-edit is preserved, not clobbered.
    expect((await getFragment(dataDir, storyId, 'ch-0001'))?.content).toBe('Alice retired entirely.')
  })

  it('is idempotent when the change is already back at its pre-apply values', async () => {
    const dataDir = await setup()
    await createFragment(dataDir, storyId, makeFragment())

    const { appliedChanges } = await applyOperationsWithSnapshot(dataDir, storyId, [
      { action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'serves the guard', newText: 'left the guard', replaceAll: false },
    ])

    await revertAppliedChanges(dataDir, storyId, appliedChanges)
    // Reverting again is a no-op skip, not a conflict.
    const second = await revertAppliedChanges(dataDir, storyId, appliedChanges)
    expect(second.revertResults[0].status).toBe('skipped')
    expect((await getFragment(dataDir, storyId, 'ch-0001'))?.content).toBe('Alice serves the guard.')
  })
})
