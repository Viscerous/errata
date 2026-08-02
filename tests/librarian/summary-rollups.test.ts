import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStory, createFragment } from '@/server/fragments/storage'
import { addProseSection, initProseChain } from '@/server/fragments/prose-chain'
import { analysisSourceRevision } from '@/server/librarian/continuity-source'
import { saveAnalysis } from '@/server/librarian/storage'
import {
  buildSummaryProjection,
  renderSummaryProjection,
  SUMMARY_CONTRACT_VERSION,
} from '@/server/librarian/summary-projection'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'
import { createTempDir, makeTestSettings, seedTestProvider } from '../setup'

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }))

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    ToolLoopAgent: class {
      async stream(args: unknown) {
        return streamMock(args)
      }
    },
  }
})

import {
  listSummaryRollupNodes,
  runSummaryRollupMaintenance,
  selectSummaryRollupFrontier,
} from '@/server/librarian/summary-rollups'

function makeStory(settings: Partial<StoryMeta['settings']> = {}): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-test',
    name: 'Roll-up Test',
    description: '',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(settings),
  }
}

function prose(position: number): Fragment {
  const now = new Date().toISOString()
  return {
    id: `pr-${String(position).padStart(4, '0')}`,
    type: 'prose',
    name: `Passage ${position}`,
    description: '',
    content: `Passage ${position} source text.`,
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

async function seedPassages(dataDir: string, count: number): Promise<Fragment[]> {
  const passages = Array.from({ length: count }, (_, index) => prose(index + 1))
  for (const [index, passage] of passages.entries()) {
    await createFragment(dataDir, 'story-test', passage)
    if (index === 0) await initProseChain(dataDir, 'story-test', passage.id)
    else await addProseSection(dataDir, 'story-test', passage.id)
    await saveAnalysis(dataDir, 'story-test', {
      id: `la-${passage.id}`,
      createdAt: new Date(Date.now() + index).toISOString(),
      fragmentId: passage.id,
      sourceRevision: analysisSourceRevision(passage),
      summaryUpdate: `By Passage ${index + 1}, event ${index + 1} had happened.`,
      summaryContractVersion: SUMMARY_CONTRACT_VERSION,
      mentions: [],
      contradictions: [],
      fragmentChangeProposals: [],
      timelineEvents: [],
    })
  }
  return passages
}

describe('summary roll-up maintenance', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const temp = await createTempDir()
    dataDir = temp.path
    cleanup = temp.cleanup
    await seedTestProvider(dataDir)
    streamMock.mockReset()
    streamMock.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield {
          type: 'text-delta' as const,
          text: JSON.stringify({
            title: 'The Gate Opened',
            text: 'By the end of the interval, the gate had opened and the travelers had entered.',
          }),
        }
        yield { type: 'finish' as const, finishReason: 'stop' }
      })(),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 10 }),
    }))
  })

  afterEach(async () => cleanup())

  it('caches one pure six-child L1 node without story context in the model request', async () => {
    await createStory(dataDir, makeStory())
    const passages = await seedPassages(dataDir, 12)

    const node = await runSummaryRollupMaintenance(dataDir, 'story-test')

    expect(node).toMatchObject({ level: 1, coverageStart: 'pr-0001', coverageEnd: 'pr-0006' })
    expect(node?.childIds).toHaveLength(6)
    expect(await listSummaryRollupNodes(dataDir, 'story-test')).toEqual([node])
    const request = streamMock.mock.calls[0][0] as { prompt: string }
    expect(request.prompt).toContain('By Passage 1')
    expect(request.prompt).not.toContain('Roll-up Test')
    expect(request.prompt).not.toContain('source text')

    const projection = await buildSummaryProjection({
      dataDir,
      storyId: 'story-test',
      activeProseFragments: passages,
      recentProseFragments: [],
    })
    expect(projection.items[0]).toMatchObject({
      kind: 'rollup',
      level: 1,
      position: 1,
      endPosition: 6,
      nodeId: node?.id,
    })
    expect(projection.items.slice(1).map((item) => item.position)).toEqual([7, 8, 9, 10, 11, 12])
    expect(renderSummaryProjection(projection, 'generation.writer')).toContain('Passages 1\u20136')

    const frontier = selectSummaryRollupFrontier(
      [...node!.leafIds, ...Array.from({ length: 6 }, (_, index) => `recent-${index}`)],
      [node!],
      6,
    )
    expect(frontier).toEqual([{ node, startIndex: 0, endIndex: 5 }])
    expect(selectSummaryRollupFrontier(
      node!.leafIds,
      [node!],
      6,
      ['chapter-a', 'chapter-a', 'chapter-a', 'chapter-b', 'chapter-b', 'chapter-b'],
    )).toEqual([])
  })

  it('recursively derives an L2 node from six contiguous current L1 nodes', async () => {
    await createStory(dataDir, makeStory())
    await seedPassages(dataDir, 36)

    for (let index = 0; index < 7; index += 1) {
      await runSummaryRollupMaintenance(dataDir, 'story-test')
    }

    const nodes = await listSummaryRollupNodes(dataDir, 'story-test')
    expect(nodes.filter((node) => node.level === 1)).toHaveLength(6)
    const levelTwo = nodes.find((node) => node.level === 2)
    expect(levelTwo).toMatchObject({ coverageStart: 'pr-0001', coverageEnd: 'pr-0036' })
    expect(levelTwo?.childIds).toHaveLength(6)
    expect(levelTwo?.leafIds).toHaveLength(36)
    expect(selectSummaryRollupFrontier(levelTwo!.leafIds, [levelTwo!], 36)).toEqual([])
    expect(selectSummaryRollupFrontier(levelTwo!.leafIds, nodes, 36)).toEqual([
      { node: levelTwo, startIndex: 0, endIndex: 35 },
    ])
  })

  it('does not derive nodes when automatic librarian work is disabled', async () => {
    await createStory(dataDir, makeStory({ disableLibrarianAutoAnalysis: true }))
    expect(await runSummaryRollupMaintenance(dataDir, 'story-test')).toBeNull()
    expect(streamMock).not.toHaveBeenCalled()
  })
})
