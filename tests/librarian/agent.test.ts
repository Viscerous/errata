import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, seedTestProvider, makeTestSettings } from '../setup'
import {
  createStory,
  createFragment,
  getFragment,
  listFragments,
} from '@/server/fragments/storage'
import { getState, getAnalysis, listAnalyses, getBackfillJob } from '@/server/librarian/storage'
import { createBackfillJob, runBackfillJob } from '@/server/librarian/backfill'
import { saveAgentBlockConfig } from '@/server/agents/agent-block-storage'
import { initProseChain, addProseSection } from '@/server/fragments/prose-chain'
import { addTag } from '@/server/fragments/associations'
import type { StoryMeta, Fragment } from '@/server/fragments/schema'

const { mockAgentStream } = vi.hoisted(() => ({
  mockAgentStream: vi.fn(),
}))

// Mock the AI SDK ToolLoopAgent — now uses stream() instead of generate()
vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    ToolLoopAgent: class {
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>
      instructions: string
      onStepFinish?: (event: Record<string, unknown>) => Promise<void> | void
      constructor(opts: {
        tools?: Record<string, unknown>
        instructions?: string
        onStepFinish?: (event: Record<string, unknown>) => Promise<void> | void
      } = {}) {
        this.tools = (opts.tools ?? {}) as Record<string, { execute: (args: unknown) => Promise<unknown> }>
        this.instructions = opts.instructions ?? ''
        this.onStepFinish = opts.onStepFinish
      }
      async stream(args: unknown) {
        return mockAgentStream(args, this.tools, {
          instructions: this.instructions,
          onStepFinish: this.onStepFinish,
        })
      }
    },
  }
})

import { runLibrarian } from '@/server/librarian/agent'
import { proposeDirections } from '@/server/directions/suggest'
import { ensureCoreAgentsRegistered } from '@/server/agents'

function makeStory(
  overrides: Omit<Partial<StoryMeta>, 'settings'> & { settings?: Partial<StoryMeta['settings']> } = {},
): StoryMeta {
  const now = new Date().toISOString()
  const defaultSettings: StoryMeta['settings'] = makeTestSettings({
    disableLibrarianDirections: true,
  })

  const baseStory: StoryMeta = {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: defaultSettings,
  }

  return {
    ...baseStory,
    ...overrides,
    settings: { ...defaultSettings, ...(overrides.settings ?? {}) },
  }
}

function makeFragment(
  overrides: Partial<Omit<Fragment, 'placement'>> & { placement?: Fragment['placement'] },
): Fragment {
  const { placement, ...rest } = overrides
  const now = new Date().toISOString()
  const baseFragment: Fragment = {
    id: 'pr-0001',
    type: 'prose',
    name: 'Test Prose',
    description: 'Test prose fragment',
    content: 'The hero walked into the dark forest.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user' as const,
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
  }

  return {
    ...baseFragment,
    ...rest,
    placement: placement ?? 'user',
  }
}

/**
 * Creates a mock stream response that yields tool-call events.
 * The tool execute functions from the real analysis tools will run.
 */
function mockStreamWithToolCalls(toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>) {
  mockAgentStream.mockImplementation(async (_args: unknown, tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>) => {
    return {
      fullStream: (async function* () {
        let callId = 0
        for (const tc of toolCalls) {
          const toolDef = tools[tc.toolName]
          if (!toolDef?.execute) continue
          const id = `call-${callId++}`
          yield { type: 'tool-call' as const, toolCallId: id, toolName: tc.toolName, input: tc.args }
          // Actually execute the tool so the collector gets populated
          const output: unknown = await toolDef.execute(tc.args)
          yield { type: 'tool-result' as const, toolCallId: id, toolName: tc.toolName, output }
        }
        yield { type: 'finish' as const, finishReason: 'stop' }
      })(),
    }
  })
}

function correctionProposalArgs(
  evidenceSegments: number[],
  operations: Array<Record<string, unknown>>,
  rationale = 'The existing reusable fragment would state a fact that the accepted prose has explicitly replaced.',
) {
  return { evidenceSegments, rationale, corrections: operations }
}

function newFragmentProposalArgs(
  evidenceSegments: number[],
  operation: Record<string, unknown>,
  rationale = 'The prose establishes a newly named reusable setting record that future scenes can reference.',
) {
  const { action: _action, ...newFragment } = operation
  return { evidenceSegments, rationale, newFragments: [newFragment] }
}

// Helper to set up prose chain for tests
async function setupProseChain(dataDir: string, storyId: string, proseIds: string[]) {
  if (proseIds.length === 0) return
  await initProseChain(dataDir, storyId, proseIds[0])
  for (let i = 1; i < proseIds.length; i++) {
    await addProseSection(dataDir, storyId, proseIds[i])
  }
}

describe('librarian agent', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  const storyId = 'story-test'

  beforeEach(async () => {
    ensureCoreAgentsRegistered()
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await seedTestProvider(dataDir)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanup()
  })

  it('preserves analyzer instruction overrides and system fragments while using dynamic custom type wording', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        customFragmentTypes: [{
          type: 'location',
          name: 'Locations',
          description: 'Places in the story',
          icon: 'MapPin',
          showInSidebar: true,
        }],
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'gl-sys01',
      type: 'guideline',
      name: 'Continuity Rules',
      content: 'Never drop custom system fragments.',
    }))
    await addTag(dataDir, storyId, 'gl-sys01', 'pass-to-librarian-system-prompt')
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'They crossed the Ash Market.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])
    await saveAgentBlockConfig(dataDir, storyId, 'librarian.analyze', {
      customBlocks: [],
      overrides: {
        instructions: { contentMode: 'prepend', customContent: 'CUSTOM PREPEND' },
      },
      blockOrder: [],
      disabledTools: [],
      disableAutoAnalysis: false,
    })

    mockAgentStream.mockImplementation(async (
      _args: unknown,
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>,
      opts?: { instructions?: string },
    ) => {
      expect(opts?.instructions).toContain('CUSTOM PREPEND')
      expect(opts?.instructions).toContain('Never drop custom system fragments.')
      if (tools.proposeRecordCorrections) {
        expect(opts?.instructions).toContain('**proposeRecordCorrections**')
        expect(opts?.instructions).toContain('allowed fragment types (characters, knowledge, locations)')
      }

      return {
        fullStream: (async function* () {
          const id = 'call-0'
          const input = { summary: 'They crossed a market.' }
          yield { type: 'tool-call' as const, toolCallId: id, toolName: 'reportAnalysis', input }
          const output = tools.reportAnalysis ? await tools.reportAnalysis.execute(input) : { ok: true }
          yield { type: 'tool-result' as const, toolCallId: id, toolName: 'reportAnalysis', output }
          yield { type: 'finish' as const, finishReason: 'stop' }
        })(),
      }
    })

    await runLibrarian(dataDir, storyId, 'pr-0001')
  })

  it('stores the summary as a source-linked analysis contribution without creating a summary fragment', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The hero walked into the dark forest.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'The hero ventured into the dark forest.' } },
    ])

    const result = await runLibrarian(dataDir, storyId, 'pr-0001')

    expect(result.summaryUpdate).toBe('The hero ventured into the dark forest.')
    expect(result.sourceRevision?.contentHash).toBeTruthy()
    expect(result.summaryContractVersion).toBe(1)
    expect(result.analyzeLanes).toEqual({
      observation: { requirement: 'required', completion: 'complete' },
      recordMaintenance: { requirement: 'conditional', completion: 'not-needed' },
      directions: { requirement: 'disabled', completion: 'disabled' },
    })
    expect(await listFragments(dataDir, storyId, 'summary')).toHaveLength(0)
  })

  it('keeps summary history in the source-linked analysis artifact', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The hero walked into the dark forest.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'The hero ventured into the dark forest.' } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    const fragment = await getFragment(dataDir, storyId, 'pr-0001')
    expect(fragment).toBeTruthy()
    expect(fragment!.meta._librarian).toBeUndefined()
    expect(analysis.summaryUpdate).toBe('The hero ventured into the dark forest.')
  })

  it('stores mention annotations without duplicating the summary into prose metadata', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'The protagonist',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice drew her sword.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Alice drew her sword.' } },
      { toolName: 'reportAnalysis', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    const fragment = await getFragment(dataDir, storyId, 'pr-0001')
    expect(fragment).toBeTruthy()

    expect(fragment!.meta._librarian).toBeUndefined()
    expect(analysis.summaryUpdate).toBe('Alice drew her sword.')

    // Annotations also present
    const annotations = fragment!.meta.annotations as Array<{ type: string; fragmentId: string; text: string }>
    expect(annotations).toHaveLength(1)
    expect(annotations[0].text).toBe('Alice')
  })

  it('forwards the writer context cast as full character sheets', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'The protagonist',
      content: 'Alice carries a rune-etched blade.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice fought bravely.',
      meta: {
        contextReceipt: {
          version: 1,
          entries: [{ fragmentId: 'ch-0001', access: 'full', actor: 'writer', reason: 'recent-context' }],
        },
      },
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    let capturedPrompt = ''
    mockAgentStream.mockImplementation((
      args: { prompt?: string },
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>,
    ) => {
      if (!capturedPrompt && args.prompt) capturedPrompt = args.prompt
      return {
        fullStream: (async function* () {
          if (!tools.reportAnalysis) {
            yield { type: 'finish' as const, finishReason: 'stop' }
            return
          }
          const input = { summary: 'Alice fought bravely.' }
          yield { type: 'tool-call' as const, toolCallId: 'call-report', toolName: 'reportAnalysis', input }
          yield {
            type: 'tool-result' as const,
            toolCallId: 'call-report',
            toolName: 'reportAnalysis',
            output: await tools.reportAnalysis.execute(input),
          }
          yield { type: 'finish' as const, finishReason: 'stop' }
        })(),
      }
    })

    await runLibrarian(dataDir, storyId, 'pr-0001')

    expect(capturedPrompt).toContain('## Writer Context For This Passage')
    expect(capturedPrompt).toContain('### Characters')
    expect(capturedPrompt).toContain('#### `ch-0001` | Alice | The protagonist')
    expect(capturedPrompt).toContain('Alice carries a rune-etched blade.')
  })

  it('keeps resolved records available within one adaptive Analyze loop', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        modelOverrides: {
          'librarian.analyze': { temperature: 0.6, topP: 0.95, topK: 20 },
        },
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'The gate captain',
      content: 'Alice commands the north gate. She carries the iron key.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice resigned at dawn.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    let duplicateReadResult: unknown
    mockAgentStream.mockImplementation(async (
      args: { prompt?: string },
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>,
      opts?: { onStepFinish?: (event: Record<string, unknown>) => Promise<void> | void },
    ) => ({
      fullStream: (async function* () {
        expect(args.prompt).not.toContain('## Recorded Observation Checkpoint')
        const input = {
          summary: 'Alice resigned from command at dawn.',
          candidateFragmentIds: ['ch-0001'],
        }
        yield { type: 'tool-call' as const, toolCallId: 'observe', toolName: 'reportAnalysis', input }
        yield {
          type: 'tool-result' as const,
          toolCallId: 'observe',
          toolName: 'reportAnalysis',
          output: await tools.reportAnalysis.execute(input),
        }
        await opts?.onStepFinish?.({
          stepNumber: 0,
          finishReason: 'tool-calls',
          usage: { inputTokens: 111, outputTokens: 22 },
          response: { modelId: 'test-model' },
        })
        const readInput = { fragmentIds: ['ch-0001'] }
        duplicateReadResult = await tools.readFragments.execute(readInput)
        yield { type: 'tool-call' as const, toolCallId: 'read', toolName: 'readFragments', input: readInput }
        yield { type: 'tool-result' as const, toolCallId: 'read', toolName: 'readFragments', output: duplicateReadResult }
        const finishInput = {}
        yield { type: 'tool-call' as const, toolCallId: 'finish', toolName: 'finishAnalysis', input: finishInput }
        yield {
          type: 'tool-result' as const,
          toolCallId: 'finish',
          toolName: 'finishAnalysis',
          output: await tools.finishAnalysis.execute(finishInput),
        }
        await opts?.onStepFinish?.({
          stepNumber: 1,
          finishReason: 'tool-calls',
          usage: { inputTokens: 333, outputTokens: 44 },
          response: { modelId: 'test-model' },
        })
        yield { type: 'finish' as const, finishReason: 'stop' }
      })(),
    }))

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    expect(duplicateReadResult).toEqual({ fragments: [], missing: [], alreadyAvailable: ['ch-0001'] })
    expect(analysis.passes?.map((pass) => [pass.name, pass.status])).toEqual([
      ['analyze', 'complete'],
    ])
    expect(analysis.passes?.[0].diagnostics?.stepUsage).toEqual([
      {
        stepNumber: 0,
        finishReason: 'tool-calls',
        modelId: 'test-model',
        inputTokens: 111,
        outputTokens: 22,
      },
      {
        stepNumber: 1,
        finishReason: 'tool-calls',
        modelId: 'test-model',
        inputTokens: 333,
        outputTokens: 44,
      },
    ])
    expect(analysis.passes?.[0].diagnostics?.sampling).toEqual({ temperature: 0.6, topP: 0.95, topK: 20 })
  })

  it('detects character mentions', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'The protagonist',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice drew her sword and faced the dragon.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Alice confronted a dragon.' } },
      { toolName: 'reportAnalysis', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.mentions).toEqual([{ fragmentId: 'ch-0001', text: 'Alice' }])

    const state = await getState(dataDir, storyId)
    expect(state.recentMentions['ch-0001']).toEqual(['pr-0001'])
    expect(state.lastAnalyzedFragmentId).toBe('pr-0001')
  })

  it('records multiple knowledge terms as annotations but one mentioned knowledge id', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'kn-0001',
      type: 'knowledge',
      name: 'Necronomicon',
      description: 'Ancient spellbook',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The Necronomicon, a spellbook, pulsed on the altar.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'A forbidden book pulsed on the altar.' } },
      {
        toolName: 'reportAnalysis',
        args: {
          mentions: [
            { fragmentId: 'kn-0001', text: 'Necronomicon' },
            { fragmentId: 'kn-0001', text: 'spellbook' },
          ],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.mentions).toEqual([
      { fragmentId: 'kn-0001', text: 'Necronomicon' },
      { fragmentId: 'kn-0001', text: 'spellbook' },
    ])

    const fragment = await getFragment(dataDir, storyId, 'pr-0001')
    const annotations = fragment!.meta.annotations as Array<{ type: string; fragmentId: string; text: string }>
    expect(annotations.map(a => a.text)).toEqual(['Necronomicon', 'spellbook'])

    const state = await getState(dataDir, storyId)
    expect(state.recentMentions['kn-0001']).toEqual(['pr-0001'])
  })

  it('records custom fragment mentions as generic annotations and recent mentions', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        customFragmentTypes: [
          {
            type: 'location',
            name: 'Locations',
            description: 'Places in the story',
            icon: 'MapPin',
            showInSidebar: true,
          },
        ],
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'loc-0001',
      type: 'location',
      name: 'Ash Market',
      description: 'A market below the city',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'They entered the Ash Market below the city.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'They entered an underground market.' } },
      { toolName: 'reportAnalysis', args: { mentions: [{ fragmentId: 'loc-0001', text: 'Ash Market' }] } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.mentions).toEqual([{ fragmentId: 'loc-0001', text: 'Ash Market' }])

    const fragment = await getFragment(dataDir, storyId, 'pr-0001')
    const annotations = fragment!.meta.annotations as Array<{ type: string; fragmentId: string; text: string }>
    expect(annotations).toEqual([{ type: 'mention', fragmentId: 'loc-0001', text: 'Ash Market' }])

    const state = await getState(dataDir, storyId)
    expect(state.recentMentions['loc-0001']).toEqual(['pr-0001'])
  })

  it('runs directions in the fused Analyze pass when enabled', async () => {
    await createStory(dataDir, makeStory({ settings: { disableLibrarianDirections: false } }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The road opened toward a quiet city gate.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    const directions = [
      { title: 'Enter Quietly', description: 'The party slips into the city.', instruction: 'Write a restrained entry through the gate.' },
      { title: 'Question the Guard', description: 'A guard blocks the way.', instruction: 'Write a tense exchange with the gate guard.' },
      { title: 'Follow the Lanterns', description: 'Lanterns reveal a hidden route.', instruction: 'Write the discovery of a side path.' },
      { title: 'Wait Until Dawn', description: 'The group pauses outside.', instruction: 'Write a watchful pause before sunrise.' },
    ]

    mockAgentStream.mockImplementation(async (
      _args: unknown,
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>,
    ) => {
      return {
        fullStream: (async function* () {
          if (tools.reportAnalysis) {
            const input = { summary: 'The road reached a quiet city gate.' }
            yield { type: 'tool-call' as const, toolCallId: 'call-observe', toolName: 'reportAnalysis', input }
            yield { type: 'tool-result' as const, toolCallId: 'call-observe', toolName: 'reportAnalysis', output: await tools.reportAnalysis.execute(input) }
          }
          if (tools.proposeDirections) {
            const input = { directions }
            yield { type: 'tool-call' as const, toolCallId: 'call-directions', toolName: 'proposeDirections', input }
            yield { type: 'tool-result' as const, toolCallId: 'call-directions', toolName: 'proposeDirections', output: await tools.proposeDirections.execute(input) }
          }
          yield { type: 'finish' as const, finishReason: 'stop' }
        })(),
      }
    })

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    const analyzePass = analysis.passes?.find((pass) => pass.name === 'analyze')
    expect(analyzePass?.status).toBe('complete')
    expect(analyzePass?.diagnostics?.directionToolCallCount).toBe(1)
    expect(analysis.directions).toEqual(directions)
    expect(analysis.analyzeLanes?.directions).toEqual({ requirement: 'required', completion: 'complete' })
  })

  it('treats enabled automatic directions as required while preserving the observation', async () => {
    await createStory(dataDir, makeStory({ settings: { disableLibrarianDirections: false } }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'The hero reached the gate.' } },
    ])

    await expect(runLibrarian(dataDir, storyId, 'pr-0001')).rejects.toThrow(
      'without completing automatic directions required by the story setting',
    )
    const summaries = await listAnalyses(dataDir, storyId)
    expect(summaries).toHaveLength(1)
    const analysis = await getAnalysis(dataDir, storyId, summaries[0].id)
    expect(analysis?.summaryUpdate).toBe('The hero reached the gate.')
    expect(analysis?.analyzeLanes?.observation.completion).toBe('complete')
    expect(analysis?.analyzeLanes?.directions).toEqual({ requirement: 'required', completion: 'incomplete' })
  })

  it('allows manual directions when automatic directions are disabled', async () => {
    await createStory(dataDir, makeStory({ settings: { disableLibrarianDirections: true } }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])
    const directions = [
      { title: 'Wait at Dawn', description: 'The hero waits outside.', instruction: 'Write the quiet vigil.' },
    ]
    mockAgentStream.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: 'text-delta' as const, text: JSON.stringify(directions) }
        yield { type: 'finish' as const, finishReason: 'stop' }
      })(),
    })

    const result = await proposeDirections(dataDir, storyId, { count: 1 })

    expect(result.suggestions).toEqual(directions)
  })

  it('saves a valid observation when a later Analyze step fails', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockAgentStream.mockImplementation(async (
      _args: unknown,
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>,
      opts?: { onStepFinish?: (event: Record<string, unknown>) => Promise<void> | void },
    ) => ({
      fullStream: (async function* () {
        const input = { summary: 'The hero reached the gate.' }
        yield { type: 'tool-call' as const, toolCallId: 'call-observe', toolName: 'reportAnalysis', input }
        yield {
          type: 'tool-result' as const,
          toolCallId: 'call-observe',
          toolName: 'reportAnalysis',
          output: await tools.reportAnalysis.execute(input),
        }
        await opts?.onStepFinish?.({
          stepNumber: 0,
          finishReason: 'tool-calls',
          usage: { inputTokens: 321, outputTokens: 123 },
          response: { modelId: 'test-model' },
        })
        throw new Error('late proposal connection failure')
      })(),
    }))

    await expect(runLibrarian(dataDir, storyId, 'pr-0001')).rejects.toThrow(
      'was saved but did not fully complete: late proposal connection failure',
    )
    const summaries = await listAnalyses(dataDir, storyId)
    expect(summaries).toHaveLength(1)
    const analysis = await getAnalysis(dataDir, storyId, summaries[0].id)
    expect(analysis?.summaryUpdate).toBe('The hero reached the gate.')
    expect(analysis?.passes?.[0]).toMatchObject({ name: 'analyze', status: 'failed' })
    expect(analysis?.passes?.[0].diagnostics).toMatchObject({
      completedStepCount: 1,
      inputTokens: 321,
      outputTokens: 123,
      stepUsage: [{
        stepNumber: 0,
        finishReason: 'tool-calls',
        modelId: 'test-model',
        inputTokens: 321,
        outputTokens: 123,
      }],
    })
    expect(analysis?.analyzeLanes?.observation.completion).toBe('complete')
  })

  it('uses candidate fragments for memory context without recording mention annotations', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Captain of the guard',
      content: 'Alice is captain of the guard. She keeps the north gate.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The captain resigned from the guard.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'The captain resigned from the guard.',
          candidateFragmentIds: ['ch-0001'],
        },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs(
          [1],
          [{
            fragmentId: 'ch-0001',
            field: 'content',
            segment: 1,
            newText: 'Alice is the former captain of the guard.',
            reason: 'The prose changes Alice role.',
          }],
        ),
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.mentions).toEqual([])
    expect(analysis.candidateFragmentIds).toEqual(['ch-0001'])
    expect(analysis.fragmentChangeProposals).toHaveLength(1)

    const analyzePass = analysis.passes?.find((pass) => pass.name === 'analyze')
    expect(analyzePass?.status).toBe('complete')
    expect(analyzePass?.diagnostics?.proposalToolCallCount).toBe(1)
    expect(analyzePass?.diagnostics?.proposalToolFailureCount).toBe(0)
    expect(analyzePass?.diagnostics?.proposalQueuedOperationCount).toBe(1)
    expect(analyzePass?.diagnostics?.proposalInvalidOperationCount).toBe(0)
    expect(analyzePass?.diagnostics?.attentionCandidateIds).toEqual([])
    expect(analysis.passes?.find((pass) => pass.name === 'directions')).toBeUndefined()
    expect(analysis.directions).toEqual([])

    const fragment = await getFragment(dataDir, storyId, 'pr-0001')
    expect(fragment!.meta.annotations).toBeUndefined()

    const state = await getState(dataDir, storyId)
    expect(state.recentMentions).toEqual({})
  })

  it('passes an abort signal into the online analyze stream', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice checked the gate.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])
    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Alice checked the gate.' } },
    ])

    const controller = new AbortController()
    await runLibrarian(dataDir, storyId, 'pr-0001', { abortSignal: controller.signal })

    const streamArgs = mockAgentStream.mock.calls[0]?.[0] as { abortSignal?: AbortSignal } | undefined
    expect(streamArgs?.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('records invalid proposal diagnostics on a completed analyze pass', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Captain of the guard',
      content: 'Alice is captain of the guard. She keeps the north gate.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice resigned from the guard.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Alice resigned.',
          candidateFragmentIds: ['ch-0001'],
        },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs(
          [1],
          [{
            fragmentId: 'ch-0001',
            field: 'content',
            segment: 9,
            newText: 'Alice is the former captain of the guard.',
          }],
        ),
      },
      {
        toolName: 'finishAnalysis',
        args: {
          completed: ['reportAnalysis'],
          skipped: [{ toolName: 'proposeRecordCorrections', reason: 'The correction target was invalid.' }],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    const analyzePass = analysis.passes?.find((pass) => pass.name === 'analyze')

    expect(analyzePass?.status).toBe('complete')
    expect(analyzePass?.diagnostics?.proposalToolCallCount).toBe(1)
    expect(analyzePass?.diagnostics?.proposalToolFailureCount).toBe(1)
    expect(analyzePass?.diagnostics?.proposalQueuedOperationCount).toBe(0)
    expect(analyzePass?.diagnostics?.proposalInvalidOperationCount).toBe(1)
    expect(analysis.fragmentChangeProposals).toEqual([])
  })

  it('keeps writer provenance but does not create candidates from lexical matches', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Captain of the guard',
      content: 'Alice is captain of the guard. She keeps the north gate.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'kn-0001',
      type: 'knowledge',
      name: 'Guard Resignation',
      description: 'Rules for captains leaving the guard',
      content: 'Captains can only resign before the council.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The captain resigned from the guard.',
      meta: {
        contextReceipt: {
          version: 1,
          entries: [{ fragmentId: 'kn-0001', access: 'full', actor: 'writer', reason: 'recent-context' }],
        },
      },
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockAgentStream.mockImplementation(async (
      _args: unknown,
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>,
    ) => {
      return {
        fullStream: (async function* () {
          if (tools.reportAnalysis) {
            const input = { summary: 'The guard captain resigned.' }
            yield { type: 'tool-call' as const, toolCallId: 'call-observe', toolName: 'reportAnalysis', input }
            yield { type: 'tool-result' as const, toolCallId: 'call-observe', toolName: 'reportAnalysis', output: await tools.reportAnalysis.execute(input) }
          }
          yield { type: 'finish' as const, finishReason: 'stop' }
        })(),
      }
    })

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    const byId = new Map(analysis.candidateFragments?.map((candidate) => [candidate.fragmentId, candidate]))

    expect(analysis.candidateFragmentIds).toEqual(['kn-0001'])
    expect(byId.has('ch-0001')).toBe(false)
    expect(byId.get('kn-0001')?.sources).toEqual(expect.arrayContaining(['writer-context']))
    expect(analysis.mentions).toEqual([])
    expect((await getFragment(dataDir, storyId, 'pr-0001'))!.meta.annotations).toBeUndefined()
  })

  it('keeps writer provenance context when suggestion tools are disabled', async () => {
    await createStory(dataDir, makeStory({ settings: { disableLibrarianSuggestions: true } }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'kn-0001',
      type: 'knowledge',
      name: 'Glass Accord',
      description: 'Rare treaty context',
      content: 'The Glass Accord binds witnesses to silence.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The room went quiet after the oath.',
      meta: {
        contextReceipt: {
          version: 1,
          entries: [{ fragmentId: 'kn-0001', access: 'full', actor: 'writer', reason: 'recent-context' }],
        },
      },
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'An oath quieted the room.' } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    const analyzePass = analysis.passes?.find((pass) => pass.name === 'analyze')

    expect(analysis.candidateFragmentIds).toEqual(['kn-0001'])
    expect(analyzePass?.diagnostics?.attentionCandidateIds).toEqual(['kn-0001'])
    expect(analyzePass?.diagnostics?.toolNames).toContain('reportAnalysis')
    expect(analyzePass?.diagnostics?.toolNames).not.toContain('proposeRecordCorrections')
    expect(analyzePass?.diagnostics?.toolNames).not.toContain('proposeNewRecords')
    expect(analyzePass?.diagnostics?.toolNames).not.toContain('readFragments')
  })

  it('does not block online analysis on a synchronous router fallback', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Captain of the guard',
      content: 'Alice is captain of the guard. She keeps the north gate.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The masked figure abdicated before dawn.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockAgentStream.mockImplementation(async (
      _args: unknown,
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>,
    ) => {
      return {
        fullStream: (async function* () {
          if (tools.reportAnalysis) {
            const input = { summary: 'A masked figure abdicated.' }
            yield { type: 'tool-call' as const, toolCallId: 'call-observe', toolName: 'reportAnalysis', input }
            yield { type: 'tool-result' as const, toolCallId: 'call-observe', toolName: 'reportAnalysis', output: await tools.reportAnalysis.execute(input) }
          }
          yield { type: 'finish' as const, finishReason: 'stop' }
        })(),
      }
    })

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    expect(analysis.candidateFragmentIds).toEqual([])
    expect(analysis.fragmentChangeProposals).toEqual([])
    expect(analysis.passes?.find((pass) => pass.name === 'analyze')?.status).toBe('complete')
  })

  it('accumulates mentions across multiple runs', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'The protagonist',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice entered the castle.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0002',
      content: 'Alice found the treasure room.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001', 'pr-0002'])

    // First run
    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Alice entered the castle.' } },
      { toolName: 'reportAnalysis', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    // Second run
    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Alice found the treasure room.' } },
      { toolName: 'reportAnalysis', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0002')

    const state = await getState(dataDir, storyId)
    expect(state.recentMentions['ch-0001']).toEqual(['pr-0001', 'pr-0002'])
    expect(state.lastAnalyzedFragmentId).toBe('pr-0002')
  })

  it('replaces recent mention links when reanalyzing the same prose fragment', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0002',
      type: 'character',
      name: 'Bob',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      // Both names present so both runs' mentions anchor to the prose text.
      content: 'Alice and Bob entered the castle.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Alice entered the castle.' } },
      { toolName: 'reportAnalysis', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Bob entered the castle.' } },
      { toolName: 'reportAnalysis', args: { mentions: [{ fragmentId: 'ch-0002', text: 'Bob' }] } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    let state = await getState(dataDir, storyId)
    expect(state.recentMentions['ch-0001']).toBeUndefined()
    expect(state.recentMentions['ch-0002']).toEqual(['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'The castle was empty.' } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    state = await getState(dataDir, storyId)
    expect(state.recentMentions).toEqual({})
  })

  it('flags contradictions', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'A woman with blue eyes.',
      content: 'Alice has blue eyes.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice looked at him with her green eyes.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Alice stared at the stranger.' } },
      {
        toolName: 'reportAnalysis',
        args: {
          contradictions: [{
            description: 'Alice was described as having blue eyes, but new prose says green eyes.',
            fragmentIds: ['pr-0001'],
            sourceSegments: [1],
            conflictingEvidence: [{ fragmentId: 'ch-0001', segments: [1] }],
          }],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.contradictions).toHaveLength(1)
    expect(analysis.contradictions[0].description).toContain('blue eyes')
  })

  it('extracts knowledge proposals', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The ancient city of Valdris stood atop the mountain.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'An ancient city called Valdris was revealed.',
        },
      },
      {
        toolName: 'proposeNewRecords',
        args: newFragmentProposalArgs(
          [1],
          {
            action: 'create_fragment',
            type: 'knowledge',
            name: 'Valdris',
            description: 'Ancient mountain city',
            content: 'Valdris is an ancient city located atop a mountain.',
          },
        ),
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.fragmentChangeProposals).toHaveLength(1)
    expect(analysis.fragmentChangeProposals[0].operations[0]).toMatchObject({
      action: 'create_fragment',
      name: 'Valdris',
    })
    expect(analysis.fragmentChangeProposals[0].sourceFragmentId).toBe('pr-0001')
  })

  it('auto-applies create and update proposals', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        autoApplyLibrarianSuggestions: true,
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Valdris was introduced in ancient records.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0002',
      content: 'Valdris is now protected by stone sentinels.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001', 'pr-0002'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Valdris appears in old records.',
        },
      },
      {
        toolName: 'proposeNewRecords',
        args: newFragmentProposalArgs(
          [1],
          {
            action: 'create_fragment',
            type: 'knowledge',
            name: 'Valdris',
            description: 'Ancient city',
            content: 'Valdris is an ancient mountain city. Its walls predate the Reckoning.',
          },
        ),
      },
    ])

    const first = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(first.fragmentChangeProposals[0].accepted).toBe(true)
    expect(first.fragmentChangeProposals[0].autoApplied).toBe(true)
    const createdId = first.fragmentChangeProposals[0].appliedResults?.[0]?.createdFragmentId
    expect(createdId).toBeTruthy()
    const created = await getFragment(dataDir, storyId, createdId!)
    expect(created).toBeTruthy()

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Valdris defenses were revealed.',
          candidateFragmentIds: [createdId!],
        },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs(
          [1],
          [{
            fragmentId: createdId,
            field: 'content',
            segment: 1,
            newText: 'Valdris is an ancient mountain city guarded by stone sentinels.',
          }],
        ),
      },
    ])

    const second = await runLibrarian(dataDir, storyId, 'pr-0002')
    expect(second.fragmentChangeProposals[0].accepted).toBe(true)
    expect(second.fragmentChangeProposals[0].autoApplied).toBe(true)
    expect(second.fragmentChangeProposals[0].appliedResults?.[0]?.target?.fragmentId).toBe(createdId)

    const suggestionFragment = await getFragment(dataDir, storyId, createdId!)
    expect(suggestionFragment).toBeTruthy()
    expect(suggestionFragment?.content).toContain('stone sentinels')
    expect(suggestionFragment?.refs).toContain('pr-0001')
    expect(suggestionFragment?.refs).toContain('pr-0002')
  })

  it('auto-applies targeted updates to existing knowledge fragments', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        autoApplyLibrarianSuggestions: true,
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'kn-0001',
      type: 'knowledge',
      name: 'Valdris',
      description: 'Ancient city',
      content: 'Valdris is an ancient city. Its walls predate the Reckoning.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Valdris is defended by sentinels made of stone.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])
    const existingKnowledge = await getFragment(dataDir, storyId, 'kn-0001')
    expect(existingKnowledge).toBeTruthy()

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Valdris defenses were revealed.',
          candidateFragmentIds: ['kn-0001'],
        },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs(
          [1],
          [{
            fragmentId: 'kn-0001',
            field: 'content',
            segment: 1,
            newText: 'Valdris is an ancient city defended by stone sentinels.',
          }],
        ),
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.fragmentChangeProposals[0].accepted).toBe(true)
    expect(analysis.fragmentChangeProposals[0].autoApplied).toBe(true)
    expect(analysis.fragmentChangeProposals[0].appliedResults?.[0]?.target?.fragmentId).toBe('kn-0001')

    const updated = await getFragment(dataDir, storyId, 'kn-0001')
    expect(updated).toBeTruthy()
    expect(updated?.content).toContain('stone sentinels')
    expect(updated?.refs).toContain('pr-0001')
  })

  it('auto-applies edits whose ordered evidence spans remain grounded', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        autoApplyLibrarianSuggestions: true,
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Captain of the guard',
      content: 'Alice is captain of the guard and lives in Valdris. She trained under Bren.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice resigned and became former captain of the guard.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Alice resigned from the guard.',
          candidateFragmentIds: ['ch-0001'],
        },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs(
          [1],
          [{
            fragmentId: 'ch-0001',
            field: 'content',
            segment: 1,
            newText: 'Alice is the former captain of the guard.',
            reason: 'The prose says Alice resigned.',
          }],
        ),
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.fragmentChangeProposals[0].accepted).toBe(true)
    expect(analysis.fragmentChangeProposals[0].autoApplied).toBe(true)

    const updated = await getFragment(dataDir, storyId, 'ch-0001')
    expect(updated?.content).toContain('former captain of the guard')
    expect(updated?.refs).toContain('pr-0001')
  })

  it('holds a cross-character correction for review instead of auto-applying it', async () => {
    await createStory(dataDir, makeStory({
      settings: { autoApplyLibrarianSuggestions: true },
    }))
    const victoriaContent = 'Victoria was born on the Frisian dwelling mound. She rules Principia.'
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Victoria',
      description: 'Sovereign of Principia',
      content: victoriaContent,
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0002',
      type: 'character',
      name: 'Marcus Thorne',
      description: 'Diplomat',
      content: 'Marcus Thorne is a disciplined diplomat.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Victoria watches Thorne. He is shaking with a fine tremor.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Marcus Thorne began shaking.',
          mentions: [
            { fragmentId: 'ch-0001', text: 'Victoria' },
            { fragmentId: 'ch-0002', text: 'Thorne' },
          ],
        },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: {
          title: 'Update Thorne Physiological State',
          evidenceSegments: [2],
          rationale: 'Marcus Thorne is now visibly shaking.',
          corrections: [{
            fragmentId: 'ch-0001',
            field: 'content',
            segment: 1,
            newText: 'He is shaking with a fine tremor.',
            reason: 'Update Thorne physiological state.',
          }],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    expect(analysis.fragmentChangeProposals).toHaveLength(1)
    expect(analysis.fragmentChangeProposals[0].autoApplySafe).toBe(true)
    expect(analysis.fragmentChangeProposals[0].autoApplied).not.toBe(true)
    expect(analysis.fragmentChangeProposals[0].accepted).not.toBe(true)
    expect((await getFragment(dataDir, storyId, 'ch-0001'))?.content).toBe(victoriaContent)
  })

  /**
   * A description is capped at 250 characters and is usually one sentence, so
   * every correction to one replaces the whole field. Refusing that when the
   * proposal was made destroyed it outright — a kill test in which the
   * groundskeeper died produced exactly the right description edit and the
   * engine dropped it, telling the model to "leave this to author review" while
   * ensuring no author would ever see it. The rewrite is held back from the
   * *unattended* write instead, where the record can be judged as it stands.
   */
  it('proposes a whole-field description fix but leaves the write to the author', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        autoApplyLibrarianSuggestions: true,
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Captain of the guard at Valdris.',
      content: 'Alice is captain of the guard and lives in Valdris. She trained under Bren.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice resigned and became former captain of the guard.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Alice resigned from the guard.',
          candidateFragmentIds: ['ch-0001'],
        },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs(
          [1],
          [{
            fragmentId: 'ch-0001',
            field: 'description',
            segment: 1,
            newText: 'Former captain of the guard at Valdris.',
            reason: 'The prose says Alice resigned.',
          }],
        ),
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    // The correction survives as work the author can accept, carried by the
    // operation that can express a whole-field change safely.
    expect(analysis.fragmentChangeProposals).toHaveLength(1)
    const operation = analysis.fragmentChangeProposals[0].operations[0]
    expect(operation).toMatchObject({
      action: 'set_fields',
      fragmentId: 'ch-0001',
      fields: { description: 'Former captain of the guard at Valdris.' },
    })
    // The hash pins the record it was written against, so a concurrent edit
    // makes the proposal stale rather than silently overwriting the author.
    expect(operation).toHaveProperty('baseHash', expect.any(String))
    // ...but a whole-field rewrite is never written unattended, and it stays
    // pending rather than being dismissed as stale on the author's behalf.
    expect(analysis.fragmentChangeProposals[0].autoApplied).not.toBe(true)
    expect(analysis.fragmentChangeProposals[0].stale).toBeUndefined()
    expect(analysis.fragmentChangeProposals[0].dismissed).not.toBe(true)
    expect((await getFragment(dataDir, storyId, 'ch-0001'))?.description)
      .toBe('Captain of the guard at Valdris.')
  })

  /**
   * One event is one proposal, and a death makes both a body sentence and the
   * description above it wrong at once. `set_fields` cannot share a fragment
   * with localized edits, so the record's edits compose into a single write
   * rather than being split across proposals or refused — the 31B produced
   * exactly this shape and lost four operations to the conflict.
   */
  it('composes a record whose edits span a sentence and its whole description', async () => {
    await createStory(dataDir, makeStory({
      settings: { autoApplyLibrarianSuggestions: true },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Captain of the guard at Valdris.',
      content: 'Alice is captain of the guard. She trained under Bren. She keeps the east gate.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice resigned and became former captain of the guard.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: { summary: 'Alice resigned.', candidateFragmentIds: ['ch-0001'] },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs([1], [
          {
            fragmentId: 'ch-0001',
            field: 'content',
            segment: 1,
            newText: 'Alice is the former captain of the guard.',
            reason: 'She resigned.',
          },
          {
            fragmentId: 'ch-0001',
            field: 'description',
            segment: 1,
            newText: 'Former captain of the guard at Valdris.',
            reason: 'She resigned.',
          },
        ]),
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    expect(analysis.fragmentChangeProposals).toHaveLength(1)
    const operations = analysis.fragmentChangeProposals[0].operations
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      action: 'set_fields',
      fragmentId: 'ch-0001',
      fields: {
        description: 'Former captain of the guard at Valdris.',
        // The untouched sentences survive the compose; only the cited span moved.
        content: 'Alice is the former captain of the guard. She trained under Bren. She keeps the east gate.',
      },
    })
  })

  it('marks a proposal stale instead of leaving it pending when auto-apply validation fails', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        autoApplyLibrarianSuggestions: true,
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Captain of the guard',
      content: 'Alice is captain of the guard and lives in Valdris. She trained under Bren.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice resigned from the guard.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    // Two proposals rewriting the same span differently: both are valid at
    // propose time (different replacements, so no dedupe), but only the first
    // can apply — the second must end up stale, not pending.
    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Alice resigned.',
          candidateFragmentIds: ['ch-0001'],
        },
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs(
          [1],
          [{
            fragmentId: 'ch-0001',
            field: 'content',
            segment: 1,
            newText: 'Alice is no longer with the guard.',
          }],
        ),
      },
      {
        toolName: 'proposeRecordCorrections',
        args: correctionProposalArgs(
          [1],
          [{
            fragmentId: 'ch-0001',
            field: 'content',
            segment: 1,
            newText: 'Alice is a free blade.',
          }],
        ),
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.fragmentChangeProposals).toHaveLength(2)
    expect(analysis.fragmentChangeProposals[0].accepted).toBe(true)
    expect(analysis.fragmentChangeProposals[1].accepted).toBeUndefined()
    expect(analysis.fragmentChangeProposals[1]).toMatchObject({
      stale: true,
      dismissed: true,
    })
    expect(analysis.fragmentChangeProposals[1].staleReason).toContain('oldText was not found')

    const updated = await getFragment(dataDir, storyId, 'ch-0001')
    expect(updated?.content).toContain('no longer with the guard')
  })

  it('does not turn episodic state updates into unattended character-sheet appends', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        autoApplyLibrarianSuggestions: true,
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Alice',
      description: 'Scout',
      content: 'Alice waits at the gate.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice left the gate and accepted command of the watch.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: 'Alice left the gate and took command.',
          candidateFragmentIds: ['ch-0001'],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.fragmentChangeProposals).toEqual([])
    expect(analysis.passes?.find((pass) => pass.name === 'analyze')?.diagnostics)
      .toMatchObject({ proposalToolCallCount: 0, proposalQueuedOperationCount: 0 })

    const updated = await getFragment(dataDir, storyId, 'ch-0001')
    expect(updated?.content).toBe('Alice waits at the gate.')
    expect(updated?.refs).not.toContain('pr-0001')
  })

  it('tracks timeline events', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The hero defeated the dragon. The village celebrated.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'The hero defeated the dragon and the village celebrated.' } },
      {
        toolName: 'reportAnalysis',
        args: {
          events: ['Hero defeated the dragon', 'Village celebration'],
          temporalFrame: { relation: 'flashback', evidenceSegments: [1] },
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    // The frame the passage reported places every one of its events.
    expect(analysis.timelineEvents).toEqual([
      { event: 'Hero defeated the dragon', position: 'before' },
      { event: 'Village celebration', position: 'before' },
    ])

    const state = await getState(dataDir, storyId)
    expect(state.timeline).toHaveLength(2)
    expect(state.timeline[0].event).toBe('Hero defeated the dragon')
    expect(state.timeline[0].fragmentId).toBe('pr-0001')
  })

  it('re-analyzing a fragment replaces its timeline entries in place', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001', content: 'Alice waits.' }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0002', content: 'Bob arrives.' }))
    await setupProseChain(dataDir, storyId, ['pr-0001', 'pr-0002'])

    mockStreamWithToolCalls([{ toolName: 'reportAnalysis', args: { summary: 'S', events: ['Alice waits'] } }])
    await runLibrarian(dataDir, storyId, 'pr-0001')
    mockStreamWithToolCalls([{ toolName: 'reportAnalysis', args: { summary: 'S', events: ['Bob arrives'] } }])
    await runLibrarian(dataDir, storyId, 'pr-0002')
    mockStreamWithToolCalls([{ toolName: 'reportAnalysis', args: { summary: 'S', events: ['Alice waits at the gate'] } }])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    const state = await getState(dataDir, storyId)
    expect(state.timeline).toEqual([
      { event: 'Alice waits at the gate', fragmentId: 'pr-0001' },
      { event: 'Bob arrives', fragmentId: 'pr-0002' },
    ])
  })

  it('saves the analysis result with trace', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Something happened.' } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    // Verify analysis was persisted
    const loaded = await getAnalysis(dataDir, storyId, analysis.id)
    expect(loaded).toBeDefined()
    expect(loaded!.fragmentId).toBe('pr-0001')
    expect(loaded!.summaryUpdate).toBe('Something happened.')
    expect(loaded!.trace).toBeDefined()
    expect(loaded!.trace!.length).toBeGreaterThan(0)

    // Verify it appears in list with hasTrace
    const summaries = await listAnalyses(dataDir, storyId)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].id).toBe(analysis.id)
    expect(summaries[0].hasTrace).toBe(true)
  })

  it('handles LLM stream error gracefully', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockAgentStream.mockImplementation(async () => {
      return {
        fullStream: (async function* () {
          throw new Error('LLM connection failed')
        })(),
      }
    })

    await expect(runLibrarian(dataDir, storyId, 'pr-0001')).rejects.toThrow('LLM connection failed')
  })

  it('throws when story does not exist', async () => {
    await expect(runLibrarian(dataDir, 'nonexistent', 'pr-0001')).rejects.toThrow(
      'Story nonexistent not found',
    )
  })

  it('throws when fragment does not exist', async () => {
    await createStory(dataDir, makeStory())

    await expect(runLibrarian(dataDir, storyId, 'pr-missing')).rejects.toThrow(
      'Fragment pr-missing not found',
    )
  })

  it('rejects free text that does not complete the required observation lane', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    // Simulate LLM producing text instead of calling tools
    mockAgentStream.mockImplementation(async () => {
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta' as const, text: 'This is the summary from text.' }
          yield { type: 'finish' as const, finishReason: 'stop' }
        })(),
      }
    })

    await expect(runLibrarian(dataDir, storyId, 'pr-0001')).rejects.toThrow(
      'without completing the required observation lane',
    )
    expect(await listAnalyses(dataDir, storyId)).toHaveLength(0)
  })

  it('derives summary from structured reportAnalysis payload when summary text is empty', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'reportAnalysis',
        args: {
          summary: ' ',
          events: ['Alice entered the vault'],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.summaryUpdate).toBe('Alice entered the vault.')
    expect(analysis.sourceRevision?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(analysis.continuityProjection).toMatchObject({
      version: 1,
      temporalFrame: { relation: 'uncertain' },
    })
  })

  it('uses prompt with correct structure', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Prompt check.' } },
    ])

    await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(mockAgentStream).toHaveBeenCalled()
    const call = mockAgentStream.mock.calls[0]?.[0] as { prompt?: string } | undefined
    expect(typeof call?.prompt).toBe('string')
  })

  it('runs backfill jobs durably and resumes from the saved cursor', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001', content: 'First historical passage.' }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0002', content: 'Second historical passage.' }))
    await setupProseChain(dataDir, storyId, ['pr-0001', 'pr-0002'])

    mockStreamWithToolCalls([
      { toolName: 'reportAnalysis', args: { summary: 'Backfilled passage.' } },
    ])

    const job = await createBackfillJob(dataDir, storyId, {
      fragmentIds: ['pr-0001', 'pr-0002'],
      source: 'historical',
    })

    const paused = await runBackfillJob(dataDir, storyId, job.id, { maxFragments: 1 })
    expect(paused.status).toBe('paused')
    expect(paused.cursor).toBe(1)
    expect(paused.completedFragmentIds).toEqual(['pr-0001'])

    const persisted = await getBackfillJob(dataDir, storyId, job.id)
    expect(persisted?.cursor).toBe(1)

    const complete = await runBackfillJob(dataDir, storyId, job.id)
    expect(complete.status).toBe('complete')
    expect(complete.cursor).toBe(2)
    expect(complete.completedFragmentIds).toEqual(['pr-0001', 'pr-0002'])
  })

})
