import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createAnalysisTools,
  createEmptyCollector,
  buildReportAnalysisInputSchema,
  createLibrarianOnlineTools,
  librarianFinishAnalysisInputSchema,
  librarianRecordCorrectionsInputSchema,
  listLibrarianAnalyzeToolNames,
  anchorMentionText,
  mentionInputSchema,
  reportAnalysisInputSchema,
} from '@/server/librarian/analysis-tools'
import { getFragment } from '@/server/fragments/storage'
import type { Fragment } from '@/server/fragments/schema'

vi.mock('@/server/fragments/storage', () => ({
  getFragment: vi.fn().mockResolvedValue(null),
  getStory: vi.fn().mockResolvedValue({ settings: { customFragmentTypes: [] } }),
  listFragments: vi.fn().mockResolvedValue([]),
  createFragment: vi.fn(),
  updateFragment: vi.fn(),
  updateFragmentVersioned: vi.fn().mockResolvedValue(null),
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
  } as Fragment
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
    expect(collector.continuityProjection).toEqual({
      version: 1,
      temporalFrame: { relation: 'uncertain' },
      stateOperations: [],
      threadOperations: [],
      threadFocus: [],
      knowledgeOperations: [],
    })
    expect(collector.directions).toEqual([])
  })

  it('does not collect global participant or witness rosters', () => {
    const parsed = reportAnalysisInputSchema.parse({
      participantIds: ['ch-0001'],
      witnessIds: ['ch-0002'],
    })
    expect(parsed).not.toHaveProperty('participantIds')
    expect(parsed).not.toHaveProperty('witnessIds')
  })

  it('exposes the online analysis tool names', () => {
    const tools = createAnalysisTools(createEmptyCollector())
    expect(Object.keys(tools)).toEqual([
      'reportAnalysis',
      'proposeDirections',
      'finishAnalysis',
    ])

    const onlineTools = createLibrarianOnlineTools(createEmptyCollector(), {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
    })
    expect(Object.keys(onlineTools)).toContain('reportAnalysis')
    expect(Object.keys(onlineTools)).toContain('readFragments')
    expect(Object.keys(onlineTools)).toContain('proposeRecordCorrections')
    expect(Object.keys(onlineTools)).toContain('proposeNewRecords')
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
    expect(tools).not.toHaveProperty('proposeRecordCorrections')
    expect(tools).not.toHaveProperty('proposeNewRecords')
    expect(tools).not.toHaveProperty('proposeDirections')
  })

  it('finishAnalysis requires directions whenever the automatic direction tool is available', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    await tools.reportAnalysis.execute!({ summary: 'A quiet passage.' }, {
      toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    const skipped = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis'],
      skipped: [{ toolName: 'proposeDirections', reason: 'No useful branches yet.' }],
    }, { toolCallId: 'finish', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(skipped).toMatchObject({
      ok: false,
      missingRequired: ['proposeDirections'],
    })

    await tools.proposeDirections.execute!({
      directions: [
        { title: 'Wait', description: 'The pause lengthens.', instruction: 'Continue the tense pause.' },
        { title: 'Enter', description: 'A visitor arrives.', instruction: 'Introduce the unexpected visitor.' },
        { title: 'Leave', description: 'Someone walks away.', instruction: 'Follow the abrupt departure.' },
      ],
    }, { toolCallId: 'directions', messages: [], abortSignal: undefined as unknown as AbortSignal })
    const completed = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis', 'proposeDirections'],
    }, { toolCallId: 'finish-complete', messages: [], abortSignal: undefined as unknown as AbortSignal })
    expect(completed).toMatchObject({ ok: true })
  })

  it('finishAnalysis rejects a failed proposal falsely claimed as completed', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice waited.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', disableDirections: true,
    })
    await tools.reportAnalysis.execute!({ summary: 'Alice waited.' }, {
      toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1], corrections: [],
    }, { toolCallId: 'proposal', messages: [], abortSignal: undefined as unknown as AbortSignal })

    const falseFinish = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis', 'proposeRecordCorrections'],
      skipped: [{ toolName: 'proposeNewRecords', reason: 'No new reusable record.' }],
    }, { toolCallId: 'false-finish', messages: [], abortSignal: undefined as unknown as AbortSignal })
    const honestFinish = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis'],
      skipped: [
        { toolName: 'proposeRecordCorrections', reason: 'The attempted correction was invalid.' },
        { toolName: 'proposeNewRecords', reason: 'No new reusable record.' },
      ],
    }, { toolCallId: 'honest-finish', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(falseFinish).toMatchObject({ ok: false, falseCompleted: ['proposeRecordCorrections'] })
    expect(honestFinish).toMatchObject({ ok: true })
  })

  // Timeline 9 made 24 finishAnalysis calls for 16 analyses. Six were rejected
  // only because a successful correction was not paired with a skip note for
  // the discovery lane, which had nothing to propose.
  it('finishAnalysis accepts a lane that was never needed without a skip note', async () => {
    const current = 'Alice is captain of the guard. She keeps the north gate.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice resigned from the guard.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      disableDirections: true,
      numberedFragmentIds: ['ch-0001'],
    })
    await tools.reportAnalysis.execute!({ summary: 'Alice resigned.' }, {
      toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    const correction = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 1,
        newText: 'Alice is the former captain of the guard.',
      }],
    }, { toolCallId: 'correction', messages: [], abortSignal: undefined as unknown as AbortSignal })

    const finish = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis', 'proposeRecordCorrections'],
    }, { toolCallId: 'finish', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(correction).toMatchObject({ ok: true, queuedOperationCount: 1 })
    expect(finish).toMatchObject({ ok: true })
  })

  /**
   * Partial credit keeps the queued work; it must not also quietly close the
   * lane. What the call rejected is still outstanding, so finish either sees a
   * retry or a reason.
   */
  it('finishAnalysis holds a partly queued lane to the same account as a failed one', async () => {
    const current = 'Alice is captain of the guard. She keeps the north gate.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice resigned from the guard.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      disableDirections: true,
      numberedFragmentIds: ['ch-0001'],
    })
    await tools.reportAnalysis.execute!({ summary: 'Alice resigned.' }, {
      toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    const correction = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [
        { fragmentId: 'ch-0001', segment: 1, newText: 'Alice is the former captain of the guard.' },
        { fragmentId: 'ch-0001', segment: 2, newText: 'She keeps the north gate.' },
      ],
    }, { toolCallId: 'partial', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(correction).toMatchObject({ ok: true, queuedOperationCount: 1, invalid: 1 })

    const bare = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis', 'proposeRecordCorrections'],
    }, { toolCallId: 'finish-bare', messages: [], abortSignal: undefined as unknown as AbortSignal })
    expect(bare).toMatchObject({ ok: false, missingRequired: ['proposeRecordCorrections'] })

    const explained = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis'],
      skipped: [{ toolName: 'proposeRecordCorrections', reason: 'The rejected line was already accurate.' }],
    }, { toolCallId: 'finish-explained', messages: [], abortSignal: undefined as unknown as AbortSignal })
    expect(explained).toMatchObject({ ok: true })
  })

  it('finishAnalysis still refuses to abandon a proposal lane left in a failed state', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice waited.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', disableDirections: true,
    })
    await tools.reportAnalysis.execute!({ summary: 'Alice waited.' }, {
      toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    await tools.proposeNewRecords.execute!({
      evidenceSegments: [1], newFragments: [],
    }, { toolCallId: 'attempt', messages: [], abortSignal: undefined as unknown as AbortSignal })

    const finish = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis'],
    }, { toolCallId: 'finish', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(finish).toMatchObject({ ok: false, missingRequired: ['proposeNewRecords'] })
  })

  // Timeline 10 rejected five of twenty-three finish calls purely because the
  // lane was named as a bare string. Every one of them was a lane never called,
  // which the gate does not require to be declared at all.
  it('finishAnalysis accepts a lane abandoned by name alone', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', disableDirections: true,
    })
    await tools.reportAnalysis.execute!({ summary: 'Alice waited.' }, {
      toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })

    const parsed = librarianFinishAnalysisInputSchema.parse({
      completed: ['reportAnalysis'],
      skipped: ['proposeRecordCorrections', 'proposeNewRecords'],
    })
    const finish = await tools.finishAnalysis.execute!(parsed, {
      toolCallId: 'finish', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })

    expect(finish).toMatchObject({
      ok: true,
      skipped: [{ toolName: 'proposeRecordCorrections' }, { toolName: 'proposeNewRecords' }],
    })
  })

  it('finishAnalysis still demands a reason for abandoning a lane it left failing', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice waited.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', disableDirections: true,
    })
    await tools.reportAnalysis.execute!({ summary: 'Alice waited.' }, {
      toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    await tools.proposeNewRecords.execute!({
      evidenceSegments: [1], newFragments: [],
    }, { toolCallId: 'attempt', messages: [], abortSignal: undefined as unknown as AbortSignal })

    const bare = await tools.finishAnalysis.execute!(
      librarianFinishAnalysisInputSchema.parse({
        completed: ['reportAnalysis'],
        skipped: ['proposeNewRecords'],
      }),
      { toolCallId: 'bare', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )
    const explained = await tools.finishAnalysis.execute!(
      librarianFinishAnalysisInputSchema.parse({
        completed: ['reportAnalysis'],
        skipped: [{ toolName: 'proposeNewRecords', reason: 'Nothing reusable was established.' }],
      }),
      { toolCallId: 'explained', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )

    expect(bare).toMatchObject({ ok: false, unexplained: ['proposeNewRecords'] })
    expect(explained).toMatchObject({ ok: true })
  })

  // Continuity memory names its keys the way the catalog names records, so
  // Timeline 10 aimed a correction at a state key and spent an extra report
  // round trip working the distinction out from a note that only said the
  // target could not be read.
  it('names the lane that owns a continuity key aimed at as a correctable record', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Her throat bruised.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const collector = createEmptyCollector()
    const tools = createLibrarianOnlineTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      disableDirections: true,
      continuityKeys: { state: ['victoria_physical_state_post_waters'] },
    })

    const atKey = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{ fragmentId: 'victoria_physical_state_post_waters', segment: 1, newText: 'Bruised throat.' }],
    }, { toolCallId: 'at-key', messages: [], abortSignal: undefined as unknown as AbortSignal })
    const atNothing = await tools.proposeRecordCorrections.execute!({
      corrections: [{ fragmentId: 'ch-missing', segment: 1, newText: 'Bruised throat.' }],
    }, { toolCallId: 'at-nothing', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(atKey).toMatchObject({ ok: false })
    expect((atKey as { skipped: Array<{ reason: string }> }).skipped[0].reason)
      .toBe('victoria_physical_state_post_waters is a state key in continuity memory, not a reusable record. Change it with a reportAnalysis state operation instead.')
    // A genuinely absent record must not be mislabelled as continuity memory.
    expect((atNothing as { skipped: Array<{ reason: string }> }).skipped[0].reason)
      .toBe('There is no reusable record ch-missing. Correct only records whose numbered sentences you were shown.')
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

  it('deduplicates contradictions and timeline events when a model repeats reportAnalysis', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)
    const report = {
      contradictions: [{ description: 'Eye color mismatch', fragmentIds: ['ch-0001'] }],
      timelineEvents: [{ event: 'Alice arms herself', position: 'during' as const }],
    }

    await tools.reportAnalysis.execute!(report, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })
    await tools.reportAnalysis.execute!(report, { toolCallId: 'b', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.contradictions).toHaveLength(1)
    expect(collector.timelineEvents).toHaveLength(1)
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

  it('reportAnalysis records evidence-backed structured continuity and skips unsupported operations', async () => {
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'Alice entered the north hall. Bob heard Alice say that the seal was broken.',
    })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, fragmentId) => {
      if (fragmentId === 'pr-0001') return prose
      if (fragmentId === 'ch-0001') return mockFragment({ id: fragmentId, type: 'character' })
      if (fragmentId === 'ch-0002') return mockFragment({ id: fragmentId, type: 'character' })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
    })

    const result = await tools.reportAnalysis.execute!({
      summary: 'Alice enters and tells Bob about the seal.',
      temporalFrame: { relation: 'forward' },
      stateOperations: [
        {
          key: 'alice.location',
          action: 'set',
          subject: 'Alice location',
          value: 'north hall',
          evidenceSegments: [1],
        },
        {
          // Sentence 7 does not exist in a two-sentence passage.
          key: 'seal.color',
          action: 'set',
          subject: 'Seal color',
          value: 'red',
          evidenceSegments: [7],
        },
      ],
      threadOperations: [{
        key: 'broken-seal',
        action: 'open',
        label: 'Why the seal was broken',
        relatedFragmentIds: ['ch-0001'],
        evidenceSegments: [2],
      }],
      threadFocus: [{ threadKey: 'broken-seal', visibility: 'background' }],
      knowledgeOperations: [{
        characterId: 'ch-0002',
        key: 'seal.broken',
        action: 'learn',
        fact: 'The seal is broken.',
        acquisition: 'told',
        evidenceSegments: [2],
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({
      ok: true,
      stateOperationCount: 1,
      threadOperationCount: 1,
      focusedThreadCount: 1,
      knowledgeOperationCount: 1,
    })
    expect(result.skippedContinuity).toEqual([
      { kind: 'state', key: 'seal_color', reason: 'Cited sentence 7 does not exist in the passage.' },
    ])
    // Keys are canonicalized at ingest so near-synonym spellings collapse into
    // one reusable identity; skippedContinuity still echoes what was submitted.
    expect(collector.continuityProjection).toMatchObject({
      temporalFrame: { relation: 'forward' },
      stateOperations: [{
        stateKey: 'alice_location',
        value: 'north hall',
        evidenceSegments: [1],
        evidenceText: 'Alice entered the north hall.',
      }],
      threadOperations: [{ threadKey: 'broken_seal', action: 'open' }],
      threadFocus: [{ threadKey: 'broken_seal', visibility: 'background' }],
      knowledgeOperations: [{ characterId: 'ch-0002', knowledgeKey: 'seal_broken' }],
    })
    expect(collector.continuityProjection).not.toHaveProperty('participantIds')
    expect(collector.continuityProjection).not.toHaveProperty('witnessIds')
  })

  it('records only contradictions grounded on both the new prose and a reusable fragment', async () => {
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'Alice looked at him with her green eyes.',
    })
    const character = mockFragment({
      id: 'ch-0001',
      type: 'character',
      content: 'Alice has blue eyes.',
    })
    const earlierProse = mockFragment({
      id: 'pr-0002',
      type: 'prose',
      content: 'Alice selected a black dress.',
    })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, fragmentId) => {
      if (fragmentId === prose.id) return prose
      if (fragmentId === character.id) return character
      if (fragmentId === earlierProse.id) return earlierProse
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: prose.id,
    })

    const result = await tools.reportAnalysis.execute!({
      contradictions: [
        {
          description: 'Alice has incompatible eye colors.',
          sourceSegments: [1],
          conflictingEvidence: [{ fragmentId: character.id, segments: [1] }],
        },
        {
          description: 'A later clothing choice was mistaken for a contradiction.',
          sourceSegments: [1],
          conflictingEvidence: [{ fragmentId: earlierProse.id, segments: [1] }],
        },
        {
          description: 'An ungrounded guess.',
          fragmentIds: [character.id],
        },
      ],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({
      ok: true,
      contradictionCount: 1,
      skippedContradictions: [
        {
          description: 'A later clothing choice was mistaken for a contradiction.',
          reason: 'Cite the numbered sentence in pr-0002 that carries the incompatible claim; it must be a reusable non-prose record.',
        },
        {
          description: 'An ungrounded guess.',
          reason: 'No supporting sentence was cited.',
        },
      ],
    })
    expect(collector.contradictions).toEqual([{
      description: 'Alice has incompatible eye colors.',
      fragmentIds: [character.id],
      sourceSegments: [1],
      sourceEvidenceText: 'Alice looked at him with her green eyes.',
      // The cited sentence is resolved server-side, so the stored finding keeps
      // reviewable text without the model ever having retyped it.
      conflictingEvidence: [{
        fragmentId: character.id,
        segments: [1],
        evidenceText: 'Alice has blue eyes.',
      }],
    }])
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

  it('reportAnalysis nudges an empty payload instead of raising a schema error', async () => {
    // A schema-level rejection makes small models loop on resubmitting the
    // whole payload, so an empty report is still a normal tool result.
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
    expect(result).toMatchObject({ ok: false })
    expect(result.note).toContain('Empty report')
    expect(collector.summaryUpdate).toBe('')
  })

  // The empty report used to answer ok:true while withholding the success
  // marker, so finishAnalysis then told the model it had falsely claimed the
  // very call that had just reported success. The two surfaces must agree.
  it('reports an empty analysis consistently to the reporting tool and to finish', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', disableDirections: true,
    })

    const empty = await tools.reportAnalysis.execute!({ summary: '  ' }, {
      toolCallId: 'empty', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    const finishAfterEmpty = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis'],
    }, { toolCallId: 'finish-empty', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(empty).toMatchObject({ ok: false })
    // Not "you falsely completed a call that just told you it was fine".
    expect(finishAfterEmpty).toMatchObject({
      ok: false,
      falseCompleted: ['reportAnalysis'],
      missingRequired: ['reportAnalysis'],
    })

    await tools.reportAnalysis.execute!({ summary: 'Alice waited by the gate.' }, {
      toolCallId: 'retry', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    const finishAfterRetry = await tools.finishAnalysis.execute!({
      completed: ['reportAnalysis'],
    }, { toolCallId: 'finish-retry', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(finishAfterRetry).toMatchObject({ ok: true })
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

  // Brevity in citations is a preference, not an invariant: over-citing costs a
  // longer stored evidence string and nothing else. As a schema `.max(8)` it
  // rejected the whole payload, and Timeline 10 lost a full reportAnalysis and
  // proposeDirections round trip because one knowledge operation cited nine.
  it('keeps a report that over-cites, clipping the citation rather than rejecting the call', async () => {
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} happened.`).join(' '),
    })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    const overCited = [1, 2, 3, 4, 5, 6, 7, 8, 9]

    const parsed = await reportAnalysisInputSchema.parseAsync({
      summary: 'Much happened.',
      stateOperations: [{
        key: 'alice_condition',
        action: 'set',
        subject: 'Alice',
        value: 'weary',
        evidenceSegments: overCited,
      }],
    })
    const result = await tools.reportAnalysis.execute!(parsed, {
      toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })

    expect(result).toMatchObject({ ok: true, stateOperationCount: 1 })
    expect(collector.continuityProjection.stateOperations[0].evidenceSegments)
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8])
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
      skippedMentions: [{
        fragmentId: 'ch-0001',
        text: 'her quiet menace',
        // The reason belongs to the entry, not only to the note beside the
        // list: the trace panel reads entries, and an entry without one is a
        // loss reported as a blank line.
        reason: 'Not verbatim in the passage, so it cannot be highlighted.',
      }],
    })
  })

  it('anchors exact rendered phrases split by inline Markdown without accepting paraphrases', () => {
    expect(anchorMentionText('Medicine file', 'the *medicine* file remained sealed.')).toBe('Medicine')
    expect(anchorMentionText('seaward dike', 'the dike remained sealed.')).toBeNull()
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

  it('online analysis marks an exact evidence-backed correction safe for unattended apply', async () => {
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'Alice resigned and became former captain of the guard.',
    })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: 'Alice is captain of the guard. She keeps the north gate.' })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      rationale: 'The existing role assertion is now false and would mislead future scenes.',
      corrections: [{
        fragmentId: 'ch-0001',
        field: 'content',
        segment: 1,
        newText: 'Alice is the former captain of the guard.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, evidenceMatched: true, autoApplySafe: true })
    expect(collector.fragmentChangeProposals[0]).toMatchObject({
      proposalKind: 'correction',
      evidenceSegments: [1],
      autoApplySafe: true,
    })
  })

  it('keeps corrections and discoveries in separate semantic proposals', async () => {
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'Alice resigned as captain and founded the Lantern Archive.',
    })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: 'Alice is captain. The role defines her public duties.' })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      numberedFragmentIds: ['ch-0001'],
    })

    const correctionResult = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      rationale: 'The old role is false.',
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 1,
        newText: 'Alice is a former captain.',
      }],
    }, { toolCallId: 'correction', messages: [], abortSignal: undefined as unknown as AbortSignal })
    const discoveryResult = await tools.proposeNewRecords.execute!({
      evidenceSegments: [1],
      rationale: 'The newly founded institution is a reusable named record.',
      newFragments: [{
        type: 'knowledge',
        name: 'Lantern Archive',
        description: 'An archive founded by Alice.',
        content: 'The Lantern Archive was founded by Alice.',
      }],
    }, { toolCallId: 'discovery', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(correctionResult).toMatchObject({ ok: true, queuedOperationCount: 1 })
    expect(discoveryResult).toMatchObject({ ok: true, queuedOperationCount: 1 })
    expect(collector.fragmentChangeProposals).toHaveLength(2)
    expect(collector.fragmentChangeProposals.map((proposal) => proposal.proposalKind))
      .toEqual(['correction', 'new-fragment'])
  })

  // Paraphrase is no longer a reachable failure: evidence is a citation, so
  // there is nothing to reword. What remains is citing a sentence that is not
  // there, which the model can see and fix from the numbered passage.
  it('rejects a citation the passage does not contain', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice resigned from the guard.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: 'Alice is captain of the guard. She keeps the north gate.' })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [4],
      rationale: 'The existing role assertion is now false and would mislead future scenes.',
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 1,
        newText: 'Alice is the former captain of the guard.',
      }],
    }, { toolCallId: 'a', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: false, evidenceMatched: false, queuedOperationCount: 0 })
    expect(String((result as { note: string }).note)).toContain('sentence 4 does not exist')
    expect(collector.fragmentChangeProposals).toEqual([])
  })

  it('rejects an empty record-maintenance proposal without mutating analysis', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice waited.' })
    vi.mocked(getFragment).mockResolvedValue(prose)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [],
    }, { toolCallId: 'empty', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: false, queuedOperationCount: 0 })
    expect(collector.fragmentChangeProposals).toEqual([])
  })

  it('retains grounded evidence while the model retries only correction fields', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice resigned from the guard.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: 'Alice is captain of the guard. She keeps the north gate.' })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    const first = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [],
    }, { toolCallId: 'first', messages: [], abortSignal: undefined as unknown as AbortSignal })
    const retry = await tools.proposeRecordCorrections.execute!({
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 1,
        newText: 'Alice is the former captain of the guard.',
      }],
    }, { toolCallId: 'retry', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(first).toMatchObject({ ok: false, evidenceRetained: true })
    expect(retry).toMatchObject({ ok: true, evidenceMatched: true, queuedOperationCount: 1 })
    expect(collector.fragmentChangeProposals[0].evidenceText).toBe('Alice resigned from the guard.')
  })

  // Timeline 9 applied seven unattended corrections. Every one submitted a
  // copied paragraph, one failed outright on `oldText was not found`, and two
  // were episode recaps. None of those shapes is expressible now: a correction
  // names one numbered sentence and the server resolves the exact span.
  it('resolves a cited sentence to the exact span it replaces', async () => {
    // The record was shown numbered, which is what makes segment 2 addressable.
    const current = 'Sanne is a River Hearth priestess. She has never met Victoria. She keeps the gate.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Sanne greets me at the First Hearth.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 2,
        newText: 'She has met Victoria once, at the First Hearth.',
      }],
    }, { toolCallId: 'cited', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, queuedOperationCount: 1 })
    const operation = collector.fragmentChangeProposals[0].operations[0]
    if (operation.action !== 'replace_text') throw new Error('Expected replace_text')
    // The model never stated the old text, so it cannot have got it wrong.
    expect(operation.oldText).toBe('She has never met Victoria.')
    expect(current.replace(operation.oldText, operation.newText)).toBe(
      'Sanne is a River Hearth priestess. She has met Victoria once, at the First Hearth. She keeps the gate.',
    )
  })

  it('still refuses a single sentence inflated into an episode recap', async () => {
    const current = 'Sanne has never met Victoria. No hostility exists at baseline.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'She is overwritten by the abundance of ninety-six men.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 1,
        newText: 'Sanne has met Victoria, and has since completed the first stage of the Trial, '
          + 'embracing a state of total physical and psychological erasure as she is overwritten '
          + 'by the abundance of ninety-six men before transferring to the River Hearth.',
      }],
    }, { toolCallId: 'recap', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: false, queuedOperationCount: 0, evidenceRetained: true })
    expect(JSON.stringify(result)).toContain('do not restate the scene')
    expect(collector.fragmentChangeProposals).toEqual([])
  })

  // Timeline 12 aimed a correction at `He is waiting.` (14 characters) to record
  // that the character had been killed. The old floor granted a flat 80 extra
  // characters, so the allowance was 94 and the correction was refused — the
  // stale-status case record correction exists for was unreachable by
  // construction on any terse assertion.
  it('lets a terse assertion be corrected into a specific one', async () => {
    const current = 'Konstantin Severi is a Cypriot oligarch. He is waiting. His houses are in Monaco.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Victoria killed Severi in the study.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 2,
        newText: 'He is deceased, having been murdered by Victoria in a calculated act of personal defense and internal reclamation.',
      }],
    }, { toolCallId: 'terse', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, queuedOperationCount: 1 })
    const operation = collector.fragmentChangeProposals[0].operations[0]
    if (operation.action !== 'replace_text') throw new Error('Expected replace_text')
    expect(operation.oldText).toBe('He is waiting.')
  })

  // The record is presented sentence-numbered, so the model writes the marker
  // back with its replacement. Timeline 12 sent `[16] He is deceased...`; left
  // in, the marker inflates the length check and is written into the record.
  it('strips the presentation marker the numbering taught the model to echo', async () => {
    const current = 'Alice is captain of the guard. She keeps the north gate.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice resigned from the guard.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 1,
        newText: '[1] Alice is the former captain of the guard.',
      }],
    }, { toolCallId: 'marker', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: true, queuedOperationCount: 1 })
    const operation = collector.fragmentChangeProposals[0].operations[0]
    if (operation.action !== 'replace_text') throw new Error('Expected replace_text')
    expect(operation.newText).toBe('Alice is the former captain of the guard.')
    expect(current.replace(operation.oldText, operation.newText)).toBe(
      'Alice is the former captain of the guard. She keeps the north gate.',
    )
  })

  // Timeline 9's worst case was two sentences around a paragraph break. Size
  // caught it only incidentally; a correction targets one numbered sentence, so
  // more than one sentence back is refused on shape whatever its length.
  it('refuses a replacement that is more than one sentence, however short', async () => {
    const current = 'Sanne has never met Victoria. No hostility exists at baseline.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Sanne greets Victoria warmly.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{
        fragmentId: 'ch-0001',
        segment: 1,
        // Well inside any length allowance, but it rewrites the record's shape.
        newText: 'Sanne has met Victoria. She greeted her warmly.',
      }],
    }, { toolCallId: 'two', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: false, queuedOperationCount: 0 })
    expect(JSON.stringify(result)).toContain('replaces one numbered sentence with one sentence')
    expect(collector.fragmentChangeProposals).toEqual([])
  })

  it('reports the real numbering of the record when a citation is out of range', async () => {
    const current = 'Alice is captain of the guard. She keeps the north gate.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice resigned from the guard.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{ fragmentId: 'ch-0001', segment: 5, newText: 'Alice is the former captain.' }],
    }, { toolCallId: 'range', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({ ok: false, queuedOperationCount: 0, evidenceRetained: true })
    expect(JSON.stringify(result)).toContain('has 2 numbered sentences; 5 is not one of them')
    expect(collector.fragmentChangeProposals).toEqual([])
  })

  it('disambiguates a sentence that repeats verbatim in the same record', async () => {
    const current = 'The gate is shut. Alice waits. The gate is shut.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice opened the gate.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{ fragmentId: 'ch-0001', segment: 3, newText: 'The gate now stands open.' }],
    }, { toolCallId: 'dup', messages: [], abortSignal: undefined as unknown as AbortSignal })

    const operation = collector.fragmentChangeProposals[0].operations[0]
    if (operation.action !== 'replace_text') throw new Error('Expected replace_text')
    expect(operation).toMatchObject({ oldText: 'The gate is shut.', occurrence: 2 })
  })

  /**
   * A record the model never saw numbered still has segments server-side, so an
   * index against it resolves to a real sentence — just not the one the model
   * was counting to. Muse-Glimmer-30B read a record through readFragments, found
   * it unnumbered, and said so; the model that counts anyway gets a silent wrong
   * write instead of an error.
   */
  it('refuses a sentence number for a record it was never shown numbered', async () => {
    const current = 'Alice is captain of the guard. She keeps the north gate.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice resigned from the guard.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })

    const blind = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{ fragmentId: 'ch-0001', segment: 1, newText: 'Alice is the former captain of the guard.' }],
    }, { toolCallId: 'blind', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(blind).toMatchObject({ ok: false, queuedOperationCount: 0, evidenceRetained: true })
    expect(JSON.stringify(blind)).toContain('not yours to cite')
    expect(collector.fragmentChangeProposals).toEqual([])

    // Reading it is what earns the numbers, and the retry then lands.
    await tools.readFragments.execute!({ fragmentIds: ['ch-0001'] }, {
      toolCallId: 'read', messages: [], abortSignal: undefined as unknown as AbortSignal,
    })
    const afterRead = await tools.proposeRecordCorrections.execute!({
      corrections: [{ fragmentId: 'ch-0001', segment: 1, newText: 'Alice is the former captain of the guard.' }],
    }, { toolCallId: 'read-retry', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(afterRead).toMatchObject({ ok: true, queuedOperationCount: 1 })
  })

  /**
   * All-or-nothing made one bad operation cost every good one beside it:
   * Timeline 13 lost two sound tense corrections because a third replaced a
   * sentence with itself, and the model read the zero as a refusal of the lane.
   */
  it('queues the eligible corrections and reports only the rejected one', async () => {
    const current = 'Alice is captain of the guard. She keeps the north gate. The gate is oak.'
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice resigned and the gate was rebuilt in iron.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: current })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds: ['ch-0001'],
    })

    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [
        { fragmentId: 'ch-0001', segment: 1, newText: 'Alice is the former captain of the guard.' },
        // A no-op: the model using the correction channel to say "still true".
        { fragmentId: 'ch-0001', segment: 2, newText: 'She keeps the north gate.' },
        { fragmentId: 'ch-0001', segment: 3, newText: 'The gate is iron.' },
      ],
    }, { toolCallId: 'partial', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(result).toMatchObject({
      ok: true,
      queuedOperationCount: 2,
      invalid: 1,
      // Unfinished business, so the citation survives for the narrower retry.
      evidenceRetained: true,
    })
    expect(JSON.stringify(result)).toContain('does not materially differ')
    const operations = collector.fragmentChangeProposals[0].operations
    expect(operations).toHaveLength(2)
    expect(operations.map((operation) => 'oldText' in operation ? operation.oldText : null))
      .toEqual(['Alice is captain of the guard.', 'The gate is oak.'])
  })

  it('does not expose append, archive, or whole-field rewrite operations to online analysis', () => {
    const parsed = librarianRecordCorrectionsInputSchema.safeParse({
      evidenceSegments: [1],
      corrections: [{
        action: 'append_paragraph',
        fragmentId: 'ch-0001',
        text: 'Alice waited.',
      }],
    })

    expect(parsed.success).toBe(false)
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

  // reportAnalysis loads every referenced fragment to validate its ID, so the
  // records are already in hand. Handing them back removes the refusal loop
  // that used to make directions wait on a readFragments round trip.
  it('returns newly resolved records rather than demanding they be read', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice entered the forest.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: 'Alice avoids the northern road. She fears it.' })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })

    const report = await tools.reportAnalysis.execute!({
      summary: 'Alice entered the forest.',
      mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }],
    }, { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal })
    const directions = await tools.proposeDirections.execute!({
      directions: [
        { title: 'Into the forest', description: 'Alice enters the forest.', instruction: 'Continue into the forest.' },
        { title: 'Wait at dusk', description: 'Alice waits until dusk.', instruction: 'Hold the scene until dusk.' },
        { title: 'Take the river', description: 'Alice follows the river.', instruction: 'Continue along the river.' },
      ],
    }, { toolCallId: 'directions', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(report).toMatchObject({
      resolvedFragments: [{
        id: 'ch-0001',
        name: 'Alice',
        // Sentences are numbered so a later correction can address one.
        content: '[1] Alice avoids the northern road.\n[2] She fears it.',
      }],
    })
    // No read, no refusal: the first attempt records.
    expect(directions).toMatchObject({ ok: true })
    expect(collector.directions).toHaveLength(3)
  })

  it('does not re-deliver a record already presented in full', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice entered the forest.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: 'Alice avoids the northern road.' })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      numberedFragmentIds: ['ch-0001'],
    })

    const report = await tools.reportAnalysis.execute!({
      summary: 'Alice entered the forest.',
      mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }],
    }, { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(report).not.toHaveProperty('resolvedFragments')
  })

  it('tracks full presentation populated after tool construction', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice entered the forest.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, content: 'Alice avoids the northern road.' })
      return null
    })
    const numberedFragmentIds = new Set<string>()
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      numberedFragmentIds,
    })
    // compileAgentContext determines this only after the tools and blocks exist.
    numberedFragmentIds.add('ch-0001')

    const report = await tools.reportAnalysis.execute!({
      summary: 'Alice entered the forest.',
      mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }],
    }, { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(report).not.toHaveProperty('resolvedFragments')
  })
})

/**
 * The registry steers reuse through the field description and through
 * canonicalization on ingest, not through a closed enum. Enforcing the choice
 * with an enum plus a sibling newKey field cost 11 of Timeline 11's 14
 * reportAnalysis rejections, because a 12B could not reliably pick between two
 * optional fields and the penalty was the whole batched report.
 */
describe('continuity keys steered by the live registry', () => {
  // stateOperations is array(...).max().default(), so: default -> array -> element.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const elementShape = (field: any) => field.def.innerType.def.element.shape
  const keyFields = (registry: Parameters<typeof buildReportAnalysisInputSchema>[0]) => {
    const shape = buildReportAnalysisInputSchema(registry).shape as any
    return {
      state: Object.keys(elementShape(shape.stateOperations)),
      knowledge: Object.keys(elementShape(shape.knowledgeOperations)),
    }
  }
  const stateKeyDescription = (registry: Parameters<typeof buildReportAnalysisInputSchema>[0]) =>
    (elementShape((buildReportAnalysisInputSchema(registry).shape as any).stateOperations).key.description ?? '') as string
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('exposes one key field whether or not the registry has entries', () => {
    for (const registry of [{}, { state: ['captivity_status'] }]) {
      expect(keyFields(registry).state).toContain('key')
      expect(keyFields(registry).state).not.toContain('existingKey')
      expect(keyFields(registry).state).not.toContain('newKey')
    }
  })

  it('names the live keys at the point of use without making them the only legal values', () => {
    const schema = buildReportAnalysisInputSchema({ state: ['captivity_status', 'location'] })
    const stateOperation = (key: unknown) => ({
      stateOperations: [{ key, action: 'set', subject: 'Victoria', value: 'held', evidenceSegments: [1] }],
    })

    expect(stateKeyDescription({ state: ['captivity_status', 'location'] }))
      .toContain('captivity_status, location')
    expect(stateKeyDescription({})).not.toContain('Reuse one of these')

    expect(schema.safeParse(stateOperation('captivity_status')).success).toBe(true)
    // A key outside the registry is a new identity, not a rejected report.
    expect(schema.safeParse(stateOperation('captivity_state')).success).toBe(true)
    // The field the model is not using arrives as an explicit null often enough
    // that treating it as a rejection cost Timeline 11 three whole reports.
    expect(schema.safeParse(stateOperation(null)).success).toBe(true)
    expect(schema.safeParse(stateOperation('')).success).toBe(true)
  })

  it('lands a legacy spelling on the live key by canonicalizing rather than by refusing it', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'She is the queen. She says so.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return mockFragment({ id, type: 'character' })
      return null
    })
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      continuityKeys: { knowledge: ['queen_identity'] },
    })

    await tools.reportAnalysis.execute!(await buildReportAnalysisInputSchema({ knowledge: ['queen_identity'] }).parseAsync({
      summary: 'She is the queen.',
      knowledgeOperations: [{
        characterId: 'ch-0001',
        // The prefixed, hyphenated spelling the model reached for on Timeline 9.
        key: 'ch-zinozi|Queen-Identity',
        action: 'learn',
        fact: 'She is the queen.',
        acquisition: 'witnessed',
        evidenceSegments: [1],
      }],
    }), { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.continuityProjection.knowledgeOperations[0].knowledgeKey).toBe('queen_identity')
  })

  // Timeline 11 admitted a literal `_` as a thread key because the 12B put the
  // real key in `label`, and a later run omitted `key` outright for eight calls
  // running. Both carry the identity in the sibling field, so it is recovered
  // from there rather than costing the operation.
  it('derives the key from the operation description when the key carries no identity', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'He claims her line. She accepts.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })

    await tools.reportAnalysis.execute!(await reportAnalysisInputSchema.parseAsync({
      summary: 'He claims her line.',
      threadOperations: [{
        key: '_',
        action: 'open',
        label: 'mpamba_dynastic_intent',
        relatedFragmentIds: [],
        evidenceSegments: [1],
      }],
      stateOperations: [{
        action: 'set',
        subject: 'Eastern dike',
        value: 'holding',
        evidenceSegments: [1],
      }],
    }), { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.continuityProjection.threadOperations[0].threadKey).toBe('mpamba_dynastic_intent')
    expect(collector.continuityProjection.stateOperations[0].stateKey).toBe('eastern_dike')
  })

  it('reuses a unique live identity by its human label and aligns keyless focus by position', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'The clinical board remained active. Dutch coordination advanced. Alice corrected what she knew.',
    })
    const character = mockFragment({ id: 'ch-0001', type: 'character' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return character
      return null
    })
    const continuityKeys = {
      state: [{ key: 'medicine_track_activation_status', label: 'Medicine track clinical board' }],
      thread: [{ key: 'dutch_coordination_framework_negotiation', label: 'Dutch coordination framework negotiation' }],
      knowledge: [
        { key: 'alice_corrected_fact', label: 'The board remained active.', scope: 'ch-0001' },
        { key: 'someone_else_corrected_fact', label: 'The board remained active.', scope: 'ch-0002' },
      ],
    }
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', continuityKeys,
    })

    const result = await tools.reportAnalysis.execute!(
      await buildReportAnalysisInputSchema(continuityKeys).parseAsync({
        summary: 'The board stayed active and coordination advanced.',
        stateOperations: [{
          action: 'set', subject: 'Medicine track clinical board', value: 'active', evidenceSegments: [1],
        }],
        threadOperations: [{
          action: 'advance', label: 'Dutch coordination framework negotiation', relatedFragmentIds: [], evidenceSegments: [2],
        }],
        threadFocus: [{ visibility: 'foreground' }],
        knowledgeOperations: [{
          characterId: 'ch-0001', action: 'correct', fact: 'The board remained active.', evidenceSegments: [3],
        }],
      }),
      { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )

    expect(result).not.toHaveProperty('skippedContinuity')
    expect(collector.continuityProjection.stateOperations[0].stateKey)
      .toBe('medicine_track_activation_status')
    expect(collector.continuityProjection.threadOperations[0].threadKey)
      .toBe('dutch_coordination_framework_negotiation')
    expect(collector.continuityProjection.threadFocus[0]).toEqual({
      threadKey: 'dutch_coordination_framework_negotiation',
      visibility: 'foreground',
    })
    expect(collector.continuityProjection.knowledgeOperations[0].knowledgeKey)
      .toBe('alice_corrected_fact')
  })

  it('bounds a derived identity while keeping a stable hash suffix', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice learned the whole arrangement.' })
    const character = mockFragment({ id: 'ch-0001', type: 'character' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return character
      return null
    })
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    const fact = 'The complete multilateral diplomatic coordination arrangement remained active across every delegation'

    await tools.reportAnalysis.execute!(await reportAnalysisInputSchema.parseAsync({
      summary: 'Alice learned the arrangement.',
      knowledgeOperations: [{
        characterId: 'ch-0001', action: 'learn', fact, evidenceSegments: [1],
      }],
    }), { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal })

    const key = collector.continuityProjection.knowledgeOperations[0].knowledgeKey
    expect(key.length).toBeLessThanOrEqual(64)
    expect(key).toMatch(/^the_complete_multilateral_diplomatic_coordination_[a-f0-9]{8}$/)
  })

  it('does not invent a fresh identity for an operation that must target existing memory', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'The dike question ended. She forgot the answer.' })
    const character = mockFragment({ id: 'ch-0001', type: 'character' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return character
      return null
    })
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })

    const result = await tools.reportAnalysis.execute!(await reportAnalysisInputSchema.parseAsync({
      summary: 'The old question had ended.',
      stateOperations: [{ action: 'clear', subject: 'Eastern dike status', evidenceSegments: [1] }],
      threadOperations: [{
        action: 'resolve', label: 'Who damaged the dike?', relatedFragmentIds: [], evidenceSegments: [1],
      }],
      knowledgeOperations: [{
        characterId: 'ch-0001', action: 'forget', fact: 'Who damaged the dike.', evidenceSegments: [2],
      }],
      threadFocus: [{ threadKey: '', visibility: 'foreground' }],
    }), { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.continuityProjection.stateOperations).toEqual([])
    expect(collector.continuityProjection.threadOperations).toEqual([])
    expect(collector.continuityProjection.knowledgeOperations).toEqual([])
    expect(collector.continuityProjection.threadFocus).toEqual([])
    expect((result as { skippedContinuity: Array<{ reason: string }> }).skippedContinuity.map((item) => item.reason))
      .toEqual([
        'A state clear operation must name the existing key; no unambiguous retry or live-registry match was found.',
        'A thread resolve operation must name the existing key; no unambiguous retry or live-registry match was found.',
        'A knowledge forget operation must name the existing key; no unambiguous retry or live-registry match was found.',
        'A thread focus entry must name its thread key or align with a successfully recorded thread operation.',
      ])
  })

  it('still skips an operation that carries no identity anywhere', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'He claims her line. She accepts.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })

    const result = await tools.reportAnalysis.execute!(await reportAnalysisInputSchema.parseAsync({
      summary: 'He claims her line.',
      threadOperations: [{
        key: '_',
        action: 'advance',
        relatedFragmentIds: [],
        evidenceSegments: [1],
      }],
    }), { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal })

    expect(collector.continuityProjection.threadOperations).toEqual([])
    expect((result as { skippedContinuity: Array<{ reason: string }> }).skippedContinuity[0].reason)
      .toContain('must name the existing key')
  })

  // A retry is normally a partial re-report, so assignment made it a truncation:
  // one Qwen passage reported two valid thread operations and then seven empty
  // sets, and only the empty set survived.
  it('keeps operations an earlier call reported when a retry does not restate them', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'He claims her line. She accepts.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    const call = async (input: Record<string, unknown>) => tools.reportAnalysis.execute!(
      await reportAnalysisInputSchema.parseAsync(input),
      { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )

    await call({
      summary: 'He claims her line.',
      stateOperations: [
        { key: 'eastern_dike_status', action: 'set', subject: 'Eastern dike', value: 'holding', evidenceSegments: [1] },
        { key: 'succession_claim', action: 'set', subject: 'Succession', value: 'contested', evidenceSegments: [1] },
      ],
    })
    await call({
      summary: 'He claims her line.',
      stateOperations: [
        { key: 'eastern_dike_status', action: 'set', subject: 'Eastern dike', value: 'breached', evidenceSegments: [2] },
      ],
    })

    const byKey = new Map(collector.continuityProjection.stateOperations.map((operation) => [operation.stateKey, operation]))
    expect(byKey.get('eastern_dike_status')?.value).toBe('breached')
    expect(byKey.get('succession_claim')?.value).toBe('contested')
  })

  it('does not let an empty retry erase the whole continuity projection', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'He claims her line. She accepts.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    const call = async (input: Record<string, unknown>) => tools.reportAnalysis.execute!(
      await reportAnalysisInputSchema.parseAsync(input),
      { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )

    await call({
      summary: 'He claims her line.',
      threadOperations: [{
        key: 'mpamba_dynastic_intent', action: 'open', relatedFragmentIds: [], evidenceSegments: [1],
      }],
    })
    await call({ summary: 'He claims her line.' })

    expect(collector.continuityProjection.threadOperations).toHaveLength(1)
    expect(collector.continuityProjection.threadOperations[0].threadKey).toBe('mpamba_dynastic_intent')
  })

  // Qwen first omitted every state key, then supplied deliberate keys while
  // keeping the same citations. The correction must rename those identities,
  // not leave the derived drafts beside them as duplicate state.
  it('lets explicit retry keys supersede earlier derived identities', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'The dike held. The hall accepted the proof.' })
    const character = mockFragment({ id: 'ch-0001', type: 'character' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return character
      return null
    })
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    const call = async (input: Record<string, unknown>) => tools.reportAnalysis.execute!(
      await reportAnalysisInputSchema.parseAsync(input),
      { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )

    await call({
      summary: 'The dike held.',
      stateOperations: [
        { action: 'set', subject: 'Eastern Works seaward dike', value: 'holding', evidenceSegments: [1] },
        { action: 'set', subject: "Principia's diplomatic posture", value: 'engaging', evidenceSegments: [2] },
      ],
      knowledgeOperations: [{
        characterId: 'ch-0001', action: 'learn', fact: 'The hall accepted the proof.', evidenceSegments: [2],
      }],
    })
    await call({
      summary: 'The dike held.',
      stateOperations: [
        { key: 'eastern_channel_closure', action: 'set', subject: 'eastern channel', value: 'holding', evidenceSegments: [1] },
        { key: 'principia_diplomatic_stance', action: 'set', subject: 'Principia', value: 'engaging', evidenceSegments: [2] },
      ],
      knowledgeOperations: [{
        characterId: 'ch-0001', key: 'hall_acceptance', action: 'learn', fact: 'The hall accepted the proof.', evidenceSegments: [2],
      }],
    })

    expect(collector.continuityProjection.stateOperations.map((operation) => operation.stateKey)).toEqual([
      'eastern_channel_closure',
      'principia_diplomatic_stance',
    ])
    expect(collector.continuityProjection.knowledgeOperations.map((operation) => operation.knowledgeKey))
      .toEqual(['hall_acceptance'])
  })

  // The eight-call Qwen loop retained the right keys only on its first call;
  // later calls repeated the same cited operations with the key and sometimes
  // the note missing. The citation lets the retry inherit the established key.
  it('inherits a prior thread key when a retry drops its descriptive fields', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'The dike held. The room accepted the proof.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    const call = async (threadOperations: Array<Record<string, unknown>>) => tools.reportAnalysis.execute!(
      await reportAnalysisInputSchema.parseAsync({ summary: 'The room accepted the proof.', threadOperations }),
      { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )

    await call([
      { key: 'eastern_works_aftermath', action: 'advance', note: 'Political fallout remains.', relatedFragmentIds: [], evidenceSegments: [1] },
      { key: 'why_doesnt_she_intervene', action: 'advance', note: 'Capacity was demonstrated.', relatedFragmentIds: [], evidenceSegments: [2] },
    ])
    await call([
      { action: 'advance', relatedFragmentIds: [], evidenceSegments: [1] },
      { action: 'advance', relatedFragmentIds: [], evidenceSegments: [2] },
    ])
    await call([
      { action: 'advance', note: 'The dike shifted attention to political fallout.', relatedFragmentIds: [], evidenceSegments: [1] },
      { action: 'advance', note: 'The demonstration shifted the room.', relatedFragmentIds: [], evidenceSegments: [2] },
    ])

    expect(collector.continuityProjection.threadOperations.map((operation) => operation.threadKey)).toEqual([
      'eastern_works_aftermath',
      'why_doesnt_she_intervene',
    ])
  })

  it('preserves the Qwen retry shape while deriving only newly created identities', async () => {
    const collector = createEmptyCollector()
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: Array.from({ length: 43 }, (_, index) => `Passage sentence ${index + 1}.`).join(' '),
    })
    const character = mockFragment({ id: 'ch-0001', type: 'character' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return character
      return null
    })
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    const call = async (input: Record<string, unknown>) => tools.reportAnalysis.execute!(
      await reportAnalysisInputSchema.parseAsync({ summary: 'The examination continued.', ...input }),
      { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )
    const keylessCreations = {
      stateOperations: [
        { action: 'set', subject: 'Eastern Works seaward dike', value: 'closed', evidenceSegments: [4] },
        { action: 'set', subject: "Clinical director's examination", value: 'complete', evidenceSegments: [29, 30, 31, 32, 33, 34] },
      ],
      knowledgeOperations: [{
        characterId: 'ch-0001',
        action: 'learn',
        fact: "The director's pulse remained steady and professional.",
        acquisition: 'witnessed',
        evidenceSegments: [21, 22, 23],
      }],
    }

    await call({
      ...keylessCreations,
      threadOperations: [
        { key: 'eastern_works_aftermath', action: 'advance', relatedFragmentIds: [], evidenceSegments: [4, 43] },
        { key: 'why_doesnt_she_intervene', action: 'advance', relatedFragmentIds: [], evidenceSegments: [1, 38] },
      ],
    })
    await call({
      ...keylessCreations,
      threadOperations: [
        { action: 'advance', relatedFragmentIds: [], evidenceSegments: [4, 43] },
        { action: 'advance', relatedFragmentIds: [], evidenceSegments: [1, 38] },
      ],
    })

    expect(collector.continuityProjection.stateOperations.map((operation) => operation.stateKey)).toEqual([
      'eastern_works_seaward_dike',
      'clinical_director_s_examination',
    ])
    expect(collector.continuityProjection.threadOperations.map((operation) => operation.threadKey)).toEqual([
      'eastern_works_aftermath',
      'why_doesnt_she_intervene',
    ])
    expect(collector.continuityProjection.knowledgeOperations.map((operation) => operation.knowledgeKey)).toEqual([
      'the_director_s_pulse_remained_steady_and_professional',
    ])
  })

  it('keeps newly reported threads when the merged projection reaches its cap', async () => {
    const collector = createEmptyCollector()
    const sentences = Array.from({ length: 13 }, (_, index) => `Event ${index + 1}.`).join(' ')
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: sentences })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    const execute = async (threadOperations: Array<Record<string, unknown>>) => tools.reportAnalysis.execute!(
      await reportAnalysisInputSchema.parseAsync({ summary: 'Events accumulated.', threadOperations }),
      { toolCallId: 'report', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )

    await execute(Array.from({ length: 12 }, (_, index) => ({
      key: `old_thread_${index + 1}`, action: 'open', relatedFragmentIds: [], evidenceSegments: [index + 1],
    })))
    await execute([{
      key: 'new_thread', action: 'open', relatedFragmentIds: [], evidenceSegments: [13],
    }])

    const keys = collector.continuityProjection.threadOperations.map((operation) => operation.threadKey)
    expect(keys).toHaveLength(12)
    expect(keys).toContain('new_thread')
    expect(keys).not.toContain('old_thread_1')
  })
})
