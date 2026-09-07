import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempDir, makeTestSettings, seedTestProvider } from '../setup'
import { createStory } from '@/server/fragments/storage'
import { saveAgentBlockConfig } from '@/server/agents/agent-block-storage'
import { ensureCoreAgentsRegistered } from '@/server/agents'
import { proposeDirections } from '@/server/directions/suggest'
import type { StoryMeta } from '@/server/fragments/schema'

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
            yield {
              type: 'text-delta',
              text: JSON.stringify([{
                title: 'Open the Door',
                description: 'Mara chooses whether to enter.',
                instruction: 'Continue with Mara opening the door.',
              }]),
            }
            yield { type: 'finish-step', response: { modelId: 'served-direction-model' } }
            yield { type: 'finish', finishReason: 'stop' }
          })(),
          totalUsage: Promise.resolve({ inputTokens: 12, outputTokens: 9 }),
        })
      }
    },
  }
})

const STORY_ID = 'direction-runtime-story'
const now = new Date().toISOString()

describe('direction proposal runtime', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const temp = await createTempDir()
    dataDir = temp.path
    cleanup = temp.cleanup
    await seedTestProvider(dataDir)
    await createStory(dataDir, {
      id: STORY_ID,
      name: 'Direction Test',
      description: '',
      coverImage: null,
      createdAt: now,
      updatedAt: now,
      settings: makeTestSettings({
        guidedSuggestPrompt: 'Return {{count}} focused options.',
      }),
    } satisfies StoryMeta)
    ensureCoreAgentsRegistered()
    mockAgentConfig.mockClear()
    mockStreamArgs.mockClear()
  })

  afterEach(async () => cleanup())

  it('uses the shared context compiler and preserves the configured request template', async () => {
    await saveAgentBlockConfig(dataDir, STORY_ID, 'directions.suggest', {
      customBlocks: [],
      overrides: {
        instructions: { contentMode: 'override', customContent: 'Choose plausible next scenes.' },
      },
      blockOrder: [],
      disabledTools: [],
    })

    const result = await proposeDirections(dataDir, STORY_ID, { count: 1 })

    expect(mockAgentConfig).toHaveBeenCalledWith(expect.objectContaining({
      instructions: 'Choose plausible next scenes.',
      tools: {},
      toolChoice: 'none',
    }))
    const streamCall = mockStreamArgs.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    expect(streamCall.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Return 1 focused options.',
    })
    expect(result).toMatchObject({
      modelId: 'served-direction-model',
      stepCount: 1,
      finishReason: 'stop',
      suggestions: [{ title: 'Open the Door' }],
    })
  })
})
