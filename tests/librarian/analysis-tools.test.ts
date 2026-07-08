import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createAnalysisTools,
  createEmptyCollector,
  createLibrarianOnlineTools,
  listLibrarianAnalyzeToolNames,
  mentionInputSchema,
  reportAnalysisInputSchema,
} from '@/server/librarian/analysis-tools'
import { getFragment } from '@/server/fragments/storage'
import { fragmentBaseHash } from '@/server/fragments/change-operations'

vi.mock('@/server/fragments/storage', () => ({
  getFragment: vi.fn().mockResolvedValue(null),
  getStory: vi.fn().mockResolvedValue({ settings: { customFragmentTypes: [] } }),
  listFragments: vi.fn().mockResolvedValue([]),
  createFragment: vi.fn(),
  updateFragment: vi.fn(),
  updateFragmentVersioned: vi.fn().mockResolvedValue(null),
  migrateStoryToSummaryFragments: vi.fn().mockResolvedValue({ migrated: false }),
}))

function mockFragment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch-0001',
    type: 'character',
    name: 'Alice',
    description: 'A warrior',
    content: 'Alice is a brave warrior with blue eyes. Currently twenty years old.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: '',
    updatedAt: '',
    order: 0,
    meta: {},
    archived: false,
    version: 1,
    versions: [],
    ...overrides,
  } as never
}

describe('analysis-tools', () => {
  beforeEach(() => {
    vi.mocked(getFragment).mockResolvedValue(null)
  })

  it('creates a collector with empty fields', () => {
    const collector = createEmptyCollector()
    expect(collector.summaryUpdate).toBe('')
    expect(collector.structuredSummary).toEqual({ events: [], stateChanges: [], openThreads: [] })
    expect(collector.mentions).toEqual([])
    expect(collector.candidateFragmentIds).toEqual([])
    expect(collector.contradictions).toEqual([])
    expect(collector.fragmentChangeProposals).toEqual([])
    expect(collector.timelineEvents).toEqual([])
    expect(collector.directions).toEqual([])
  })

  it('exposes the online analysis tool names', () => {
    const tools = createAnalysisTools(createEmptyCollector())
    expect(Object.keys(tools)).toEqual([
      'reportAnalysis',
      'proposeFragmentChanges',
      'proposeDirections',
      'finishAnalysis',
    ])

    const onlineTools = createLibrarianOnlineTools(createEmptyCollector(), { dataDir: '/tmp', storyId: 'story-test' })
    expect(Object.keys(onlineTools)).toContain('reportAnalysis')
    expect(Object.keys(onlineTools)).toContain('readFragments')
    expect(Object.keys(onlineTools)).toContain('proposeFragmentChanges')
    expect(Object.keys(onlineTools)).toContain('proposeDirections')
    expect(Object.keys(onlineTools)).toContain('finishAnalysis')

    expect(listLibrarianAnalyzeToolNames()).toEqual(Object.keys(onlineTools))
  })

  it('omits suggestion and direction tools when disabled', () => {
    const tools = createAnalysisTools(createEmptyCollector(), {
      dataDir: '/tmp',
      storyId: 'story-test',
      disableSuggestions: true,
      disableDirections: true,
    })

    expect(Object.keys(tools)).toContain('reportAnalysis')
    expect(Object.keys(tools)).toContain('readFragments')
    expect(Object.keys(tools)).toContain('finishAnalysis')
    expect(tools).not.toHaveProperty('proposeFragmentChanges')
    expect(tools).not.toHaveProperty('proposeDirections')
  })

  it('finishAnalysis returns a terminal success marker without mutating analysis data', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    const result = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis'],
      skipped: [{ toolName: 'proposeDirections', reason: 'No useful branches yet.' }],
    }, { toolCallId: 'finish', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toEqual({
      ok: true,
      completed: ['reportAnalysis'],
      skipped: [{ toolName: 'proposeDirections', reason: 'No useful branches yet.' }],
    })
    expect(collector).toEqual(createEmptyCollector())
  })

  it('reportAnalysis sets summary, structured signals, mentions, contradictions, and timeline events', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    const result = await tools.reportAnalysis.execute!({
      summary: 'Alice drew her sword.',
      events: ['Alice drew her sword', 'Alice drew her sword'],
      stateChanges: ['Alice is armed'],
      openThreads: ['Who follows her?'],
      mentions: [
        { fragmentId: 'ch-0001', text: 'Alice' },
        { fragmentId: 'ch-0001', text: 'alice' },
        { fragmentId: 'kn-0001', text: 'Silver ash' },
      ],
      contradictions: [{ description: 'Eye color mismatch', fragmentIds: ['ch-0001'] }],
      timelineEvents: [{ event: 'Alice arms herself', position: 'during' }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, mentionCount: 2, contradictionCount: 1, timelineEventCount: 1 })
    expect(collector.summaryUpdate).toBe('Alice drew her sword.')
    expect(collector.structuredSummary.events).toEqual(['Alice drew her sword'])
    expect(collector.mentions).toEqual([
      { fragmentId: 'ch-0001', text: 'Alice' },
      { fragmentId: 'kn-0001', text: 'Silver ash' },
    ])
    expect(collector.contradictions[0].description).toBe('Eye color mismatch')
    expect(collector.timelineEvents[0]).toEqual({ event: 'Alice arms herself', position: 'during' })
  })

  it('reportAnalysis records validated candidate fragments for proposal context', async () => {
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, fragmentId) => (
      fragmentId === 'ch-0001' ? mockFragment({ id: fragmentId }) : null
    ))
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
    })

    const result = await tools.reportAnalysis.execute!({
      candidateFragmentIds: ['ch-0001', 'ch-0001'],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, candidateFragmentCount: 1 })
    expect(collector.candidateFragmentIds).toEqual(['ch-0001'])
    expect(collector.mentions).toEqual([])
  })

  it('reportAnalysis derives a summary from structured signals when summary text is empty', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    await tools.reportAnalysis.execute!({
      summary: '   ',
      events: ['Found the map', 'Met the guide'],
      stateChanges: ['Trust increased'],
      openThreads: ['Who sent the letter?'],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.summaryUpdate).toContain('Events: Found the map; Met the guide.')
    expect(collector.summaryUpdate).toContain('State changes: Trust increased.')
    expect(collector.summaryUpdate).toContain('Open threads: Who sent the letter?.')
  })

  it('reportAnalysis accepts an empty payload with a nudge instead of a schema error', async () => {
    // A schema-level rejection makes small models loop on resubmitting; an
    // empty report is acknowledged and nudged instead.
    await expect(reportAnalysisInputSchema.parseAsync({
      summary: '  ',
      events: [],
      stateChanges: [],
      openThreads: [],
    })).resolves.toBeTruthy()

    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)
    const result = await tools.reportAnalysis.execute!(
      { summary: '  ' },
      { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )
    expect(result).toMatchObject({ ok: true })
    expect(result.note).toContain('Empty report')
    expect(collector.summaryUpdate).toBe('')
  })

  it('mention schema requires a valid fragment id and non-empty text', async () => {
    await expect(mentionInputSchema.parseAsync({ fragmentId: 'ch-0001', text: ' Alice ' }))
      .resolves.toEqual({ fragmentId: 'ch-0001', text: 'Alice' })
    await expect(mentionInputSchema.parseAsync({ fragmentId: 'bad-id', text: 'Alice' })).rejects.toThrow()
    await expect(mentionInputSchema.parseAsync({ fragmentId: 'ch-0001', text: '   ' })).rejects.toThrow()
  })

  it('mentions have a wide schema ceiling for degenerate loops and a working clip in execute', async () => {
    const mention = { fragmentId: 'ch-0001', text: 'Alice' }
    // Two-tier limits: a verbose-but-sane list (here 150, the ceiling) passes
    // validation and is clipped in execute, so the batched call is never lost
    // over enthusiasm...
    await expect(reportAnalysisInputSchema.parseAsync({
      summary: 'Something happened.',
      mentions: Array.from({ length: 150 }, () => mention),
    })).resolves.toBeTruthy()
    // ...while a degenerate 400+-entry repeat (the failure seen in the wild) is
    // still rejected with a clean validation error.
    await expect(reportAnalysisInputSchema.parseAsync({
      summary: 'Something happened.',
      mentions: Array.from({ length: 401 }, () => mention),
    })).rejects.toThrow()
    await expect(reportAnalysisInputSchema.parseAsync({
      summary: 'Something happened.',
      mentions: Array.from({ length: 151 }, () => mention),
    })).rejects.toThrow()
  })

  it('reportAnalysis anchors mentions to the prose: salvages quote-wrapping, skips paraphrases', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'Alice studied the Silver ash by the gate.',
    })
    vi.mocked(getFragment).mockImplementation(async (_d: string, _s: string, id: string) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001' || id === 'kn-0001') return mockFragment({ id })
      return null
    })
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })

    const result = await tools.reportAnalysis.execute!({
      summary: 'Alice inspects the ash.',
      mentions: [
        { fragmentId: 'ch-0001', text: 'Alice' },
        { fragmentId: 'kn-0001', text: '"Silver ash"' },
        { fragmentId: 'ch-0001', text: 'her quiet menace' },
      ],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.mentions).toEqual([
      { fragmentId: 'ch-0001', text: 'Alice' },
      { fragmentId: 'kn-0001', text: 'Silver ash' },
    ])
    expect(result).toMatchObject({
      ok: true,
      mentionCount: 2,
      skippedMentions: [{ fragmentId: 'ch-0001', text: 'her quiet menace' }],
    })
  })

  it('reportAnalysis clips verbose payloads in execute instead of failing the call', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    await tools.reportAnalysis.execute!({
      summary: 'S'.repeat(2400),
      // 15 distinct events, one over-long — kept set clips to 8, items to 200 chars.
      events: Array.from({ length: 15 }, (_, i) => i === 0 ? 'E'.repeat(400) : `Event ${i}`),
      // 80 distinct mentions — working cap keeps 60.
      mentions: Array.from({ length: 80 }, (_, i) => ({ fragmentId: 'ch-0001', text: `Term ${i}` })),
      contradictions: Array.from({ length: 20 }, (_, i) => ({ description: `C${i}`, fragmentIds: ['ch-0001'] })),
      timelineEvents: Array.from({ length: 20 }, (_, i) => ({ event: `T${i}`, position: 'during' as const })),
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.summaryUpdate).toHaveLength(1200)
    expect(collector.structuredSummary.events).toHaveLength(8)
    expect(collector.structuredSummary.events[0]).toHaveLength(200)
    expect(collector.mentions).toHaveLength(60)
    expect(collector.contradictions).toHaveLength(12)
    expect(collector.timelineEvents).toHaveLength(12)
  })

  it('proposeFragmentChanges records create_fragment proposals', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'create_fragment',
        type: 'knowledge',
        name: 'Valdris',
        description: 'Ancient city',
        content: 'Valdris is ancient.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, proposalCount: 1, queuedOperationCount: 1 })
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      action: 'create_fragment',
      type: 'knowledge',
      name: 'Valdris',
      content: 'Valdris is ancient.',
    })
    expect(collector.fragmentChangeProposals[0].validation[0]).toMatchObject({
      operationId: 'op-1',
      action: 'create_fragment',
      status: 'valid',
    })
  })

  it('proposeFragmentChanges skips unavailable create_fragment types', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'create_fragment',
        type: 'location',
        name: 'Ash Market',
        description: '',
        content: 'A night market.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.fragmentChangeProposals).toHaveLength(0)
    expect(result.skipped[0].reason).toContain('not available')
  })

  it('proposeFragmentChanges skips create_fragment names copied from fragment ids', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'create_fragment',
        type: 'character',
        name: 'ch-thorne: Elias Thorne',
        description: 'Rival patron',
        content: 'Elias Thorne is a rival patron.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.fragmentChangeProposals).toHaveLength(0)
    expect(result.skipped[0].reason).toContain('human-readable name')
  })

  it('proposeFragmentChanges records exact replace_text proposals', async () => {
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? mockFragment({ id }) : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'replace_text',
        fragmentId: 'ch-0001',
        field: 'content',
        oldText: 'twenty years old',
        newText: 'twenty-one years old',
        reason: 'The prose says Alice had a birthday.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, proposalCount: 1, queuedOperationCount: 1 })
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      action: 'replace_text',
      fragmentId: 'ch-0001',
      field: 'content',
      oldText: 'twenty years old',
      newText: 'twenty-one years old',
      reason: 'The prose says Alice had a birthday.',
    })
    expect(collector.fragmentChangeProposals[0].validation[0]).toMatchObject({
      status: 'valid',
      target: { fragmentId: 'ch-0001', field: 'content' },
    })
  })

  it('proposeFragmentChanges records append_paragraph proposals', async () => {
    const originalContent = 'Alice is a brave warrior with blue eyes. Currently twenty years old.'
    const target = mockFragment({ id: 'ch-0001', content: originalContent })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? target : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'append_paragraph',
        fragmentId: 'ch-0001',
        field: 'content',
        text: 'Status: Alice has entered the western gate.',
        reason: 'The prose establishes her current location.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, proposalCount: 1, queuedOperationCount: 1 })
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      action: 'append_paragraph',
      fragmentId: 'ch-0001',
      field: 'content',
      text: 'Status: Alice has entered the western gate.',
      reason: 'The prose establishes her current location.',
    })
    expect(collector.fragmentChangeProposals[0].validation[0].diffs?.[0]).toMatchObject({
      field: 'content',
      before: '',
      after: 'Status: Alice has entered the western gate.',
    })
  })

  it('proposeFragmentChanges records archive_fragment proposals', async () => {
    const target = mockFragment({ id: 'ch-0001' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? target : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'archive_fragment',
        fragmentId: 'ch-0001',
        reason: 'The prose retires this fragment.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, proposalCount: 1, queuedOperationCount: 1 })
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      action: 'archive_fragment',
      fragmentId: 'ch-0001',
    })
    expect(collector.fragmentChangeProposals[0].validation[0]).toMatchObject({
      action: 'archive_fragment',
      status: 'valid',
      target: { fragmentId: 'ch-0001' },
    })
  })

  it('proposeFragmentChanges keeps multiple localized edits in one proposal', async () => {
    const originalContent = 'Alice is a brave warrior with blue eyes. Currently twenty years old.'
    const target = mockFragment({ id: 'ch-0001', content: originalContent })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? target : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [
        {
          action: 'replace_text',
          fragmentId: 'ch-0001',
          field: 'content',
          oldText: 'blue eyes',
          newText: 'hazel eyes',
          reason: 'The prose changes Alice eye color.',
        },
        {
          action: 'append_paragraph',
          fragmentId: 'ch-0001',
          field: 'content',
          text: 'Status: Alice has entered the western gate.',
          reason: 'The prose establishes her current location.',
        },
      ],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, proposalCount: 1, queuedOperationCount: 2 })
    expect(collector.fragmentChangeProposals).toHaveLength(1)
    expect(collector.fragmentChangeProposals[0].operations).toHaveLength(2)
    expect(collector.fragmentChangeProposals[0].operations.map((operation) => operation.action)).toEqual([
      'replace_text',
      'append_paragraph',
    ])
    expect(collector.fragmentChangeProposals[0].validation).toHaveLength(2)
    expect(collector.fragmentChangeProposals[0].validation.every((result) => result.status === 'valid')).toBe(true)
  })

  it('proposeFragmentChanges skips exact edits when oldText is absent, target is prose, or target is locked', async () => {
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'ch-0001') return mockFragment({ id })
      if (id === 'pr-0001') return mockFragment({ id, type: 'prose', content: 'Once.' })
      if (id === 'ch-locked') return mockFragment({ id, meta: { locked: true } })
      return null
    })

    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [
        { action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'green eyes', newText: 'hazel eyes' },
        { action: 'replace_text', fragmentId: 'pr-0001', field: 'content', oldText: 'Once', newText: 'Twice' },
        { action: 'replace_text', fragmentId: 'ch-locked', field: 'content', oldText: 'Alice', newText: 'Alicia' },
      ],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.fragmentChangeProposals).toHaveLength(0)
    expect(result.readFragmentIds).toEqual(['ch-0001'])
    expect(result.operations[0].errors[0].nextAction).toBe('readFragments')
    expect(result.skipped.map((s: { reason: string }) => s.reason).join('\n')).toContain('oldText was not found')
    expect(result.skipped.map((s: { reason: string }) => s.reason).join('\n')).toContain('Use editProse')
    expect(result.skipped.map((s: { reason: string }) => s.reason).join('\n')).toContain('locked')
  })

  it('proposeFragmentChanges does not queue replace_text operations with empty oldText', async () => {
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? mockFragment({ id }) : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'replace_text',
        fragmentId: 'ch-0001',
        field: 'content',
        oldText: '',
        newText: 'Inserted text.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: false, proposalCount: 0, queuedOperationCount: 0, invalid: 1 })
    expect(collector.fragmentChangeProposals).toHaveLength(0)
    expect(result.operations[0].errors[0].code).toBe('old_text_missing')
    expect(result.skipped[0].reason).toContain('replace_text requires oldText')
  })

  it('proposeFragmentChanges does not queue whole-field replace_text operations', async () => {
    const content = 'Alice is a brave warrior with blue eyes. Currently twenty years old.'
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? mockFragment({ id, content }) : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'replace_text',
        fragmentId: 'ch-0001',
        field: 'content',
        oldText: content,
        newText: 'Alice is a brave warrior with hazel eyes. Currently twenty-one years old.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: false, proposalCount: 0, queuedOperationCount: 0, invalid: 1 })
    expect(collector.fragmentChangeProposals).toHaveLength(0)
    expect(result.operations[0].errors[0].code).toBe('whole_field_replace_text')
    expect(result.skipped[0].reason).toContain('whole-field rewrite')
    expect(result.skipped[0].reason).toContain('set_fields with baseHash')
  })

  it('proposeFragmentChanges records set_fields as a whole-field proposal', async () => {
    const target = mockFragment({ id: 'ch-0001' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? target : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })
    const baseHash = fragmentBaseHash(target)

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'set_fields',
        fragmentId: 'ch-0001',
        baseHash,
        fields: {
          description: 'Updated',
          content: 'Alice is a brave warrior with hazel eyes. Currently twenty-one years old.',
        },
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result.proposalCount).toBe(1)
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      action: 'set_fields',
      fragmentId: 'ch-0001',
      baseHash,
      fields: {
        description: 'Updated',
        content: 'Alice is a brave warrior with hazel eyes. Currently twenty-one years old.',
      },
    })
    expect(collector.fragmentChangeProposals[0].validation[0]).toMatchObject({
      status: 'valid',
      target: { fragmentId: 'ch-0001' },
    })
  })

  it('proposeFragmentChanges rejects mixed exact edits and set_fields for the same target', async () => {
    const target = mockFragment({ id: 'ch-0001' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? target : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })
    const baseHash = fragmentBaseHash(target)

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [
        {
          action: 'replace_text',
          fragmentId: 'ch-0001',
          field: 'content',
          oldText: 'twenty years old',
          newText: 'twenty-one years old',
        },
        {
          action: 'set_fields',
          fragmentId: 'ch-0001',
          baseHash,
          fields: {
            content: 'Alice is a brave warrior with blue eyes. Currently twenty-one years old.',
          },
        },
      ],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: false, proposalCount: 0, queuedOperationCount: 0 })
    expect(collector.fragmentChangeProposals).toHaveLength(0)
    expect(result.skipped.map((s: { reason: string }) => s.reason).join('\n')).toContain('Submit set_fields and localized edits')
  })

  it('treats a resubmitted identical proposal as a success, not an error', async () => {
    const target = mockFragment({ id: 'ch-0001' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? target : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const operations = [{
      action: 'replace_text' as const,
      fragmentId: 'ch-0001',
      field: 'content' as const,
      oldText: 'twenty years old',
      newText: 'twenty-one years old',
    }]

    const first = await tools.proposeFragmentChanges.execute!({ operations }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })
    expect(first).toMatchObject({ ok: true, proposalCount: 1 })

    const second = await tools.proposeFragmentChanges.execute!({ operations }, { toolCallId: 'b', messages: [], abortSignal: undefined as unknown as AbortSignal })
    // A duplicate does not queue a second proposal, but it is not an error and
    // does not count against `ok`/`invalid` — it just acknowledges the dedupe.
    expect(second).toMatchObject({ ok: true, proposalCount: 1, invalid: 0, duplicate: true })
    expect(collector.fragmentChangeProposals).toHaveLength(1)
  })

  it('a retried batch queues only the operations not already queued', async () => {
    const target = mockFragment({ id: 'ch-0001' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'ch-0001' ? target : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const createOperation = {
      action: 'create_fragment' as const,
      type: 'knowledge',
      name: 'Valdris',
      description: 'Ancient city',
      content: 'Valdris is an ancient mountain city.',
    }

    // First batch: the create is valid and queues; the edit has a bad anchor.
    const first = await tools.proposeFragmentChanges.execute!({
      operations: [
        createOperation,
        {
          action: 'replace_text' as const,
          fragmentId: 'ch-0001',
          field: 'content' as const,
          oldText: 'text that does not exist',
          newText: 'former captain',
        },
      ],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })
    expect(first).toMatchObject({ ok: false, proposalCount: 1, queuedOperationCount: 1, invalid: 1 })

    // Retry resubmits the whole batch with the edit fixed. The create must not
    // queue a second time — otherwise accepting both proposals creates the
    // fragment twice.
    const second = await tools.proposeFragmentChanges.execute!({
      operations: [
        createOperation,
        {
          action: 'replace_text' as const,
          fragmentId: 'ch-0001',
          field: 'content' as const,
          oldText: 'twenty years old',
          newText: 'twenty-one years old',
        },
      ],
    }, { toolCallId: 'b', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(second).toMatchObject({ ok: true, proposalCount: 2, queuedOperationCount: 1, invalid: 0 })
    expect(second.alreadyQueuedOperationIds).toHaveLength(1)
    expect(collector.fragmentChangeProposals).toHaveLength(2)
    expect(collector.fragmentChangeProposals[0].operations.map((op: { action: string }) => op.action)).toEqual(['create_fragment'])
    expect(collector.fragmentChangeProposals[1].operations.map((op: { action: string }) => op.action)).toEqual(['replace_text'])
  })

  it('a lightly reworded resubmission of a queued append is treated as a duplicate', async () => {
    const target = mockFragment({ id: 'kn-0001', type: 'knowledge' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) =>
      id === 'kn-0001' ? target : null,
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const paragraph = 'The Maritime Heritage Initiative branding is now serving as a cover for the smuggling operation across the harbor district.'
    const first = await tools.proposeFragmentChanges.execute!({
      operations: [{ action: 'append_paragraph' as const, fragmentId: 'kn-0001', field: 'content' as const, text: paragraph }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })
    expect(first).toMatchObject({ ok: true, proposalCount: 1 })

    // Same fact, different whitespace and casing — must not queue a second
    // proposal that can only fail on apply with a repeated-paragraph error.
    const second = await tools.proposeFragmentChanges.execute!({
      operations: [{
        action: 'append_paragraph' as const,
        fragmentId: 'kn-0001',
        field: 'content' as const,
        text: 'the maritime heritage initiative  branding is now serving as a cover for the smuggling operation across   the harbor district.',
      }],
    }, { toolCallId: 'b', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(second).toMatchObject({ ok: true, proposalCount: 1, duplicate: true, queuedOperationCount: 0 })
    expect(collector.fragmentChangeProposals).toHaveLength(1)
  })

  it('proposeFragmentChanges skips set_fields without baseHash and frozen-section violations', async () => {
    const frozen = mockFragment({
      id: 'kn-frozen',
      type: 'knowledge',
      content: 'The ancient city of Valdris stands eternal.',
      meta: { frozenSections: [{ id: 'fs-1', text: 'The ancient city of Valdris stands eternal.' }] },
    })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'ch-0001') return mockFragment({ id })
      if (id === 'kn-frozen') return frozen
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test' })

    const result = await tools.proposeFragmentChanges.execute!({
      operations: [
        { action: 'set_fields', fragmentId: 'ch-0001', fields: { description: 'Updated' } },
        { action: 'set_fields', fragmentId: 'kn-frozen', baseHash: fragmentBaseHash(frozen), fields: { content: 'Valdris was destroyed.' } },
      ],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.fragmentChangeProposals).toHaveLength(0)
    expect(result.skipped.map((s: { reason: string }) => s.reason).join('\n')).toContain('requires baseHash')
    expect(result.skipped.map((s: { reason: string }) => s.reason).join('\n')).toContain('Frozen section')
  })

  it('proposeDirections records directions', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    await tools.proposeDirections.execute!({
      directions: [
        { title: 'Into the forest', description: 'The hero enters the dark forest.', instruction: 'Write the hero entering the forest.' },
        { title: 'A stranger arrives', description: 'A stranger appears.', instruction: 'Introduce a stranger.' },
        { title: 'Inner reflection', description: 'The hero reflects.', instruction: 'Write an introspective passage.' },
      ],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.directions).toHaveLength(3)
    expect(collector.directions[0].title).toBe('Into the forest')
  })
})
