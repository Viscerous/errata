import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempDir, makeTestSettings, seedTestProvider } from '../setup'
import { createStory, getStory, listFragments } from '@/server/fragments/storage'
import { getProseChain } from '@/server/fragments/prose-chain'
import type { StoryMeta } from '@/server/fragments/schema'

const { mockAgentCtor, mockAgentStream, mockGenerateText } = vi.hoisted(() => ({
  mockAgentCtor: vi.fn(),
  mockAgentStream: vi.fn(),
  mockGenerateText: vi.fn(),
}))

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateText: mockGenerateText,
    ToolLoopAgent: class MockToolLoopAgent {
      constructor(config: unknown) {
        mockAgentCtor(config)
      }

      stream = mockAgentStream
    },
  }
})

import { createApp } from '@/server/api'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-setup-test',
    name: 'New Story',
    description: '',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

async function* fullStream(text: string) {
  yield { type: 'text-delta', text }
  yield { type: 'finish', finishReason: 'stop' }
}

function mockChatResponse(text: string) {
  mockAgentStream.mockResolvedValue({
    fullStream: fullStream(text),
    text: Promise.resolve(text),
    reasoning: Promise.resolve(''),
    toolCalls: Promise.resolve([]),
    finishReason: Promise.resolve('stop'),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve(undefined),
  })
}

describe('story setup routes', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await seedTestProvider(dataDir)
    await createStory(dataDir, makeStory())
    app = createApp(dataDir)
  })

  afterEach(async () => {
    await cleanup()
  })

  it('lets the model open the conversation with a focused question', async () => {
    mockChatResponse('What are you starting with: a premise, a character, a scene, or only a mood?')

    const response = await app.fetch(new Request(
      'http://localhost/api/stories/story-setup-test/setup/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      },
    ))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('What are you starting with')
    expect(mockAgentCtor).toHaveBeenCalledWith(expect.objectContaining({
      instructions: expect.stringContaining('one focused question at a time'),
    }))
    expect(mockAgentStream).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: 'user', content: expect.stringContaining('Begin the story setup conversation') }],
    }))
  })

  it('passes the full setup conversation back to the model', async () => {
    mockChatResponse('What does Mara want badly enough to risk that?')
    const messages = [
      { role: 'assistant', content: 'What are you starting with?' },
      { role: 'user', content: 'A courier named Mara carrying a stolen memory.' },
    ]

    const response = await app.fetch(new Request(
      'http://localhost/api/stories/story-setup-test/setup/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      },
    ))

    expect(response.status).toBe(200)
    expect(mockAgentStream).toHaveBeenCalledWith(expect.objectContaining({ messages }))
  })

  it('turns the conversation into validated story fragments only when requested', async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        name: 'The Memory Courier',
        description: 'A courier must deliver a stolen memory before it rewrites her past.',
        guideline: 'Close third person through Mara. Tense, tactile prose with restrained exposition.',
        knowledge: [{
          name: 'Memory trade',
          description: 'Rules of bought memories',
          content: 'Memories can be copied, sold, and altered. Copies decay each time they change hands.',
        }],
        characters: [{
          name: 'Mara Venn',
          description: 'Courier with a missing past',
          content: 'Mara is a careful black-market courier who has gaps in her own childhood memories.',
        }],
        opening: 'Mara knew the memory was stolen because it was still warm.',
      },
      totalUsage: undefined,
    })

    const response = await app.fetch(new Request(
      'http://localhost/api/stories/story-setup-test/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'assistant', content: 'What are you starting with?' },
            { role: 'user', content: 'A courier named Mara carrying a stolen memory.' },
          ],
        }),
      },
    ))

    expect(response.status).toBe(200)
    const body = await response.json() as { created: Array<{ type: string; name: string }> }
    expect(body.created.map(item => item.type)).toEqual([
      'guideline',
      'knowledge',
      'character',
      'prose',
    ])

    const story = await getStory(dataDir, 'story-setup-test')
    expect(story?.name).toBe('The Memory Courier')
    expect(story?.description).toContain('stolen memory')

    const fragments = await listFragments(dataDir, 'story-setup-test')
    expect(fragments).toHaveLength(4)
    expect(fragments.find(fragment => fragment.type === 'guideline')).toMatchObject({
      sticky: true,
      placement: 'system',
    })
    expect(fragments.find(fragment => fragment.type === 'character')).toMatchObject({
      sticky: true,
      name: 'Mara Venn',
    })

    const chain = await getProseChain(dataDir, 'story-setup-test')
    expect(chain?.entries).toHaveLength(1)
  })

  it('requires at least one user answer before creating the story', async () => {
    const response = await app.fetch(new Request(
      'http://localhost/api/stories/story-setup-test/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'assistant', content: 'What are you starting with?' }],
        }),
      },
    ))

    expect(response.status).toBe(422)
    expect(mockGenerateText).not.toHaveBeenCalled()
  })
})
