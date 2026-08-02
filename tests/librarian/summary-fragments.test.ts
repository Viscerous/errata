import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStory } from '@/server/fragments/storage'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'
import { analysisSourceRevision } from '@/server/librarian/continuity-source'
import {
  buildSummaryProjection,
  renderSummaryProjection,
  SUMMARY_CONTRACT_VERSION,
} from '@/server/librarian/summary-projection'
import { saveAnalysis, type LibrarianAnalysis } from '@/server/librarian/storage'
import { createTempDir, makeTestSettings } from '../setup'

function story(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function prose(position: number, content = `Passage ${position}`): Fragment {
  const now = new Date().toISOString()
  return {
    id: `pr-${String(position).padStart(4, '0')}`,
    type: 'prose',
    name: `Passage ${position}`,
    description: '',
    content,
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: now,
    updatedAt: now,
    order: position,
    meta: {},
  }
}

function analysis(fragment: Fragment, text: string, id = `la-${fragment.id}`): LibrarianAnalysis {
  return {
    id,
    createdAt: new Date().toISOString(),
    fragmentId: fragment.id,
    sourceRevision: analysisSourceRevision(fragment),
    summaryUpdate: text,
    summaryContractVersion: SUMMARY_CONTRACT_VERSION,
    mentions: [],
    contradictions: [],
    fragmentChangeProposals: [],
    timelineEvents: [],
  }
}

describe('summary projection', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const temp = await createTempDir()
    dataDir = temp.path
    cleanup = temp.cleanup
    await createStory(dataDir, story())
  })

  afterEach(async () => cleanup())

  it('folds only source-current analyses before the recent prose window', async () => {
    const passages = [1, 2, 3, 4].map((position) => prose(position))
    await saveAnalysis(dataDir, 'story-test', analysis(passages[0], 'By then, the gate had opened.'))
    await saveAnalysis(dataDir, 'story-test', analysis(passages[1], 'This summary becomes stale.'))
    passages[1] = { ...passages[1], content: 'The edited second passage.' }

    const projection = await buildSummaryProjection({
      dataDir,
      storyId: 'story-test',
      activeProseFragments: passages,
      recentProseFragments: passages.slice(2),
    })

    expect(projection.items).toHaveLength(2)
    expect(projection.items[0]).toMatchObject({ kind: 'contribution', position: 1 })
    expect(projection.items[1]).toMatchObject({ kind: 'gap', position: 2, gapReason: 'stale-source' })
    expect(projection.firstRecentPosition).toBe(3)
  })

  it('never includes material at or beyond a target-relative prose boundary', async () => {
    const passages = [1, 2, 3, 4, 5, 6].map((position) => prose(position))
    for (const passage of passages) {
      await saveAnalysis(dataDir, 'story-test', analysis(passage, `By Passage ${passage.order}, events had advanced.`))
    }

    const projection = await buildSummaryProjection({
      dataDir,
      storyId: 'story-test',
      activeProseFragments: passages.slice(0, 4),
      recentProseFragments: passages.slice(2, 4),
      targetRelative: true,
    })

    expect(projection.items.map((item) => item.position)).toEqual([1, 2])
    const rendered = renderSummaryProjection(projection, 'generation.writer')!
    expect(rendered).not.toContain('Passage 5, events')
    expect(rendered).not.toContain('Passage 6, events')
  })

  it('excludes unscoped authored memory from target-relative prompts', async () => {
    const passages = [prose(1), prose(2), prose(3)]
    const authored: Fragment = {
      ...prose(99, 'Late authored memory'),
      id: 'sm-authored',
      type: 'summary',
      name: 'Author overview',
      meta: {},
    }
    const scoped: Fragment = {
      ...authored,
      id: 'sm-scoped',
      name: 'Scoped overview',
      content: 'Safe early memory.',
      meta: { validThrough: passages[0].id },
    }
    const scopedThroughRecent: Fragment = {
      ...authored,
      id: 'sm-scoped-recent',
      name: 'Scoped through recent prose',
      content: 'Still safe before the regeneration target.',
      meta: { validThrough: passages[2].id },
    }

    const projection = await buildSummaryProjection({
      dataDir,
      storyId: 'story-test',
      activeProseFragments: passages,
      recentProseFragments: passages.slice(1),
      summaryFragments: [authored, scoped, scopedThroughRecent],
      targetRelative: true,
    })

    expect(projection.authored.map((record) => record.id)).toEqual(['sm-scoped', 'sm-scoped-recent'])
  })

  it('renders reader guidance, exact gaps, the prose seam, and a closing fence', async () => {
    const passages = [prose(1), prose(2)]
    const projection = await buildSummaryProjection({
      dataDir,
      storyId: 'story-test',
      activeProseFragments: passages,
      recentProseFragments: passages.slice(1),
    })

    const rendered = renderSummaryProjection(projection, 'librarian.analyze')!
    expect(rendered).toContain('avoid reporting material that was already recorded')
    expect(rendered).toContain('Passage 1')
    expect(rendered).toContain('Coverage gap')
    expect(rendered).toContain('recent prose begins at Passage 2')
    expect(rendered).toContain('## End of Story Summary')
  })

  it('always retains the six contributions nearest the prose seam', async () => {
    const passages = Array.from({ length: 10 }, (_, index) => prose(index + 1))
    for (const passage of passages) {
      await saveAnalysis(dataDir, 'story-test', analysis(passage, 'A long record. '.repeat(30)))
    }

    const projection = await buildSummaryProjection({
      dataDir,
      storyId: 'story-test',
      activeProseFragments: passages,
      recentProseFragments: [],
      tokenBudget: 1,
    })

    expect(projection.items).toHaveLength(6)
    expect(projection.items[0].position).toBe(5)
    expect(projection.omittedBefore).toEqual({ start: 1, end: 4 })
  })
})
