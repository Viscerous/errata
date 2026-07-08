import { describe, it, expect, afterEach } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory, createFragment, listStories, getStory } from '@/server/fragments/storage'
import { exportStoryAsZip, importStoryFromZip } from '@/server/story-archive'
import type { StoryMeta, Fragment } from '@/server/fragments/schema'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-src',
    name: 'Source Story',
    description: 'A story to export',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeFragment(): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'kn-0001',
    type: 'knowledge',
    name: 'Fact',
    description: 'A fact',
    content: 'The sky is blue.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
  }
}

describe('importStoryFromZip', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  /**
   * Regression: some archives (notably externally-prepared bundles) include bare
   * zip directory entries — keys ending in '/', e.g. `.../branches/main/`. The
   * verbatim copy loop used to try to write those as files, which raised
   * `EISDIR` on the branch directory and aborted the import mid-write.
   */
  it('imports an archive that contains bare directory entries', async () => {
    const tmp = await createTempDir()
    cleanup = tmp.cleanup
    const dataDir = tmp.path

    await createStory(dataDir, makeStory())
    await createFragment(dataDir, 'story-src', makeFragment())

    const { buffer } = await exportStoryAsZip(dataDir, 'story-src')

    // Re-zip the export with directory entries added, reproducing the archives
    // that broke import (a bare `.../branches/main/` folder marker + a root one).
    const entries = unzipSync(buffer)
    const branchFile = Object.keys(entries).find((p) => p.includes('/branches/main/'))!
    const branchDir = branchFile.slice(0, branchFile.indexOf('/branches/main/') + '/branches/main/'.length)
    const rootPrefix = Object.keys(entries).find((p) => p.endsWith('meta.json'))!.replace('meta.json', '')
    entries[branchDir] = new Uint8Array(0)
    entries[`${rootPrefix}`] = new Uint8Array(0)
    const withDirs = zipSync(entries)

    const before = (await listStories(dataDir)).length
    const imported = await importStoryFromZip(dataDir, withDirs)

    expect(imported.name).toBe('Source Story (imported)')
    const stories = await listStories(dataDir)
    expect(stories.length).toBe(before + 1)
    // The imported story is real and readable, not a half-written shell.
    expect(await getStory(dataDir, imported.id)).not.toBeNull()
  })

  /**
   * A genuinely broken archive must not leave a half-written "ghost" story on
   * disk — the import is atomic, rolling the story back on failure.
   */
  it('rolls back the story when the archive is invalid', async () => {
    const tmp = await createTempDir()
    cleanup = tmp.cleanup
    const dataDir = tmp.path

    // `meta.json` present (so it gets past the early guard) but `branches.json`
    // is malformed JSON, so content import throws after the story dir is created.
    const badArchive = zipSync({
      'export/meta.json': new TextEncoder().encode(JSON.stringify(makeStory())),
      'export/branches.json': new TextEncoder().encode('{ not valid json'),
    })

    const before = (await listStories(dataDir)).length
    await expect(importStoryFromZip(dataDir, badArchive)).rejects.toThrow()
    expect((await listStories(dataDir)).length).toBe(before)
  })
})
