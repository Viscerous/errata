import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import {
  createStory,
  getStory,
  listStories,
  updateStory,
  deleteStory,
  createFragment,
  getFragment,
  listFragments,
  updateFragment,
  updateFragmentVersioned,
  deleteFragment,
  archiveFragment,
  restoreFragment,
  listFragmentVersions,
  revertFragmentToVersion,
  deleteFragmentVersion,
} from '@/server/fragments/storage'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'

let dataDir: string
let cleanup: () => Promise<void>

beforeEach(async () => {
  const tmp = await createTempDir()
  dataDir = tmp.path
  cleanup = tmp.cleanup
})

afterEach(async () => {
  await cleanup()
})

const makeStory = (overrides: Partial<StoryMeta> = {}): StoryMeta => ({
  id: 'story-1',
  name: 'Test Story',
  description: 'A test story',
    coverImage: null,
  summary: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  settings: makeTestSettings(),
  ...overrides,
})

const makeFragment = (overrides: Partial<Fragment> = {}): Fragment => ({
  id: 'pr-a1b2',
  type: 'prose',
  name: 'Opening',
  description: 'The story begins',
  content: 'It was a dark and stormy night...',
  tags: [],
  refs: [],
  sticky: false,
  placement: 'user' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  order: 0,
  meta: {},
  ...overrides,
})

describe('Story CRUD', () => {
  it('creates and retrieves a story', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const retrieved = await getStory(dataDir, story.id)
    expect(retrieved).toEqual(story)
  })

  it('lists all stories', async () => {
    await createStory(dataDir, makeStory({ id: 'story-1' }))
    await createStory(dataDir, makeStory({ id: 'story-2', name: 'Second' }))
    const stories = await listStories(dataDir)
    expect(stories).toHaveLength(2)
    expect(stories.map((s) => s.id).sort()).toEqual(['story-1', 'story-2'])
  })

  it('updates a story', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const updated = { ...story, name: 'Updated Name' }
    await updateStory(dataDir, updated)
    const retrieved = await getStory(dataDir, story.id)
    expect(retrieved!.name).toBe('Updated Name')
  })

  it('deletes a story', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await deleteStory(dataDir, story.id)
    const stories = await listStories(dataDir)
    expect(stories).toHaveLength(0)
  })

  it('returns null for non-existent story', async () => {
    const result = await getStory(dataDir, 'nonexistent')
    expect(result).toBeNull()
  })
})

describe('Fragment CRUD', () => {
  const storyId = 'story-1'

  beforeEach(async () => {
    await createStory(dataDir, makeStory({ id: storyId }))
  })

  it('creates and retrieves a fragment', async () => {
    const fragment = makeFragment()
    await createFragment(dataDir, storyId, fragment)
    const retrieved = await getFragment(dataDir, storyId, fragment.id)
    expect(retrieved).toMatchObject({
      ...fragment,
      archived: false,
      version: 1,
    })
    // The current content is represented as v1 in the history.
    expect(retrieved!.versions).toHaveLength(1)
    expect(retrieved!.versions![0]).toMatchObject({
      version: 1,
      name: fragment.name,
      description: fragment.description,
      content: fragment.content,
    })
  })

  it('lists fragments by type', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-a1b2' }))
    await createFragment(
      dataDir,
      storyId,
      makeFragment({ id: 'pr-c3d4', name: 'Second' })
    )
    await createFragment(
      dataDir,
      storyId,
      makeFragment({ id: 'ch-x9y8', type: 'character', name: 'Alice' })
    )

    const prose = await listFragments(dataDir, storyId, 'prose')
    expect(prose).toHaveLength(2)

    const characters = await listFragments(dataDir, storyId, 'character')
    expect(characters).toHaveLength(1)
  })

  it('lists all fragments when no type filter', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-a1b2' }))
    await createFragment(
      dataDir,
      storyId,
      makeFragment({ id: 'ch-x9y8', type: 'character', name: 'Alice' })
    )
    const all = await listFragments(dataDir, storyId)
    expect(all).toHaveLength(2)
  })

  it('updates a fragment', async () => {
    const fragment = makeFragment()
    await createFragment(dataDir, storyId, fragment)
    const updated = { ...fragment, content: 'New content here.' }
    await updateFragment(dataDir, storyId, updated)
    const retrieved = await getFragment(dataDir, storyId, fragment.id)
    expect(retrieved!.content).toBe('New content here.')
  })

  it('creates a version snapshot when versioned content update runs', async () => {
    const fragment = makeFragment({
      id: 'ch-1000',
      type: 'character',
      name: 'Alice',
      description: 'Original desc',
      content: 'Original content',
    })
    await createFragment(dataDir, storyId, fragment)

    const updated = await updateFragmentVersioned(
      dataDir,
      storyId,
      'ch-1000',
      { content: 'Updated content', description: 'Updated desc' },
      { reason: 'test-refine' },
    )

    expect(updated).not.toBeNull()
    // An edit appends the new content as a version; the original (v1) is retained.
    expect(updated!.version).toBe(2)
    expect(updated!.versions).toHaveLength(2)
    expect(updated!.versions![0].version).toBe(1)
    expect(updated!.versions![0].content).toBe('Original content')
    expect(updated!.versions![1].version).toBe(2)
    expect(updated!.versions![1].content).toBe('Updated content')
    expect(updated!.versions![1].reason).toBe('test-refine')
  })

  it('serializes concurrent versioned updates without reusing a version number', async () => {
    const storyId = 'story-versions-race'
    await createStory(dataDir, makeStory({ id: storyId }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-race', content: 'v1' }))

    await Promise.all([
      updateFragmentVersioned(dataDir, storyId, 'pr-race', { content: 'concurrent-a' }, { reason: 'manual-update' }),
      updateFragmentVersioned(dataDir, storyId, 'pr-race', { content: 'concurrent-b' }, { reason: 'manual-update' }),
    ])

    const versions = await listFragmentVersions(dataDir, storyId, 'pr-race')
    expect(versions?.map((version) => version.version)).toEqual([1, 2, 3])
  })

  it("folds a new fragment's opening autosaves into its created v1", async () => {
    // Mirrors the create route, which seeds v1 with reason 'created' so the opening
    // editing session stays v1 instead of jumping to v2 on the first autosave.
    const fragment = makeFragment({
      id: 'ch-1040',
      type: 'character',
      name: 'Alice',
      description: 'v1 desc',
      content: '',
      version: 1,
      versions: [
        { version: 1, name: 'Alice', description: 'v1 desc', content: '', createdAt: new Date().toISOString(), reason: 'created' },
      ],
    })
    await createFragment(dataDir, storyId, fragment)

    const first = await updateFragmentVersioned(dataDir, storyId, 'ch-1040', { content: 'Once' }, { reason: 'autosave' })
    const last = await updateFragmentVersioned(dataDir, storyId, 'ch-1040', { content: 'Once upon' }, { reason: 'autosave' })

    // Both autosaves fold into the created v1 — no jump to v2.
    expect(first!.version).toBe(1)
    expect(last!.version).toBe(1)
    expect(last!.versions).toHaveLength(1)
    expect(last!.content).toBe('Once upon')
  })

  it('coalesces consecutive autosaves into a single version', async () => {
    const fragment = makeFragment({
      id: 'ch-1050',
      type: 'character',
      name: 'Alice',
      description: 'v1 desc',
      content: 'v1',
    })
    await createFragment(dataDir, storyId, fragment)

    // First autosave seals v1 and opens a new version (v1 is not itself an autosave).
    const first = await updateFragmentVersioned(dataDir, storyId, 'ch-1050', { content: 'v1a' }, { reason: 'autosave' })
    expect(first!.version).toBe(2)
    expect(first!.versions).toHaveLength(2)

    // Subsequent autosaves fold into that same version instead of appending.
    await updateFragmentVersioned(dataDir, storyId, 'ch-1050', { content: 'v1ab' }, { reason: 'autosave' })
    const last = await updateFragmentVersioned(dataDir, storyId, 'ch-1050', { content: 'v1abc' }, { reason: 'autosave' })

    expect(last!.version).toBe(2)
    expect(last!.versions).toHaveLength(2)
    expect(last!.content).toBe('v1abc')
    expect(last!.versions![1].content).toBe('v1abc')
    // The sealed v1 snapshot is preserved untouched.
    expect(last!.versions![0].content).toBe('v1')
  })

  it('appends a fresh version when a deliberate save follows autosaves', async () => {
    const fragment = makeFragment({
      id: 'ch-1060',
      type: 'character',
      name: 'Alice',
      description: 'v1 desc',
      content: 'v1',
    })
    await createFragment(dataDir, storyId, fragment)

    await updateFragmentVersioned(dataDir, storyId, 'ch-1060', { content: 'v2' }, { reason: 'autosave' })
    await updateFragmentVersioned(dataDir, storyId, 'ch-1060', { content: 'v2b' }, { reason: 'autosave' })
    // A non-autosave reason never coalesces — it seals the session with a new version.
    const manual = await updateFragmentVersioned(dataDir, storyId, 'ch-1060', { content: 'v3' }, { reason: 'manual-update' })

    expect(manual!.version).toBe(3)
    expect(manual!.versions!.map(v => v.version)).toEqual([1, 2, 3])
    expect(manual!.versions![1].content).toBe('v2b')
    expect(manual!.versions![2].content).toBe('v3')
  })

  it('lists all versions and switches to one without creating a new version', async () => {
    const fragment = makeFragment({
      id: 'gl-2000',
      type: 'guideline',
      name: 'Tone',
      description: 'v1 desc',
      content: 'v1 content',
    })
    await createFragment(dataDir, storyId, fragment)

    await updateFragmentVersioned(dataDir, storyId, 'gl-2000', { content: 'v2 content', description: 'v2 desc' })
    await updateFragmentVersioned(dataDir, storyId, 'gl-2000', { content: 'v3 content', description: 'v3 desc' })

    // The current version is included in the list.
    const versions = await listFragmentVersions(dataDir, storyId, 'gl-2000')
    expect(versions).not.toBeNull()
    expect(versions!.map(v => v.version)).toEqual([1, 2, 3])

    // Switching is a pointer move: content changes, history is unchanged.
    const reverted = await revertFragmentToVersion(dataDir, storyId, 'gl-2000', 1)
    expect(reverted).not.toBeNull()
    expect(reverted!.id).toBe('gl-2000')
    expect(reverted!.content).toBe('v1 content')
    expect(reverted!.description).toBe('v1 desc')
    expect(reverted!.version).toBe(1)
    expect(reverted!.versions).toHaveLength(3)
  })

  it('deletes a single version snapshot without changing current content', async () => {
    const fragment = makeFragment({
      id: 'gl-2100',
      type: 'guideline',
      name: 'Tone',
      description: 'v1 desc',
      content: 'v1 content',
    })
    await createFragment(dataDir, storyId, fragment)
    await updateFragmentVersioned(dataDir, storyId, 'gl-2100', { content: 'v2 content' })
    await updateFragmentVersioned(dataDir, storyId, 'gl-2100', { content: 'v3 content' })

    const updated = await deleteFragmentVersion(dataDir, storyId, 'gl-2100', 1)
    expect(updated).not.toBeNull()
    // The v1 snapshot is gone; v2 and the current v3 remain; current content untouched.
    expect(updated!.versions!.map(v => v.version)).toEqual([2, 3])
    expect(updated!.content).toBe('v3 content')
    expect(updated!.version).toBe(3)
  })

  it('refuses to delete the current version', async () => {
    const fragment = makeFragment({
      id: 'gl-2102',
      type: 'guideline',
      content: 'v1 content',
    })
    await createFragment(dataDir, storyId, fragment)
    await updateFragmentVersioned(dataDir, storyId, 'gl-2102', { content: 'v2 content' })
    // Current is v2; deleting it must fail.
    const result = await deleteFragmentVersion(dataDir, storyId, 'gl-2102', 2)
    expect(result).toBeNull()
  })

  it('undo (no target) steps back to the previous version', async () => {
    const fragment = makeFragment({
      id: 'gl-2103',
      type: 'guideline',
      content: 'v1 content',
    })
    await createFragment(dataDir, storyId, fragment)
    await updateFragmentVersioned(dataDir, storyId, 'gl-2103', { content: 'v2 content' })
    await updateFragmentVersioned(dataDir, storyId, 'gl-2103', { content: 'v3 content' })

    const undone = await revertFragmentToVersion(dataDir, storyId, 'gl-2103')
    expect(undone!.version).toBe(2)
    expect(undone!.content).toBe('v2 content')
    expect(undone!.versions).toHaveLength(3)
  })

  it('returns null when deleting a missing version', async () => {
    const fragment = makeFragment({ id: 'gl-2101', type: 'guideline' })
    await createFragment(dataDir, storyId, fragment)
    const result = await deleteFragmentVersion(dataDir, storyId, 'gl-2101', 99)
    expect(result).toBeNull()
  })

  it('deletes a fragment', async () => {
    const fragment = makeFragment()
    await createFragment(dataDir, storyId, fragment)
    await deleteFragment(dataDir, storyId, fragment.id)
    const result = await getFragment(dataDir, storyId, fragment.id)
    expect(result).toBeNull()
  })

  it('returns null for non-existent fragment', async () => {
    const result = await getFragment(dataDir, storyId, 'pr-zzzz')
    expect(result).toBeNull()
  })
})

describe('Fragment Archive', () => {
  const storyId = 'story-1'

  beforeEach(async () => {
    await createStory(dataDir, makeStory({ id: storyId }))
  })

  it('archiveFragment sets archived to true', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-test' }))
    const result = await archiveFragment(dataDir, storyId, 'ch-test')
    expect(result).not.toBeNull()
    expect(result!.archived).toBe(true)
  })

  it('restoreFragment sets archived to false', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-test', archived: true }))
    const result = await restoreFragment(dataDir, storyId, 'ch-test')
    expect(result).not.toBeNull()
    expect(result!.archived).toBe(false)
  })

  it('archiveFragment returns null for non-existent fragment', async () => {
    const result = await archiveFragment(dataDir, storyId, 'pr-zzzz')
    expect(result).toBeNull()
  })

  it('listFragments excludes archived fragments by default', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-aaaa' }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-bbbb' }))
    await archiveFragment(dataDir, storyId, 'ch-bbbb')

    const fragments = await listFragments(dataDir, storyId)
    expect(fragments).toHaveLength(1)
    expect(fragments[0].id).toBe('ch-aaaa')
  })

  it('listFragments includes archived fragments when opted in', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-aaaa' }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-bbbb' }))
    await archiveFragment(dataDir, storyId, 'ch-bbbb')

    const fragments = await listFragments(dataDir, storyId, undefined, { includeArchived: true })
    expect(fragments).toHaveLength(2)
  })

  it('defaults archived to false for legacy fragments without the field', async () => {
    // Create a fragment without the archived field (simulating legacy data)
    const legacy = makeFragment({ id: 'pr-lega' })
    delete (legacy as unknown as Record<string, unknown>).archived
    await createFragment(dataDir, storyId, legacy)

    const fragments = await listFragments(dataDir, storyId)
    expect(fragments).toHaveLength(1)
    expect(fragments[0].archived).toBe(false)
  })
})
