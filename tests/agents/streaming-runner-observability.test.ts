import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, seedTestProvider, makeTestSettings } from '../setup'
import { createStory, createFragment } from '@/server/fragments/storage'
import type { StoryMeta, Fragment } from '@/server/fragments/schema'
import { listActiveAgents } from '@/server/agents/active-registry'
import { listAgentRuns, clearAgentRuns } from '@/server/agents/traces'

const { mockAgentCtor, mockAgentStream } = vi.hoisted(() => ({
  mockAgentCtor: vi.fn(),
  mockAgentStream: vi.fn(),
}))

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    ToolLoopAgent: class {
      constructor(config: unknown) {
        mockAgentCtor(config)
      }

      stream(args: unknown) {
        return mockAgentStream(args)
      }
    },
  }
})

// Importing createApp first resolves the module graph the same safe way every
// other route-level test does. `librarian/refine.ts` sits on a real circular
// import (create-streaming-runner → llm/client → agents/register-core →
// character-chat/agents → character-chat/chat → create-streaming-runner);
// loading it as the first thing in a fresh module graph hits that cycle
// mid-evaluation. Pre-existing, unrelated to this test's own additions.
import '@/server/api'
import { createAgentInstance } from '@/server/agents/agent-instance'
import { ensureCoreAgentsRegistered } from '@/server/agents'

async function* fullStreamOf(parts: Array<{ type: string; [key: string]: unknown }>): AsyncGenerator<unknown> {
  for (const part of parts) yield part
}

async function drain(stream: ReadableStream<string>): Promise<void> {
  const reader = stream.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
  reader.releaseLock()
}

function makeStory(overrides: Partial<StoryMeta> = {}): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-observability',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
    ...overrides,
  }
}

function makeFragment(overrides: Partial<Fragment>): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'ch-0001',
    type: 'character',
    name: 'Alice',
    description: 'The protagonist',
    content: 'Alice is a brave warrior.',
    tags: [],
    refs: [],
    sticky: true,
    placement: 'user' as const,
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    archived: false,
    ...overrides,
  }
}

// createStreamingRunner-based agents (refine, optimize-character, prose-transform,
// character-chat) get NO active-marker/trace registration of their own — that's
// deliberate, not a gap: their only production caller is createAgentInstance
// (routes/librarian.ts, routes/character-chat.ts), which already wraps the whole
// call in beginAgentRun and taps the caller stream into the run's activity trace.
// This proves that real, un-mocked mechanism actually works end-to-end — nothing
// exercised it before (refine.test.ts stubs createAgentInstance out entirely).
describe('createAgentInstance observability (wrapping a createStreamingRunner agent)', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ensureCoreAgentsRegistered()
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await seedTestProvider(dataDir)
    mockAgentCtor.mockClear()
    mockAgentStream.mockClear()
    clearAgentRuns()
  })

  afterEach(async () => {
    await cleanup()
  })

  it('registers the run as active while streaming, mirrors events into the trace, and records success', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await createFragment(dataDir, story.id, makeFragment({}))

    mockAgentStream.mockResolvedValue({
      fullStream: fullStreamOf([
        { type: 'text-delta', text: 'Revised sheet.' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    })

    const instance = createAgentInstance('librarian.refine', { dataDir, storyId: story.id })
    const result = await instance.execute({ fragmentId: 'ch-0001' })

    // Active the instant execute() returns — before the stream is drained.
    expect(listActiveAgents(story.id).map(a => a.agentName)).toContain('librarian.refine')

    await drain(result.eventStream)
    await result.completion

    expect(listActiveAgents(story.id).map(a => a.agentName)).not.toContain('librarian.refine')

    const runs = listAgentRuns(story.id)
    const refineRun = runs.find(r => r.agentName === 'librarian.refine')
    expect(refineRun).toBeDefined()
    expect(refineRun!.status).toBe('success')
    // The instance taps the stream into the run's own trace (not just history's
    // single summarized entry) without creating a cancellation-blocking branch.
    expect(refineRun!.trace.length).toBeGreaterThan(0)
  })

  it('propagates caller cancellation to the underlying model run', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await createFragment(dataDir, story.id, makeFragment({}))

    let modelSignal: AbortSignal | undefined
    let releaseProvider: (() => void) | undefined
    mockAgentStream.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => {
      modelSignal = abortSignal
      return Promise.resolve({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'Partial response' }
          await new Promise<void>(resolve => { releaseProvider = resolve })
          if (abortSignal.aborted) {
            const error = new Error('aborted')
            error.name = 'AbortError'
            throw error
          }
        })(),
        totalUsage: Promise.resolve(undefined),
      })
    })

    const instance = createAgentInstance('librarian.refine', { dataDir, storyId: story.id })
    const result = await instance.execute({ fragmentId: 'ch-0001' })
    const reader = result.eventStream.getReader()
    await reader.read()

    const cancel = reader.cancel()
    await vi.waitFor(() => expect(modelSignal?.aborted).toBe(true))
    releaseProvider?.()
    await cancel
    await result.completion.catch(() => {})

    expect(listActiveAgents(story.id).map(a => a.agentName)).not.toContain('librarian.refine')
  })

  it('records the run as an error when the stream rejects', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await createFragment(dataDir, story.id, makeFragment({}))

    async function* throwingStream(): AsyncGenerator<unknown> {
      yield { type: 'text-delta', text: 'partial' }
      throw new Error('provider exploded')
    }

    mockAgentStream.mockResolvedValue({
      fullStream: throwingStream(),
      totalUsage: Promise.resolve(undefined),
    })

    const instance = createAgentInstance('librarian.refine', { dataDir, storyId: story.id })
    const result = await instance.execute({ fragmentId: 'ch-0001' })
    await drain(result.eventStream).catch(() => {})
    await result.completion.catch(() => {})

    expect(listActiveAgents(story.id).map(a => a.agentName)).not.toContain('librarian.refine')
    const runs = listAgentRuns(story.id)
    const refineRun = runs.find(r => r.agentName === 'librarian.refine')
    expect(refineRun).toBeDefined()
    expect(refineRun!.status).toBe('error')
  })
})
