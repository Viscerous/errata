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
import { clearServedModelObservations } from '@/server/llm/served-models'
import { listActiveAgents } from '@/server/agents/active-registry'
import { clearAgentRuns, listAgentRuns } from '@/server/agents/traces'
import { withBranch } from '@/server/fragments/branches'
import { createTempDir, makeTestSettings, seedTestProvider } from '../setup'

const { streamMock, agentMock } = vi.hoisted(() => ({ streamMock: vi.fn(), agentMock: vi.fn() }))

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    ToolLoopAgent: class {
      constructor(settings: unknown) {
        agentMock(settings)
      }

      async stream(args: unknown) {
        return streamMock(args)
      }
    },
  }
})

import {
  listSummaryRollupNodes,
  deriveNextSummaryRollupNode,
  selectSummaryRollupFrontier,
  SUMMARY_ROLLUP_MAX_TEXT_CHARS,
} from '@/server/librarian/summary-rollups'
import {
  cancelSummaryRollupMaintenance,
  queueSummaryRollupMaintenance,
  requestSummaryRollupMaintenance,
} from '@/server/librarian/summary-rollup-maintenance'

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
    agentMock.mockReset()
    clearServedModelObservations()
    clearAgentRuns('story-test')
    streamMock.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-call' as const,
          toolCallId: 'call-1',
          toolName: 'recordRollup',
          input: {
            title: 'The Gate Opened',
            text: 'By the end of the interval, the gate had opened and the travelers had entered.',
          },
        }
        yield {
          type: 'tool-result' as const,
          toolCallId: 'call-1',
          toolName: 'recordRollup',
          output: { ok: true },
        }
        yield { type: 'finish' as const, finishReason: 'tool-calls' }
      })(),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 10 }),
    }))
  })

  afterEach(async () => {
    clearAgentRuns('story-test')
    await cleanup()
  })

  it('caches one pure six-child L1 node without story context in the model request', async () => {
    await createStory(dataDir, makeStory())
    const passages = await seedPassages(dataDir, 12)

    const node = await deriveNextSummaryRollupNode(dataDir, 'story-test')

    expect(node).toMatchObject({ level: 1, coverageStart: 'pr-0001', coverageEnd: 'pr-0006' })
    expect(node?.childIds).toHaveLength(6)
    expect(await listSummaryRollupNodes(dataDir, 'story-test')).toEqual([node])
    const request = streamMock.mock.calls[0][0] as { prompt: string }
    expect(request.prompt).toContain('By Passage 1')
    expect(request.prompt).not.toContain('Roll-up Test')
    expect(request.prompt).not.toContain('source text')

    const settings = agentMock.mock.calls[0][0] as { tools: Record<string, unknown>; toolChoice: string }
    expect(Object.keys(settings.tools)).toEqual(['recordRollup'])
    expect(settings.toolChoice).toBe('required')

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
      await deriveNextSummaryRollupNode(dataDir, 'story-test')
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

  it('drains every currently eligible level as one visible maintenance pass', async () => {
    await createStory(dataDir, makeStory())
    await seedPassages(dataDir, 36)

    requestSummaryRollupMaintenance(dataDir, 'story-test', 'main')

    await vi.waitFor(async () => {
      expect(await listSummaryRollupNodes(dataDir, 'story-test')).toHaveLength(7)
    }, { timeout: 5_000 })
    await vi.waitFor(() => expect(listActiveAgents('story-test')).toHaveLength(0))
    expect(streamMock).toHaveBeenCalledTimes(7)
    expect((await listSummaryRollupNodes(dataDir, 'story-test')).filter((node) => node.level === 2)).toHaveLength(1)
    expect(listAgentRuns('story-test')).toEqual([
      expect.objectContaining({
        agentName: 'librarian.rollup',
        status: 'success',
        output: expect.objectContaining({ nodesCreated: 7, highestLevel: 2 }),
      }),
    ])
  })

  it('releases demand discovered by an idle context projection', async () => {
    await createStory(dataDir, makeStory())
    const passages = await seedPassages(dataDir, 12)

    await withBranch(dataDir, 'story-test', async () => {
      const projection = await buildSummaryProjection({
        dataDir,
        storyId: 'story-test',
        activeProseFragments: passages,
        recentProseFragments: [],
        tokenBudget: 1,
      })
      expect(projection.omittedBefore).toEqual({ start: 1, end: 6 })
      queueSummaryRollupMaintenance(dataDir, 'story-test')
    }, 'main')

    await vi.waitFor(async () => {
      expect(await listSummaryRollupNodes(dataDir, 'story-test')).toHaveLength(2)
    })
    await vi.waitFor(() => expect(listActiveAgents('story-test')).toHaveLength(0))
  })

  it('cancels queued maintenance when its timeline is deleted', async () => {
    await createStory(dataDir, makeStory())
    await seedPassages(dataDir, 6)

    requestSummaryRollupMaintenance(dataDir, 'story-test', 'main')
    await cancelSummaryRollupMaintenance(dataDir, 'story-test', 'main')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(streamMock).not.toHaveBeenCalled()
    expect(await listSummaryRollupNodes(dataDir, 'story-test')).toEqual([])
  })

  it('runs with reasoning off and an output budget above the record cap', async () => {
    await createStory(dataDir, makeStory({ disableThinking: false }))
    await seedPassages(dataDir, 6)

    await deriveNextSummaryRollupNode(dataDir, 'story-test')

    const settings = agentMock.mock.calls[0][0] as { providerOptions?: unknown; maxOutputTokens: number }
    expect(settings.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: 'none' } })
    expect(settings.maxOutputTokens).toBeGreaterThan(SUMMARY_ROLLUP_MAX_TEXT_CHARS / 4)
  })

  it('continues after a rejected record call and stops only after a successful result', async () => {
    await createStory(dataDir, makeStory())
    await seedPassages(dataDir, 6)

    await deriveNextSummaryRollupNode(dataDir, 'story-test')

    const settings = agentMock.mock.calls[0][0] as {
      stopWhen: Array<(args: { steps: Array<{ toolCalls?: unknown[]; toolResults?: Array<{ toolName: string; output: unknown }> }> }) => boolean>
    }
    const terminal = settings.stopWhen[0]
    expect(terminal({
      steps: [{ toolCalls: [{ toolName: 'recordRollup' }], toolResults: [] }],
    })).toBe(false)
    expect(terminal({
      steps: [{ toolResults: [{ toolName: 'recordRollup', output: { ok: true } }] }],
    })).toBe(true)
  })

  it('does not reuse a persistent roll-up until the served model is observed after restart', async () => {
    await createStory(dataDir, makeStory())
    await seedPassages(dataDir, 6)
    const servedModels = ['qwen3-30b', 'gemma-31b']
    streamMock.mockImplementation(async () => {
      const servedModelId = servedModels.shift()!
      return {
        fullStream: (async function* () {
          yield {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'recordRollup',
            input: { title: 'The Gate Opened', text: 'The gate had opened.' },
          }
          yield {
            type: 'tool-result' as const,
            toolCallId: 'call-1',
            toolName: 'recordRollup',
            output: { ok: true },
          }
          yield { type: 'finish-step' as const, response: { modelId: servedModelId } }
          yield { type: 'finish' as const, finishReason: 'tool-calls' }
        })(),
        totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 10 }),
      }
    })

    await deriveNextSummaryRollupNode(dataDir, 'story-test')
    clearServedModelObservations() // a new process cannot trust the old endpoint identity
    await deriveNextSummaryRollupNode(dataDir, 'story-test')

    expect(streamMock).toHaveBeenCalledTimes(2)
    const nodes = await listSummaryRollupNodes(dataDir, 'story-test')
    expect(nodes).toHaveLength(2)
    expect(new Set(nodes.map((node) => node.modelConfigKey)).size).toBe(2)
  })

  it('fails the derivation rather than caching a node when no record is reported', async () => {
    await createStory(dataDir, makeStory())
    await seedPassages(dataDir, 6)
    streamMock.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'text-delta' as const, text: '{"title": "Truncated' }
        yield { type: 'finish' as const, finishReason: 'length' }
      })(),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 10 }),
    }))

    await expect(deriveNextSummaryRollupNode(dataDir, 'story-test')).rejects.toThrow('reported no record')
    expect(await listSummaryRollupNodes(dataDir, 'story-test')).toEqual([])
  })

  it('does not derive nodes when automatic librarian work is disabled', async () => {
    await createStory(dataDir, makeStory({ disableLibrarianAutoAnalysis: true }))
    expect(await deriveNextSummaryRollupNode(dataDir, 'story-test')).toBeNull()
    expect(streamMock).not.toHaveBeenCalled()
  })
})
