import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempDir, makeTestSettings, seedTestProvider } from '../setup'
import { createFragment, createStory, getStory, listFragments } from '@/server/fragments/storage'
import { syncStorySetupSnapshot } from '@/server/story-setup/sync'
import type { StoryMeta } from '@/server/fragments/schema'

const { mockAgentCtor, mockAgentStream } = vi.hoisted(() => ({
  mockAgentCtor: vi.fn(),
  mockAgentStream: vi.fn(),
}))

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
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

  it('assesses existing material before opening with a focused question', async () => {
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
      instructions: expect.stringMatching(/one focused question at a time[\s\S]*Starting point[\s\S]*Opening direction/),
      tools: expect.objectContaining({
        updateStorySetup: expect.anything(),
      }),
    }))
    expect(mockAgentStream).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: 'user', content: expect.stringContaining('Assess the checklist against the current story material') }],
    }))
  })

  it('includes existing setup fragments when the writer returns to refine the story', async () => {
    await syncStorySetupSnapshot(dataDir, 'story-setup-test', {
      story: { name: 'The Memory Courier', description: 'A courier carries a stolen memory.' },
      fragments: [{
        key: 'mara',
        type: 'character',
        name: 'Mara',
        description: 'Courier with a stolen memory',
        content: 'Mara is cautious and wants to learn who altered her childhood.',
      }],
    })
    mockChatResponse('What would you like to sharpen about Mara?')

    const response = await app.fetch(new Request(
      'http://localhost/api/stories/story-setup-test/setup/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      },
    ))

    expect(response.status).toBe(200)
    expect(mockAgentCtor).toHaveBeenCalledWith(expect.objectContaining({
      instructions: expect.stringMatching(/Existing story setup fragments[\s\S]*Mara[\s\S]*altered her childhood/),
    }))
  })

  it('keeps assessment turns read-only until the writer responds', async () => {
    mockChatResponse('What part of this idea would you like to sharpen?')

    const response = await app.fetch(new Request(
      'http://localhost/api/stories/story-setup-test/setup/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [], mode: 'assess' }),
      },
    ))

    expect(response.status).toBe(200)
    const config = mockAgentCtor.mock.calls.at(-1)?.[0] as {
      tools: {
        updateStorySetup: {
          execute: (input: {
            checklist: Array<{ key: string; status: string; note: string }>
          }) => Promise<{ saved: boolean; checklist: Array<{ key: string; status: string; note: string }> }>
        }
      }
    }
    const result = await config.tools.updateStorySetup.execute({
      checklist: [{ key: 'starting-point', status: 'partial', note: 'A clue' }],
    })

    expect(result.saved).toBe(false)
    expect(result.checklist).toEqual([{ key: 'starting-point', status: 'partial', note: 'A clue' }])
    expect((await getStory(dataDir, 'story-setup-test'))?.name).toBe('New Story')
    expect(await listFragments(dataDir, 'story-setup-test')).toEqual([])
  })

  it('uses writer-owned fragments to assess coverage without treating them as setup drafts', async () => {
    const now = new Date().toISOString()
    await createFragment(dataDir, 'story-setup-test', {
      id: 'character-victoria',
      type: 'character',
      name: 'Crown Princess Victoria',
      description: 'Heir balancing public duty and private identity',
      content: 'Victoria is the established protagonist and heir apparent.',
      tags: [],
      refs: [],
      sticky: true,
      placement: 'user',
      createdAt: now,
      updatedAt: now,
      order: 0,
      meta: {},
      archived: false,
      version: 1,
      versions: [],
    })
    mockChatResponse('Which unresolved pressure on Victoria would you like to explore?')

    const response = await app.fetch(new Request(
      'http://localhost/api/stories/story-setup-test/setup/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      },
    ))

    expect(response.status).toBe(200)
    expect(mockAgentCtor).toHaveBeenCalledWith(expect.objectContaining({
      instructions: expect.stringMatching(/writer-owned context blocks[\s\S]*read-only/),
    }))
    expect(mockAgentStream).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringMatching(/Existing Writer-Owned Story Material[\s\S]*Crown Princess Victoria[\s\S]*established protagonist/),
        }),
      ]),
    }))
  })

  it('streams checklist progress and draft fragments with the next question', async () => {
    async function* checklistStream() {
      yield {
        type: 'tool-call',
        toolCallId: 'checklist-1',
        toolName: 'updateStorySetup',
        input: {
          checklist: [
            { key: 'starting-point', status: 'covered', note: 'A stolen memory premise' },
            { key: 'characters', status: 'partial', note: 'Mara needs motivation' },
          ],
          fragments: [{
            key: 'mara',
            type: 'character',
            name: 'Mara',
            description: 'Courier carrying a stolen memory',
            content: 'Mara is a courier whose motivation is still undecided.',
          }],
        },
      }
      yield {
        type: 'tool-result',
        toolCallId: 'checklist-1',
        toolName: 'updateStorySetup',
        output: { accepted: true },
      }
      yield { type: 'text-delta', text: 'What does Mara want badly enough to take this risk?' }
      yield { type: 'finish', finishReason: 'stop' }
    }

    mockAgentStream.mockResolvedValue({
      fullStream: checklistStream(),
      text: Promise.resolve('What does Mara want badly enough to take this risk?'),
      reasoning: Promise.resolve(''),
      toolCalls: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve(undefined),
    })

    const response = await app.fetch(new Request(
      'http://localhost/api/stories/story-setup-test/setup/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'A courier named Mara carrying a stolen memory.' }],
        }),
      },
    ))

    const events = (await response.text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      toolName: 'updateStorySetup',
      args: expect.objectContaining({
        checklist: expect.arrayContaining([
          expect.objectContaining({ key: 'starting-point', status: 'covered' }),
        ]),
        fragments: expect.arrayContaining([
          expect.objectContaining({ type: 'character', name: 'Mara' }),
        ]),
      }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('What does Mara want'),
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

})
