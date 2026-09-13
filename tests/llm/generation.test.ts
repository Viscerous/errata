import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, seedTestProvider, makeTestSettings } from '../setup'
import {
  createStory,
  createFragment,
  getFragment,
  listFragments,
  updateStory,
} from '@/server/fragments/storage'
import { saveAgentBlockConfig } from '@/server/agents/agent-block-storage'
import { listAgentRuns, clearAgentRuns } from '@/server/agents/traces'
import { clearPending, getPendingCount } from '@/server/librarian/scheduler'
import { addProseSection, getProseChain } from '@/server/fragments/prose-chain'
import { saveAnalysis, getAnalysisIndex, type LibrarianAnalysis } from '@/server/librarian/storage'
import { SUMMARY_CONTRACT_VERSION } from '@/server/librarian/summary-contract'
import type { StoryMeta, Fragment } from '@/contracts/story'
import { composeGeneratedProse, stripAuthorTurnEcho } from '@/contracts/generation'

const { mockAgentCtor, mockAgentStream } = vi.hoisted(() => ({
  mockAgentCtor: vi.fn(),
  mockAgentStream: vi.fn(),
}))

// Mock the AI SDK ToolLoopAgent
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

// Stub only the index's invokeAgent so the librarian run the scheduler now fires stays
// in-flight; generation.ts imports its own from '../agents/runner', so it's unaffected.
vi.mock('@/server/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/agents')>()
  return { ...actual, invokeAgent: vi.fn(() => new Promise(() => {})) }
})

import { createApp } from '@/server/api'

describe('Play turn joining', () => {
  it('removes only a complete echoed turn', () => {
    expect(stripAuthorTurnEcho('I wait.', 'I wait.\n\nThe door opens.')).toBe('The door opens.')
    expect(stripAuthorTurnEcho('I', 'It starts to rain.')).toBe('It starts to rain.')
  })
})

describe('composeGeneratedProse', () => {
  it('returns generated prose directly for both direct and play modes', () => {
    expect(composeGeneratedProse('Direction brief', 'The storm arrived.', 'direct')).toBe('The storm arrived.')
    expect(composeGeneratedProse('I wait.', 'I wait at the station. The train pulls in.', 'play')).toBe('I wait at the station. The train pulls in.')
  })
})

function makeStory(settingsOverrides?: Partial<StoryMeta['settings']>): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(settingsOverrides),
  }
}

function makeFragment(overrides: Partial<Fragment>): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'pr-0001',
    type: 'prose',
    name: 'Test',
    description: 'A test fragment',
    content: 'Test content',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user' as const,
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    ...overrides,
  }
}

function makeAnalysis(fragmentId: string): LibrarianAnalysis {
  return {
    id: `la-${fragmentId}`, fragmentId, createdAt: new Date().toISOString(),
    summaryUpdate: 'Previous report.', summaryContractVersion: SUMMARY_CONTRACT_VERSION,
    mentions: [], candidateFragmentIds: [], candidateFragments: [], contradictions: [],
    timelineEvents: [], fragmentChangeProposals: [], directions: [], passes: [], trace: [],
  }
}

/** Extract text from a message content that may be a string or an array of TextParts */
function extractText(content: string | Array<{ type: string; text: string }>): string {
  if (typeof content === 'string') return content
  return content.map(p => p.text).join('')
}

function extractMessageText(messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>, role: string): string {
  return messages
    .filter(message => message.role === role)
    .map(message => extractText(message.content))
    .join('\n\n')
}

function createMockStreamResult(text: string, finishReason = 'stop') {
  // Create a minimal mock that mimics the streamText result
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })

  // Create a proper ReadableStream for textStream that supports tee()
  const textStream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text)
      controller.close()
    },
  })

  // fullStream: async iterable of AI SDK v6 TextStreamPart events
  async function* generateFullStream() {
    yield { type: 'text-delta' as const, text }
    yield { type: 'finish' as const, finishReason }
  }
  const fullStream = generateFullStream()

  return {
    textStream,
    fullStream,
    text: Promise.resolve(text),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 20 }),
    finishReason: Promise.resolve(finishReason),
    steps: Promise.resolve([]),
    toTextStreamResponse: () => new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
    toUIMessageStreamResponse: () => new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
  }
}

/** A stream result whose fullStream emits some text then throws (provider error). */
function createThrowingStreamResult(partialText: string) {
  async function* generateFullStream() {
    if (partialText) yield { type: 'text-delta' as const, text: partialText }
    throw new Error('provider exploded mid-stream')
  }
  return {
    fullStream: generateFullStream(),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    finishReason: Promise.resolve('error' as const),
  }
}

describe('generation endpoint', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  const storyId = 'story-test'

  async function api(path: string, init?: RequestInit) {
    const res = await app.fetch(
      new Request(`http://localhost/api${path}`, init),
    )
    return res
  }

  beforeEach(async () => {
    clearPending()
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await seedTestProvider(dataDir)
    app = createApp(dataDir)
    await createStory(dataDir, makeStory())
    vi.clearAllMocks()
  })

  afterEach(async () => {
    clearPending()
    await cleanup()
  })

  it('POST /stories/:storyId/generate calls writer agent with correct context', async () => {
    const guideline = makeFragment({
      id: 'gl-0001',
      type: 'guideline',
      name: 'Tone',
      description: 'Writing tone',
      content: 'Dark gothic style.',
      sticky: true,
    })
    await createFragment(dataDir, storyId, guideline)

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('The shadows deepened.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Continue the story',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(mockAgentStream).toHaveBeenCalledTimes(1)

    const callArgs = mockAgentStream.mock.calls[0][0] as any
    expect(callArgs.messages).toBeDefined()
    const msg = callArgs.messages!.find((m: any) => m.role === 'user')
    const userText = extractText(msg!.content)
    expect(userText).toContain('Dark gothic style.')
    expect(userText).toContain('Continue the story')
  })

  it('records the writer run in the agent activity history', async () => {
    clearAgentRuns(storyId)
    mockAgentStream.mockResolvedValue(createMockStreamResult('A line.') as any)

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Continue the story', saveResult: false }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const runs = listAgentRuns(storyId)
    expect(runs.some(r => r.agentName === 'generation.writer' && r.status === 'success')).toBe(true)
  })

  it('does NOT save a fragment when the stream fails (non-abort error)', async () => {
    mockAgentStream.mockResolvedValue(createThrowingStreamResult('partial prose that never finished') as any)

    const before = await listFragments(dataDir, storyId, 'prose')

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Continue', saveResult: true }),
    })

    // Drain the (errored) body so the server-side stream runs to completion.
    await res.text().catch(() => {})
    await new Promise((r) => setTimeout(r, 50))

    const after = await listFragments(dataDir, storyId, 'prose')
    expect(after.length).toBe(before.length) // no phantom fragment persisted
    expect(getPendingCount()).toBe(0) // librarian not triggered for a failed run
  })

  it('quarantines output that ends at the token limit instead of saving or analyzing it', async () => {
    mockAgentStream.mockResolvedValue(
      createMockStreamResult('An unfinished passage that reached the cap.', 'length') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Continue', saveResult: true }),
    })

    expect(res.status).toBe(200)
    const streamed = await res.text()
    expect(streamed).toContain('"type":"generation-rejected"')
    expect(streamed).toContain('"code":"incomplete_finish"')

    expect(await listFragments(dataDir, storyId, 'prose')).toHaveLength(0)
    expect(getPendingCount()).toBe(0)

    const { listGenerationLogs, getGenerationLog } = await import('@/server/llm/generation-logs')
    const logs = await listGenerationLogs(dataDir, storyId)
    expect(logs).toHaveLength(1)
    const log = await getGenerationLog(dataDir, storyId, logs[0].id)
    expect(log).toMatchObject({
      fragmentId: null,
      finishReason: 'length',
      commitStatus: 'rejected',
      rejectionCode: 'incomplete_finish',
    })
  })

  it('commits successful model content without judging its syntax', async () => {
    mockAgentStream.mockResolvedValue(
      createMockStreamResult('.thought\nReady. Proceed. Final check. Ready.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Continue', saveResult: true }),
    })

    const streamed = await res.text()
    expect(streamed).not.toContain('"type":"generation-rejected"')
    const prose = await listFragments(dataDir, storyId, 'prose')
    expect(prose).toHaveLength(1)
    expect(prose[0].content).toBe('.thought\nReady. Proceed. Final check. Ready.')
    expect(getPendingCount()).toBe(1)

    const { listGenerationLogs, getGenerationLog } = await import('@/server/llm/generation-logs')
    const logs = await listGenerationLogs(dataDir, storyId)
    const log = await getGenerationLog(dataDir, storyId, logs[0].id)
    expect(log).toMatchObject({
      fragmentId: prose[0].id,
      finishReason: 'stop',
      commitStatus: 'committed',
    })
  })

  it('POST /stories/:storyId/generate applies writer instruction replacement from agent config', async () => {
    await saveAgentBlockConfig(dataDir, storyId, 'generation.writer', {
      customBlocks: [],
      overrides: {
        instructions: {
          contentMode: 'override',
          customContent: 'You are a haiku-only writing engine.',
        },
      },
      blockOrder: [],
      disabledTools: [],
    })

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('Generated text.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Write something',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(200)

    const callArgs = mockAgentStream.mock.calls[0][0] as any
    const systemText = extractMessageText(callArgs.messages, 'system')
    expect(systemText).toContain('You are a haiku-only writing engine.')
    expect(systemText).not.toContain('You are a fiction writer continuing an ongoing story. Write the next passage of prose following the author\'s direction.')
  })

  it('POST /stories/:storyId/generate applies writer instruction prepend from agent config', async () => {
    await saveAgentBlockConfig(dataDir, storyId, 'generation.writer', {
      customBlocks: [],
      overrides: {
        instructions: {
          contentMode: 'prepend',
          customContent: 'BEGIN WITH SPARE, CLIPPED SENTENCES.',
        },
      },
      blockOrder: [],
      disabledTools: [],
    })

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('Generated text.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Write something',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(200)

    const callArgs = mockAgentStream.mock.calls[0][0] as any
    const systemText = extractMessageText(callArgs.messages, 'system')
    expect(systemText).toContain('BEGIN WITH SPARE, CLIPPED SENTENCES.')
    expect(systemText).not.toContain('[@block=')
  })

  it('POST /stories/:storyId/generate passes resolved sampling settings to the writer agent', async () => {
    const story = makeStory({
      modelOverrides: {
        'generation.writer': { temperature: 0.42, topP: 0.9, topK: 64 },
      },
    })
    await updateStory(dataDir, story)

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('Generated text.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Write something',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(200)

    const callArgs = mockAgentCtor.mock.calls[0][0] as any
    expect(callArgs.temperature).toBe(0.42)
    expect(callArgs.topP).toBe(0.9)
    expect(callArgs.topK).toBe(64)
  })

  it('POST /stories/:storyId/generate caps the writer agent output tokens from generationLimits', async () => {
    const story = makeStory({ generationLimits: { maxOutputTokens: 4096 } })
    await updateStory(dataDir, story)

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('Generated text.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Write something',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(200)

    const callArgs = mockAgentCtor.mock.calls[0][0] as any
    expect(callArgs.maxOutputTokens).toBe(4096)
  })

  it('POST /stories/:storyId/generate includes fragment tools', async () => {
    mockAgentStream.mockResolvedValue(
      createMockStreamResult('Generated text.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Write something',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(200)

    const callArgs = mockAgentCtor.mock.calls[0][0] as any
    expect(callArgs.tools).toBeDefined()
    expect(callArgs.tools).not.toHaveProperty('getCharacter')
    expect(callArgs.tools).not.toHaveProperty('listCharacters')
    expect(callArgs.tools).toHaveProperty('listFragmentTypes')
  })

  it('POST /stories/:storyId/generate includes all tools by default (no disabledTools)', async () => {
    mockAgentStream.mockResolvedValue(
      createMockStreamResult('Generated text.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Write something',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(200)

    const callArgs = mockAgentCtor.mock.calls[0][0] as any
    expect(callArgs.tools).toHaveProperty('listFragmentTypes')
    expect(callArgs.tools).toHaveProperty('readFragments')
    expect(callArgs.tools).toHaveProperty('listFragments')
    expect(callArgs.tools).toHaveProperty('findFragments')
  })

  it('POST /stories/:storyId/generate excludes tools listed in disabledTools', async () => {
    await saveAgentBlockConfig(dataDir, storyId, 'generation.writer', {
      customBlocks: [],
      overrides: {},
      blockOrder: [],
      disabledTools: ['listFragments', 'readFragments', 'findFragments'],
    })

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('Generated text.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Write something',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(200)

    const callArgs = mockAgentCtor.mock.calls[0][0] as any
    expect(callArgs.tools).toHaveProperty('listFragmentTypes')
    expect(callArgs.tools).not.toHaveProperty('listFragments')
    expect(callArgs.tools).not.toHaveProperty('readFragments')
    expect(callArgs.tools).not.toHaveProperty('findFragments')
  })

  it('POST /stories/:storyId/generate saves result when saveResult=true', async () => {
    mockAgentStream.mockResolvedValue(
      createMockStreamResult('The dragon roared.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Add a dragon scene',
        saveResult: true,
      }),
    })

    expect(res.status).toBe(200)

    // Wait for the text to be consumed from stream
    await res.text()

    // Give a moment for async save
    await new Promise((r) => setTimeout(r, 100))

    // Verify the generated prose was saved
    const fragments = await listFragments(dataDir, storyId, 'prose')
    expect(fragments.length).toBe(1)
    expect(fragments[0].content).toBe('The dragon roared.')
    expect(fragments[0].type).toBe('prose')
  })

  it('commits a successful Play turn and continuation as one canonical passage', async () => {
    const authorTurn = 'I test the old brass key. "Please work."'
    mockAgentStream.mockResolvedValue(
      // Completion-oriented models sometimes replay the final input before
      // continuing. The stored passage must still contain one authored turn.
      createMockStreamResult(`${authorTurn}\n\nThe lock gives way with a soft click.`) as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: authorTurn, inputMode: 'play', saveResult: true }),
    })

    expect(res.status).toBe(200)
    await res.text()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const fragments = await listFragments(dataDir, storyId, 'prose')
    expect(fragments).toHaveLength(1)
    expect(fragments[0].content).toBe(`${authorTurn}\n\nThe lock gives way with a soft click.`)
    expect(fragments[0].meta).toMatchObject({
      generatedFrom: authorTurn,
      generatedFromMode: 'play',
    })

    const { listGenerationLogs, getGenerationLog } = await import('@/server/llm/generation-logs')
    const [summary] = await listGenerationLogs(dataDir, storyId)
    const log = await getGenerationLog(dataDir, storyId, summary.id)
    expect(log).toMatchObject({
      generatedText: `${authorTurn}\n\nThe lock gives way with a soft click.`,
    })
  })

  it('switches between Direct and Play within one story without changing the manuscript contract', async () => {
    const direction = 'Bring the storm closer.'
    const authorTurn = 'I close the shutters and turn from the window.'
    mockAgentStream
      .mockResolvedValueOnce(createMockStreamResult('Thunder rolls over the hills.') as any)
      .mockResolvedValueOnce(createMockStreamResult(`${authorTurn}\n\nThe room falls into blue-grey shadow.`) as any)

    for (const body of [
      { input: direction, inputMode: 'direct' },
      { input: authorTurn, inputMode: 'play' },
    ]) {
      const res = await api(`/stories/${storyId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, saveResult: true }),
      })
      expect(res.status).toBe(200)
      await res.text()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const fragments = await listFragments(dataDir, storyId, 'prose')
    expect(fragments.map((fragment) => fragment.content)).toEqual(expect.arrayContaining([
      'Thunder rolls over the hills.',
      `${authorTurn}\n\nThe room falls into blue-grey shadow.`,
    ]))
    expect(fragments.some((fragment) => fragment.content.includes(direction))).toBe(false)
    expect(fragments.map((fragment) => fragment.meta.generatedFromMode)).toEqual(expect.arrayContaining([
      'direct',
      'play',
    ]))
  })

  it('rejects a Play response that only echoes the authored turn', async () => {
    const authorTurn = 'I close the ledger and stand.'
    mockAgentStream.mockResolvedValue(createMockStreamResult(authorTurn) as any)

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: authorTurn, inputMode: 'play', saveResult: true }),
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"code":"empty_output"')
    expect(await listFragments(dataDir, storyId, 'prose')).toHaveLength(0)
  })

  it('POST /stories/:storyId/generate schedules librarian analysis by default after save', async () => {
    mockAgentStream.mockResolvedValue(
      createMockStreamResult('The dragon roared.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Add a dragon scene',
        saveResult: true,
      }),
    })

    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 100))

    expect(getPendingCount()).toBe(1)
  })

  it('POST /stories/:storyId/generate skips librarian analysis when auto analysis is disabled', async () => {
    clearPending()
    const story = makeStory({ disableLibrarianAutoAnalysis: true })
    await updateStory(dataDir, story)

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('The dragon roared.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Add a dragon scene',
        saveResult: true,
      }),
    })

    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 100))

    expect(getPendingCount()).toBe(0)
  })

  it('returns 404 for non-existent story', async () => {
    const res = await api('/stories/nonexistent/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Hello',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(404)
  })

  it('returns 400 when input is empty', async () => {
    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: '',
        saveResult: false,
      }),
    })

    expect(res.status).toBe(422)
  })

  // --- Regenerate mode ---

  it('regenerate mode creates a variation without changing the source', async () => {
    const original = makeFragment({
      id: 'pr-regen',
      content: 'Original prose content.',
    })
    await createFragment(dataDir, storyId, original)
    await addProseSection(dataDir, storyId, original.id)
    await saveAnalysis(dataDir, storyId, makeAnalysis(original.id))

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('Regenerated prose content.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Take a different direction',
        saveResult: true,
        mode: 'regenerate',
        fragmentId: 'pr-regen',
      }),
    })

    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 100))

    // Original fragment should be unchanged
    const originalFragment = await getFragment(dataDir, storyId, 'pr-regen')
    expect(originalFragment!.content).toBe('Original prose content.')

    // A new variation fragment should be created
    const allFragments = await listFragments(dataDir, storyId, 'prose')
    const variation = allFragments.find((f) => f.meta?.variationOf === 'pr-regen')
    expect(variation).toBeDefined()
    expect(variation!.content).toBe('Regenerated prose content.')
    expect(variation!.meta.generationMode).toBe('regenerate')
    expect((await getProseChain(dataDir, storyId))?.entries[0].active).toBe(variation!.id)
    expect((await getAnalysisIndex(dataDir, storyId))?.latestByFragmentId[original.id]).toBeUndefined()

    // Should have 2 fragments now (original + variation)
    expect(allFragments.length).toBe(2)
  })

  // --- Refine mode ---

  it('refine mode includes existing content in prompt and replaces fragment', async () => {
    const original = makeFragment({
      id: 'pr-refine',
      content: 'The hero walked slowly through the forest.',
    })
    await createFragment(dataDir, storyId, original)
    await addProseSection(dataDir, storyId, original.id)
    await saveAnalysis(dataDir, storyId, makeAnalysis(original.id))

    mockAgentStream.mockResolvedValue(
      createMockStreamResult('The hero crept through the dark forest.') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Make it more suspenseful',
        saveResult: true,
        mode: 'refine',
        fragmentId: 'pr-refine',
      }),
    })

    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 100))

    // Verify the prompt included existing content
    const callArgs = mockAgentStream.mock.calls[0][0] as any
    const userMsg = callArgs.messages!.find((m: any) => m.role === 'user')
    const userText = extractText(userMsg!.content)
    expect(userText).toContain('The hero walked slowly through the forest.')
    expect(userText).toContain('Make it more suspenseful')

    // Verify a NEW fragment was created (not updated in-place)
    const originalFragment = await getFragment(dataDir, storyId, 'pr-refine')
    expect(originalFragment!.content).toBe('The hero walked slowly through the forest.') // Original unchanged

    // Find the new variation fragment
    const allFragments = await listFragments(dataDir, storyId, 'prose')
    const variation = allFragments.find(f => f.meta?.variationOf === 'pr-refine')
    expect(variation).toBeDefined()
    expect(variation!.content).toBe('The hero crept through the dark forest.')
    expect(variation!.meta.generationMode).toBe('refine')
    expect((await getProseChain(dataDir, storyId))?.entries[0].active).toBe(variation!.id)
    expect((await getAnalysisIndex(dataDir, storyId))?.latestByFragmentId[original.id]).toBeUndefined()
  })

  // --- Validation ---

  it('returns 422 when mode=regenerate but fragmentId is missing', async () => {
    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Regenerate this',
        saveResult: true,
        mode: 'regenerate',
      }),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toContain('fragmentId')
  })

  it('returns 404 when mode=regenerate with nonexistent fragment', async () => {
    mockAgentStream.mockResolvedValue(
      createMockStreamResult('test') as any,
    )

    const res = await api(`/stories/${storyId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Regenerate this',
        saveResult: true,
        mode: 'regenerate',
        fragmentId: 'pr-nonexistent',
      }),
    })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('Fragment not found')
  })

  // --- Revert endpoint ---

  it('POST /stories/:storyId/fragments/:fragmentId/revert returns 422 when there is no previous version', async () => {
    const fragment = makeFragment({
      id: 'pr-norevert',
      content: 'Some content.',
      meta: {},
    })
    await createFragment(dataDir, storyId, fragment)

    const res = await api(`/stories/${storyId}/fragments/pr-norevert/revert`, {
      method: 'POST',
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toContain('No previous')
  })

  it('POST /stories/:storyId/fragments/:fragmentId/revert returns 404 for nonexistent fragment', async () => {
    const res = await api(`/stories/${storyId}/fragments/pr-ghost/revert`, {
      method: 'POST',
    })

    expect(res.status).toBe(404)
  })
})
