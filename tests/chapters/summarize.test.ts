import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempDir, makeTestSettings, seedTestProvider } from '../setup'
import { createFragment, createStory, getFragment } from '@/server/fragments/storage'
import { addProseSection, initProseChain } from '@/server/fragments/prose-chain'
import { saveAgentBlockConfig } from '@/server/agents/agent-block-storage'
import { ensureCoreAgentsRegistered } from '@/server/agents'
import { summarizeChapter } from '@/server/chapters/summarize'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'

const { mockAgentConfig, mockStreamArgs } = vi.hoisted(() => ({
  mockAgentConfig: vi.fn(),
  mockStreamArgs: vi.fn(),
}))

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    ToolLoopAgent: class {
      constructor(config: unknown) {
        mockAgentConfig(config)
      }

      stream(args: unknown) {
        mockStreamArgs(args)
        return Promise.resolve({
          fullStream: (async function* () {
            yield { type: 'reasoning-delta', text: 'Condense the scene.' }
            yield { type: 'text-delta', text: 'Mara crosses the flooded hall.' }
            yield { type: 'finish-step', response: { modelId: 'served-summary-model' } }
            yield { type: 'finish', finishReason: 'stop' }
          })(),
          totalUsage: Promise.resolve({ inputTokens: 20, outputTokens: 8 }),
        })
      }
    },
  }
})

const STORY_ID = 'chapter-summary-story'
const now = new Date().toISOString()

function fragment(id: string, type: Fragment['type'], content: string): Fragment {
  return {
    id,
    type,
    name: id,
    description: '',
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
  }
}

describe('chapter summarization', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const temp = await createTempDir()
    dataDir = temp.path
    cleanup = temp.cleanup
    await seedTestProvider(dataDir)
    await createStory(dataDir, {
      id: STORY_ID,
      name: 'Summary Test',
      description: '',
      coverImage: null,
      createdAt: now,
      updatedAt: now,
      settings: makeTestSettings(),
    } satisfies StoryMeta)
    ensureCoreAgentsRegistered()
    mockAgentConfig.mockClear()
    mockStreamArgs.mockClear()
  })

  afterEach(async () => cleanup())

  it('uses shared block overrides, summarizes only the selected chapter, and saves the result', async () => {
    const fragments = [
      fragment('mk-first', 'marker', ''),
      fragment('pr-first', 'prose', 'Mara enters the flooded hall.'),
      fragment('pr-second', 'prose', 'She reaches the far door.'),
      fragment('mk-next', 'marker', ''),
      fragment('pr-later', 'prose', 'This belongs to the next chapter.'),
    ]
    for (const item of fragments) await createFragment(dataDir, STORY_ID, item)
    await initProseChain(dataDir, STORY_ID, fragments[0].id)
    for (const item of fragments.slice(1)) await addProseSection(dataDir, STORY_ID, item.id)

    await saveAgentBlockConfig(dataDir, STORY_ID, 'chapters.summarize', {
      customBlocks: [],
      overrides: {
        instructions: { contentMode: 'override', customContent: 'Return one compact sentence.' },
      },
      blockOrder: [],
      disabledTools: [],
    })

    const result = await summarizeChapter(dataDir, STORY_ID, { fragmentId: 'mk-first' })

    expect(mockAgentConfig).toHaveBeenCalledWith(expect.objectContaining({
      instructions: 'Return one compact sentence.',
      tools: {},
      toolChoice: 'none',
    }))
    expect(mockStreamArgs).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{
        role: 'user',
        content: 'Summarize this chapter:\n\nMara enters the flooded hall.\n\nShe reaches the far door.',
      }],
    }))
    expect(JSON.stringify(mockStreamArgs.mock.calls)).not.toContain('This belongs to the next chapter.')
    expect(result).toMatchObject({
      summary: 'Mara crosses the flooded hall.',
      reasoning: 'Condense the scene.',
      modelId: 'served-summary-model',
    })
    expect((await getFragment(dataDir, STORY_ID, 'mk-first'))?.content)
      .toBe('Mara crosses the flooded hall.')
  })
})
