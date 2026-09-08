import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory, createFragment } from '@/server/fragments/storage'
import {
  validateOperations,
  fragmentBaseHash,
} from '@/server/fragments/change-operations'
import { getFragment } from '@/server/fragments/storage'
import type { Fragment, StoryMeta } from '@/contracts/story'

const now = new Date().toISOString()

function makeStory(): StoryMeta {
  return {
    id: 'story-guards',
    name: 'Guards Story',
    description: '',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeKnowledge(content: string): Fragment {
  return {
    id: 'kn-guard01',
    type: 'knowledge',
    name: 'Guarded Sheet',
    description: 'A knowledge sheet used to test write guards',
    content,
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
  }
}

describe('change-operation state integrity', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, makeStory())
  })

  afterEach(async () => {
    await cleanup()
  })

  it('rejects replace_text with an empty oldText anchor', async () => {
    await createFragment(dataDir, 'story-guards', makeKnowledge('A stable paragraph.'))

    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'replace_text',
      fragmentId: 'kn-guard01',
      field: 'content',
      oldText: '   ',
      newText: 'A changed paragraph.',
      replaceAll: false,
    }])

    expect(results[0].status).toBe('invalid')
    expect(results[0].errors?.[0]).toMatchObject({
      code: 'old_text_missing',
      nextAction: 'readFragments',
    })
  })

  it('allows replace_text to replace a whole current field', async () => {
    const current = 'Status: Active Elicitation.\n\nCurrent Lure: Victoria will approach Thorne through the preservation project.'
    await createFragment(dataDir, 'story-guards', makeKnowledge(current))

    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'replace_text',
      fragmentId: 'kn-guard01',
      field: 'content',
      oldText: current,
      newText: 'Status: Active Cultivation.\n\nCurrent Status: Thorne sees the preservation role as his only viable exit.',
      replaceAll: false,
    }])

    expect(results[0].status).toBe('valid')
  })

  it('does not impose a content-size policy on a valid exact edit', async () => {
    await createFragment(dataDir, 'story-guards', makeKnowledge('Opening context.\n\nShort body to revise.\n\nClosing context.'))

    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'replace_text',
      fragmentId: 'kn-guard01',
      field: 'content',
      oldText: 'Short body to revise.',
      newText: 'x'.repeat(4001),
      replaceAll: false,
    }])

    expect(results[0].status).toBe('valid')
  })

  it('keeps stale-write protection for whole-field rewrites', async () => {
    await createFragment(dataDir, 'story-guards', makeKnowledge('Old body.'))
    const target = await getFragment(dataDir, 'story-guards', 'kn-guard01')

    const bigButClean = Array.from({ length: 60 }, (_, i) => `Distinct paragraph number ${i} carrying enough narrative weight and operational detail to stand entirely on its own merits here.`).join('\n\n')
    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'set_fields',
      fragmentId: 'kn-guard01',
      baseHash: fragmentBaseHash(target!),
      fields: { content: bigButClean },
    }])

    expect(results[0].status).toBe('valid')
  })
})
