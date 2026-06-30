import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory, createFragment } from '@/server/fragments/storage'
import {
  validateOperations,
  fragmentBaseHash,
  MAX_LOCALIZED_EDIT_CHARS,
} from '@/server/fragments/change-operations'
import { getFragment } from '@/server/fragments/storage'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'

const now = new Date().toISOString()

// A paragraph long enough for the repetition check (>= 80 normalized chars).
const LONG_PARA = 'The Cabinet is actively weaponizing the ghosts of the old accord by framing the clearance as a high-friction gatehouse for every permit.'

function makeStory(): StoryMeta {
  return {
    id: 'story-guards',
    name: 'Guards Story',
    description: '',
    coverImage: null,
    summary: '',
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

describe('change-operation content integrity guards', () => {
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

  it('rejects an edit that introduces a duplicated paragraph (looping artifact)', async () => {
    await createFragment(dataDir, 'story-guards', makeKnowledge(`${LONG_PARA}\n\nA second topic paragraph.`))

    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'replace_text',
      fragmentId: 'kn-guard01',
      field: 'content',
      oldText: 'A second topic paragraph.',
      newText: LONG_PARA,
      replaceAll: false,
    }])

    expect(results[0].status).toBe('invalid')
    expect(results[0].errors?.some(e => e.code === 'repeated_content')).toBe(true)
  })

  it('rejects append_paragraph that re-adds an already-present paragraph', async () => {
    await createFragment(dataDir, 'story-guards', makeKnowledge(LONG_PARA))

    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'append_paragraph',
      fragmentId: 'kn-guard01',
      field: 'content',
      text: LONG_PARA,
    }])

    expect(results[0].status).toBe('invalid')
    expect(results[0].errors?.some(e => e.code === 'repeated_content')).toBe(true)
  })

  it('still allows edits to a fragment whose body already carries legacy duplication', async () => {
    // Pre-existing damage: the paragraph appears twice already. An unrelated
    // small edit must stay allowed — only making it worse is blocked.
    await createFragment(dataDir, 'story-guards', makeKnowledge(`${LONG_PARA}\n\n${LONG_PARA}\n\nStatus: mapping.`))

    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'replace_text',
      fragmentId: 'kn-guard01',
      field: 'content',
      oldText: 'Status: mapping.',
      newText: 'Status: engagement.',
      replaceAll: false,
    }])

    expect(results[0].status).toBe('valid')
  })

  it('rejects content that pastes a context-rendering heading into the body', async () => {
    await createFragment(dataDir, 'story-guards', makeKnowledge('Plain body.'))

    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'append_paragraph',
      fragmentId: 'kn-guard01',
      field: 'content',
      text: '### `kn-guard01` | Guarded Sheet | A knowledge sheet used to test write guards\nEchoed body text.',
    }])

    expect(results[0].status).toBe('invalid')
    expect(results[0].errors?.some(e => e.code === 'context_heading_in_content')).toBe(true)
  })

  it('rejects create_fragment content carrying a context heading', async () => {
    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'create_fragment',
      type: 'knowledge',
      name: 'Echo Sheet',
      description: 'Echoed context',
      content: '### `kn-abcdef` | Echo Sheet | Echoed context\nBody.',
    }])

    expect(results[0].status).toBe('invalid')
    expect(results[0].errors?.some(e => e.code === 'context_heading_in_content')).toBe(true)
  })

  it('rejects an oversized localized edit and directs the model to set_fields', async () => {
    await createFragment(dataDir, 'story-guards', makeKnowledge('Short body to revise.'))

    const { results } = await validateOperations(dataDir, 'story-guards', [{
      action: 'replace_text',
      fragmentId: 'kn-guard01',
      field: 'content',
      oldText: 'Short body to revise.',
      newText: 'x'.repeat(MAX_LOCALIZED_EDIT_CHARS + 1),
      replaceAll: false,
    }])

    expect(results[0].status).toBe('invalid')
    const error = results[0].errors?.find(e => e.code === 'localized_edit_too_large')
    expect(error).toBeDefined()
    expect(error!.message).toContain('set_fields')
  })

  it('set_fields with baseHash remains exempt from the localized size cap', async () => {
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
