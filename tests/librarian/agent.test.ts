import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, seedTestProvider, makeTestSettings } from '../setup'
import {
  createStory,
  getStory,
  createFragment,
  getFragment,
  listFragments,
} from '@/server/fragments/storage'
import { getState, getAnalysis, listAnalyses, saveAnalysis } from '@/server/librarian/storage'
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
      constructor(opts: { tools?: Record<string, unknown>; instructions?: string } = {}) {
        this.tools = (opts.tools ?? {}) as Record<string, { execute: (args: unknown) => Promise<unknown> }>
        this.instructions = opts.instructions ?? ''
      }
      async stream(args: unknown) {
        return mockAgentStream(args, this.tools, { instructions: this.instructions })
      }
    },
  }
})

import { runLibrarian } from '@/server/librarian/agent'
import { ensureCoreAgentsRegistered } from '@/server/agents'

function makeStory(
  overrides: Omit<Partial<StoryMeta>, 'settings'> & { settings?: Partial<StoryMeta['settings']> } = {},
): StoryMeta {
  const now = new Date().toISOString()
  const defaultSettings: StoryMeta['settings'] = makeTestSettings({
    summarizationThreshold: 0,
  })

  const baseStory: StoryMeta = {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    summary: '',
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
          const id = `call-${callId++}`
          yield { type: 'tool-call' as const, toolCallId: id, toolName: tc.toolName, input: tc.args }
          // Actually execute the tool so the collector gets populated
          const toolDef = tools[tc.toolName]
          let output: unknown = { ok: true }
          if (toolDef?.execute) {
            output = await toolDef.execute(tc.args)
          }
          yield { type: 'tool-result' as const, toolCallId: id, toolName: tc.toolName, output }
        }
        yield { type: 'finish' as const, finishReason: 'stop' }
      })(),
    }
  })
}

// Concatenate all summary fragments for a story in the same order the
// context builder reads them (era summaries first, then chapter summaries
// by createdAt). Replaces assertions on the removed story.summary field.
async function readSummaries(dataDir: string, storyId: string): Promise<string> {
  const fragments = await listFragments(dataDir, storyId, 'summary')
  fragments.sort((a, b) => {
    const aEra = a.meta?.isEraSummary ? 0 : 1
    const bEra = b.meta?.isEraSummary ? 0 : 1
    if (aEra !== bEra) return aEra - bEra
    return a.createdAt.localeCompare(b.createdAt)
  })
  return fragments.map(f => f.content.trim()).filter(Boolean).join('\n\n')
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
    })

    mockAgentStream.mockImplementation(async (
      _args: unknown,
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>,
      opts?: { instructions?: string },
    ) => {
      expect(opts?.instructions).toContain('CUSTOM PREPEND')
      expect(opts?.instructions).toContain('Never drop custom system fragments.')
      expect(opts?.instructions).toContain('Suggest genuinely new characters, knowledge, locations with suggestFragment')

      return {
        fullStream: (async function* () {
          const id = 'call-0'
          const input = { summary: 'They crossed a market.' }
          yield { type: 'tool-call' as const, toolCallId: id, toolName: 'updateSummary', input }
          const output = await tools.updateSummary.execute(input)
          yield { type: 'tool-result' as const, toolCallId: id, toolName: 'updateSummary', output }
          yield { type: 'finish' as const, finishReason: 'stop' }
        })(),
      }
    })

    await runLibrarian(dataDir, storyId, 'pr-0001')
  })

  it('appends summary update to a summary fragment (preserving legacy story.summary)', async () => {
    await createStory(dataDir, makeStory({ summary: 'The hero was born in a small village.' }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The hero walked into the dark forest.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'The hero ventured into the dark forest.' } },
    ])

    await runLibrarian(dataDir, storyId, 'pr-0001')

    // Legacy story.summary gets migrated to an era summary fragment; the new
    // analysis produces an Opening chapter summary fragment. Reading all
    // summary fragments together reproduces the original rolling string.
    const combined = await readSummaries(dataDir, storyId)
    expect(combined).toContain('The hero was born in a small village.')
    expect(combined).toContain('The hero ventured into the dark forest.')

    // Legacy field is cleared after migration.
    const story = await getStory(dataDir, storyId)
    expect(story!.summary).toBe('')
  })

  it('embeds summary and analysisId in prose fragment meta._librarian', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The hero walked into the dark forest.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'The hero ventured into the dark forest.' } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    const fragment = await getFragment(dataDir, storyId, 'pr-0001')
    expect(fragment).toBeTruthy()
    const librarian = fragment!.meta._librarian as { summary: string; analysisId: string }
    expect(librarian).toBeDefined()
    expect(librarian.summary).toBe('The hero ventured into the dark forest.')
    expect(librarian.analysisId).toBe(analysis.id)
  })

  it('embeds summary alongside mention annotations', async () => {
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
      { toolName: 'updateSummary', args: { summary: 'Alice drew her sword.' } },
      { toolName: 'reportMentions', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')

    const fragment = await getFragment(dataDir, storyId, 'pr-0001')
    expect(fragment).toBeTruthy()

    // Summary and analysisId embedded
    const librarian = fragment!.meta._librarian as { summary: string; analysisId: string }
    expect(librarian.summary).toBe('Alice drew her sword.')
    expect(librarian.analysisId).toBe(analysis.id)

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
      meta: { writerContextIds: ['ch-0001'] },
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    let capturedPrompt = ''
    mockAgentStream.mockImplementation((args: { prompt?: string }) => {
      capturedPrompt = args.prompt ?? ''
      return {
        fullStream: (async function* () {
          yield { type: 'finish' as const, finishReason: 'stop' }
        })(),
      }
    })

    await runLibrarian(dataDir, storyId, 'pr-0001')

    expect(capturedPrompt).toContain('## Characters in Recent Prose')
    expect(capturedPrompt).toContain('Alice carries a rune-etched blade.')
  })

  it('creates a new summary fragment when story had no prior summary', async () => {
    await createStory(dataDir, makeStory({ summary: '' }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'The story begins.' } },
    ])

    await runLibrarian(dataDir, storyId, 'pr-0001')

    expect(await readSummaries(dataDir, storyId)).toBe('The story begins.')
    const summaries = await listFragments(dataDir, storyId, 'summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0].meta?.isEraSummary).toBeFalsy()
  })

  it('applies deferred summaries contiguously and does not skip gaps', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        summarizationThreshold: 1,
      },
    }))

    for (const [idx, id] of ['pr-0001', 'pr-0002', 'pr-0003', 'pr-0004'].entries()) {
      await createFragment(dataDir, storyId, makeFragment({
        id,
        content: `Prose ${idx + 1}`,
      }))
    }
    await setupProseChain(dataDir, storyId, ['pr-0001', 'pr-0002', 'pr-0003', 'pr-0004'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Summary one.' } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    const stateAfterFirst = await getState(dataDir, storyId)
    expect(await readSummaries(dataDir, storyId)).toBe('Summary one.')
    expect(stateAfterFirst.summarizedUpTo).toBe('pr-0001')

    // pr-0002 remains unanalyzed. Even though pr-0003 has an analysis,
    // summarizedUpTo must not leap over the gap.
    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Summary three should wait.' } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0003')

    const stateAfterSecond = await getState(dataDir, storyId)
    const combined = await readSummaries(dataDir, storyId)
    expect(combined).toBe('Summary one.')
    expect(combined).not.toContain('Summary three should wait.')
    expect(stateAfterSecond.summarizedUpTo).toBe('pr-0001')
  })

  it('splits the chapter summary into an era summary + fresh chapter when the overflow threshold is exceeded', async () => {
    await createStory(dataDir, makeStory({
      settings: { summarizationThreshold: 0 },
    }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001', content: 'First prose' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    // Overflow threshold is 2000. Two large summaries combined should split.
    const big = 'Lorem ipsum dolor sit amet. '.repeat(50) // ≈1400 chars
    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: big + 'A' } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0002', content: 'Second prose' }))
    await setupProseChain(dataDir, storyId, ['pr-0001', 'pr-0002'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: big + 'B' } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0002')

    const active = await listFragments(dataDir, storyId, 'summary')
    const archived = await listFragments(dataDir, storyId, 'summary', { includeArchived: true })

    // The original chapter summary was archived; a new era summary and a
    // fresh chapter summary should both exist among the active fragments.
    expect(active.some(f => f.meta?.isEraSummary)).toBe(true)
    expect(active.some(f => !f.meta?.isEraSummary)).toBe(true)
    expect(archived.length).toBeGreaterThan(active.length)
  })

  it('uses latest analysis per fragment in deferred summary application', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        summarizationThreshold: 0,
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001', content: 'First prose' }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0002', content: 'Second prose' }))
    await setupProseChain(dataDir, storyId, ['pr-0001', 'pr-0002'])

    await saveAnalysis(dataDir, storyId, {
      id: 'la-old',
      createdAt: '2025-01-01T00:00:00.000Z',
      fragmentId: 'pr-0001',
      summaryUpdate: 'Old version should not be used.',
      mentions: [],
      contradictions: [],
      fragmentSuggestions: [],
      timelineEvents: [],
    })
    await saveAnalysis(dataDir, storyId, {
      id: 'la-new',
      createdAt: '2025-01-02T00:00:00.000Z',
      fragmentId: 'pr-0001',
      summaryUpdate: 'New version should be used.',
      mentions: [],
      contradictions: [],
      fragmentSuggestions: [],
      timelineEvents: [],
    })

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Second prose summary.' } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0002')

    const combined = await readSummaries(dataDir, storyId)
    expect(combined).toContain('New version should be used.')
    expect(combined).not.toContain('Old version should not be used.')
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
      { toolName: 'updateSummary', args: { summary: 'Alice confronted a dragon.' } },
      { toolName: 'reportMentions', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
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
      { toolName: 'updateSummary', args: { summary: 'A forbidden book pulsed on the altar.' } },
      {
        toolName: 'reportMentions',
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
      { toolName: 'updateSummary', args: { summary: 'They entered an underground market.' } },
      { toolName: 'reportMentions', args: { mentions: [{ fragmentId: 'loc-0001', text: 'Ash Market' }] } },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.mentions).toEqual([{ fragmentId: 'loc-0001', text: 'Ash Market' }])

    const fragment = await getFragment(dataDir, storyId, 'pr-0001')
    const annotations = fragment!.meta.annotations as Array<{ type: string; fragmentId: string; text: string }>
    expect(annotations).toEqual([{ type: 'mention', fragmentId: 'loc-0001', text: 'Ash Market' }])

    const state = await getState(dataDir, storyId)
    expect(state.recentMentions['loc-0001']).toEqual(['pr-0001'])
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
      { toolName: 'updateSummary', args: { summary: 'Alice entered the castle.' } },
      { toolName: 'reportMentions', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    // Second run
    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Alice found the treasure room.' } },
      { toolName: 'reportMentions', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
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
      content: 'Alice entered the castle.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Alice entered the castle.' } },
      { toolName: 'reportMentions', args: { mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }] } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Bob entered the castle.' } },
      { toolName: 'reportMentions', args: { mentions: [{ fragmentId: 'ch-0002', text: 'Bob' }] } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    let state = await getState(dataDir, storyId)
    expect(state.recentMentions['ch-0001']).toBeUndefined()
    expect(state.recentMentions['ch-0002']).toEqual(['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'The castle was empty.' } },
    ])
    await runLibrarian(dataDir, storyId, 'pr-0001')

    state = await getState(dataDir, storyId)
    expect(state.recentMentions).toEqual({})
  })

  it('flags contradictions', async () => {
    await createStory(dataDir, makeStory({ summary: 'Alice has blue eyes.' }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Alice looked at him with her green eyes.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Alice stared at the stranger.' } },
      {
        toolName: 'reportContradictions',
        args: {
          contradictions: [{
            description: 'Alice was described as having blue eyes, but new prose says green eyes.',
            fragmentIds: ['pr-0001'],
          }],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.contradictions).toHaveLength(1)
    expect(analysis.contradictions[0].description).toContain('blue eyes')
  })

  it('extracts knowledge suggestions', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The ancient city of Valdris stood atop the mountain.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'An ancient city called Valdris was revealed.' } },
      {
        toolName: 'suggestFragment',
        args: {
          suggestions: [{
            type: 'knowledge',
            name: 'Valdris',
            description: 'Ancient mountain city',
            content: 'Valdris is an ancient city located atop a mountain.',
          }],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.fragmentSuggestions).toHaveLength(1)
    expect(analysis.fragmentSuggestions[0].name).toBe('Valdris')
    expect(analysis.fragmentSuggestions[0].sourceFragmentId).toBe('pr-0001')
  })

  it('auto-applies suggestions and updates existing suggestion fragments', async () => {
    await createStory(dataDir, makeStory({
      settings: {
        autoApplyLibrarianSuggestions: true,
        summarizationThreshold: 0,
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
      { toolName: 'updateSummary', args: { summary: 'Valdris appears in old records.' } },
      {
        toolName: 'suggestFragment',
        args: {
          suggestions: [{
            type: 'knowledge',
            name: 'Valdris',
            description: 'Ancient city',
            content: 'Valdris is an ancient mountain city.',
          }],
        },
      },
    ])

    const first = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(first.fragmentSuggestions[0].accepted).toBe(true)
    expect(first.fragmentSuggestions[0].autoApplied).toBe(true)
    const createdId = first.fragmentSuggestions[0].createdFragmentId
    expect(createdId).toBeTruthy()

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Valdris defenses were revealed.' } },
      {
        toolName: 'suggestFragment',
        args: {
          suggestions: [{
            type: 'knowledge',
            name: 'Valdris',
            description: 'Ancient defended city',
            content: 'Valdris is an ancient mountain city guarded by stone sentinels.',
          }],
        },
      },
    ])

    const second = await runLibrarian(dataDir, storyId, 'pr-0002')
    expect(second.fragmentSuggestions[0].accepted).toBe(true)
    expect(second.fragmentSuggestions[0].autoApplied).toBe(true)
    expect(second.fragmentSuggestions[0].createdFragmentId).toBe(createdId)

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
        summarizationThreshold: 0,
      },
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'kn-0001',
      type: 'knowledge',
      name: 'Valdris',
      description: 'Ancient city',
      content: 'Valdris is an ancient city.',
    }))
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'Valdris is defended by sentinels made of stone.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Valdris defenses were revealed.' } },
      {
        toolName: 'suggestFragment',
        args: {
          suggestions: [{
            type: 'knowledge',
            targetFragmentId: 'kn-0001',
            name: 'Valdris',
            description: 'Ancient defended city',
            content: 'Valdris is an ancient city defended by stone sentinels.',
          }],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.fragmentSuggestions[0].accepted).toBe(true)
    expect(analysis.fragmentSuggestions[0].autoApplied).toBe(true)
    expect(analysis.fragmentSuggestions[0].createdFragmentId).toBe('kn-0001')

    const updated = await getFragment(dataDir, storyId, 'kn-0001')
    expect(updated).toBeTruthy()
    expect(updated?.content).toContain('stone sentinels')
    expect(updated?.refs).toContain('pr-0001')
  })

  it('tracks timeline events', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({
      id: 'pr-0001',
      content: 'The hero defeated the dragon. The village celebrated.',
    }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'The hero defeated the dragon and the village celebrated.' } },
      {
        toolName: 'reportTimeline',
        args: {
          events: [
            { event: 'Hero defeated the dragon', position: 'during' },
            { event: 'Village celebration', position: 'after' },
          ],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.timelineEvents).toHaveLength(2)

    const state = await getState(dataDir, storyId)
    expect(state.timeline).toHaveLength(2)
    expect(state.timeline[0].event).toBe('Hero defeated the dragon')
    expect(state.timeline[0].fragmentId).toBe('pr-0001')
  })

  it('saves the analysis result with trace', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Something happened.' } },
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

  it('falls back to text when no updateSummary tool is called', async () => {
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

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.summaryUpdate).toBe('This is the summary from text.')
  })

  it('derives summary from structured updateSummary payload when summary text is empty', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      {
        toolName: 'updateSummary',
        args: {
          summary: ' ',
          events: ['Alice entered the vault'],
          stateChanges: ['Alice now has the key'],
          openThreads: ['Who locked the vault?'],
        },
      },
    ])

    const analysis = await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(analysis.summaryUpdate).toContain('Events: Alice entered the vault.')
    expect(analysis.summaryUpdate).toContain('State changes: Alice now has the key.')
    expect(analysis.summaryUpdate).toContain('Open threads: Who locked the vault?.')
    expect(analysis.structuredSummary).toEqual({
      events: ['Alice entered the vault'],
      stateChanges: ['Alice now has the key'],
      openThreads: ['Who locked the vault?'],
    })
  })

  it('uses prompt with correct structure', async () => {
    await createStory(dataDir, makeStory())
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001' }))
    await setupProseChain(dataDir, storyId, ['pr-0001'])

    mockStreamWithToolCalls([
      { toolName: 'updateSummary', args: { summary: 'Prompt check.' } },
    ])

    await runLibrarian(dataDir, storyId, 'pr-0001')
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
    const call = mockAgentStream.mock.calls[0]?.[0] as { prompt?: string } | undefined
    expect(typeof call?.prompt).toBe('string')
  })
})
