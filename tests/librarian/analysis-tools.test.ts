import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  anchorMentionText,
  buildReportAnalysisInputSchema,
  createAnalysisTools,
  createEmptyCollector,
  createLibrarianOnlineTools,
  librarianNewRecordsInputSchema,
  librarianRecordCorrectionsInputSchema,
  listLibrarianAnalyzeToolNames,
  mentionInputSchema,
  reportAnalysisInputSchema,
  reportContinuityInputSchema,
  reportDirectionsInputSchema,
  reportObservationInputSchema,
  timelineEventsFor,
} from '@/server/librarian/analysis-tools'
import { z } from 'zod/v4'
import { getFragment } from '@/server/fragments/storage'
import type { Fragment } from '@/contracts/story'

vi.mock('@/server/fragments/storage', () => ({
  getFragment: vi.fn().mockResolvedValue(null),
  getStory: vi.fn().mockResolvedValue({ settings: { customFragmentTypes: [] } }),
  listFragments: vi.fn().mockResolvedValue([]),
  createFragment: vi.fn(),
  updateFragment: vi.fn(),
  updateFragmentVersioned: vi.fn().mockResolvedValue(null),
}))

const executionContext = {
  toolCallId: 'test',
  messages: [],
  abortSignal: undefined as unknown as AbortSignal,
}

function mockFragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: 'ch-0001', type: 'character', name: 'Alice', description: 'A warrior.',
    content: 'Alice is captain of the guard. She keeps the north gate.',
    tags: [], refs: [], sticky: false, placement: 'user', createdAt: '', updatedAt: '',
    order: 0, meta: {}, archived: false, version: 1, versions: [], ...overrides,
  }
}

describe('analysis tool contracts', () => {
  beforeEach(() => vi.mocked(getFragment).mockResolvedValue(null))

  it('creates an empty collector', () => {
    expect(createEmptyCollector()).toEqual({
      summaryUpdate: '', events: [], mentions: [], candidateFragmentIds: [], contradictions: [],
      fragmentChangeProposals: [], directions: [],
      continuityProjection: {
        version: 2, scene: { transition: 'uncertain' }, stateOperations: [],
        threadOperations: [], threadFocus: [], knowledgeOperations: [],
      },
    })
  })

  it('requires one self-contained report instead of synthesizing missing content', () => {
    expect(reportAnalysisInputSchema.safeParse({}).success).toBe(false)
    expect(reportAnalysisInputSchema.safeParse({ summary: '   ' }).success).toBe(false)
    const parsed = reportAnalysisInputSchema.parse({
      summary: 'Alice waited.', participantIds: ['ch-0001'], witnessIds: ['ch-0002'],
      directions: [
        { title: 'Wait', description: 'The pause lengthens.', instruction: 'Continue the pause.' },
        { title: 'Enter', description: 'A visitor arrives.', instruction: 'Introduce the visitor.' },
        { title: 'Leave', description: 'Alice departs.', instruction: 'Follow Alice outside.' },
      ],
    })
    expect(parsed).not.toHaveProperty('participantIds')
    expect(parsed).not.toHaveProperty('witnessIds')
  })

  it('accepts a useful report with fewer than three directions without retrying the analysis', () => {
    const directions = [
      { title: 'Wait', description: 'The pause lengthens.', instruction: 'Continue the pause.' },
      { title: 'Enter', description: 'A visitor arrives.', instruction: 'Introduce the visitor.' },
    ]
    expect(reportAnalysisInputSchema.safeParse({ summary: 'Alice waited.', directions }).success).toBe(true)
    expect(reportAnalysisInputSchema.safeParse({ summary: 'Alice waited.', directions: directions.slice(0, 1) }).success).toBe(true)
    expect(reportAnalysisInputSchema.safeParse({ summary: 'Alice waited.', directions: [] }).success).toBe(false)
    expect(buildReportAnalysisInputSchema({}, { includeDirections: false }).safeParse({ summary: 'Alice waited.' }).success).toBe(true)
  })

  it('requires proposal evidence and work in every proposal call', () => {
    expect(librarianRecordCorrectionsInputSchema.safeParse({
      evidenceSegments: [], corrections: [],
    }).success).toBe(false)
    expect(librarianNewRecordsInputSchema.safeParse({
      evidenceSegments: [1], newFragments: [],
    }).success).toBe(false)
  })

  it('exposes one shared online tool set without duplicate prose and summary reads', () => {
    const tools = createLibrarianOnlineTools(createEmptyCollector(), {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    expect(Object.keys(tools)).toEqual(expect.arrayContaining([
      'reportAnalysis', 'readFragments', 'listFragmentTypes', 'proposeRecordCorrections',
      'proposeNewRecords',
    ]))
    expect(tools).not.toHaveProperty('readProseChain')
    expect(tools).not.toHaveProperty('readStorySummary')
    expect(listLibrarianAnalyzeToolNames()).toEqual(Object.keys(tools))
  })

  it('omits optional proposal and direction tools when disabled', () => {
    const tools = createAnalysisTools(createEmptyCollector(), {
      dataDir: '/tmp', storyId: 'story-test', disableSuggestions: true, disableDirections: true,
    })
    expect(tools).toHaveProperty('reportAnalysis')
    expect(tools).not.toHaveProperty('proposeRecordCorrections')
    expect(tools).not.toHaveProperty('proposeNewRecords')
    expect(tools).not.toHaveProperty('proposeDirections')
  })

  it('collects directions in the self-contained report', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)
    await tools.reportAnalysis.execute!({
      summary: 'Alice waited.',
      directions: [
        { title: 'Wait', description: 'The pause lengthens.', instruction: 'Continue the pause.' },
        { title: 'Enter', description: 'A visitor arrives.', instruction: 'Introduce the visitor.' },
        { title: 'Leave', description: 'Alice departs.', instruction: 'Follow Alice outside.' },
      ],
    }, executionContext)
    expect(collector.directions).toHaveLength(3)
  })
})

describe('reportAnalysis', () => {
  beforeEach(() => vi.mocked(getFragment).mockResolvedValue(null))

  it('stores the model report directly and replaces it on a later report', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)
    await tools.reportAnalysis.execute!({
      summary: 'First summary.', events: ['First event.', 'Second event.'],
      contradictions: [{ description: 'A conflict.', fragmentIds: [] }],
    }, executionContext)
    await tools.reportAnalysis.execute!({ summary: 'Replacement summary.', events: ['Replacement event.'] }, executionContext)
    expect(collector.summaryUpdate).toBe('Replacement summary.')
    expect(collector.events).toEqual(['Replacement event.'])
    expect(collector.contradictions).toEqual([])
  })

  it('publishes normalized progress as soon as semantic tools succeed', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice entered the north hall.' })
    const record = mockFragment({ id: 'ch-0001' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => (
      id === prose.id ? prose : id === record.id ? record : null
    ))
    const onProgress = vi.fn()
    const tools = createAnalysisTools(createEmptyCollector(), {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id, onProgress,
    })

    await tools.reportAnalysis.execute!({
      summary: 'Alice entered the hall.',
      events: ['Alice entered the north hall.'],
      mentions: [
        { fragmentId: record.id, text: 'Alice' },
        { fragmentId: record.id, text: 'Alice Cooper' },
      ],
      candidateFragmentIds: [record.id],
      directions: [
        { title: 'Wait', description: 'The hall settles.', instruction: 'Let the hall settle.' },
        { title: 'Search', description: 'Alice looks around.', instruction: 'Search the hall.' },
        { title: 'Leave', description: 'Alice moves on.', instruction: 'Leave the hall.' },
      ],
    }, executionContext)

    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      fragmentId: prose.id,
      stage: 'inspection',
      summaryUpdate: 'Alice entered the hall.',
      mentions: [{ fragmentId: record.id, text: 'Alice' }],
      timelineEvents: [{ event: 'Alice entered the north hall.', position: 'after' }],
      directions: expect.arrayContaining([expect.objectContaining({ title: 'Wait' })]),
    }))
  })

  it('does not silently clip verbose report content', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)
    const summary = 'S'.repeat(5000)
    const events = Array.from({ length: 20 }, (_, index) => `Event ${index} ${'x'.repeat(300)}`)
    await tools.reportAnalysis.execute!({ summary, events }, executionContext)
    expect(collector.summaryUpdate).toBe(summary)
    expect(collector.events).toEqual(events)
  })

  it('keeps exact mentions and reports non-verbatim ones without rewriting them', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice studied the Silver ash by the gate.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001' || id === 'kn-0001') return mockFragment({ id })
      return null
    })
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })
    const result = await tools.reportAnalysis.execute!({
      summary: 'Alice studies the ash.',
      mentions: [
        { fragmentId: 'ch-0001', text: 'Alice' },
        { fragmentId: 'kn-0001', text: '"Silver ash"' },
      ],
      candidateFragmentIds: ['ch-0001', 'ch-0001'],
    }, executionContext)
    expect(collector.mentions).toEqual([{ fragmentId: 'ch-0001', text: 'Alice' }])
    expect(collector.candidateFragmentIds).toEqual(['ch-0001'])
    expect(result).toMatchObject({ mentionCount: 1, candidateFragmentCount: 1 })
    expect(result.skippedMentions).toEqual([{
      fragmentId: 'kn-0001', text: '"Silver ash"',
      reason: 'Not verbatim in the passage, so it cannot be highlighted.',
    }])
  })

  it('grounds continuity evidence and skips invalid operations without rejecting the report', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice entered the north hall. She rested.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })
    const result = await tools.reportAnalysis.execute!({
      summary: 'Alice entered and rested.',
      stateOperations: [
        { action: 'set', subject: { label: 'Alice' }, facet: 'location', value: 'north hall', evidenceSegments: [1] },
        { action: 'set', subject: { label: 'Alice' }, facet: 'mood', value: 'calm', evidenceSegments: [9] },
      ],
    }, executionContext)
    expect(result).toMatchObject({ ok: true, stateOperationCount: 1 })
    expect(result.skippedContinuity).toHaveLength(1)
    expect(collector.continuityProjection.stateOperations[0]).toMatchObject({
      stateKey: 'alice_location', value: 'north hall', evidenceSegments: [1],
      evidenceText: 'Alice entered the north hall.',
    })
  })

  it('can open and advance one continuity identity in the same report', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'A question opened. New evidence appeared.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === 'pr-0001' ? prose : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })
    await tools.reportAnalysis.execute!({
      summary: 'A question opened and advanced.',
      threadOperations: [
        { key: 'who_closed_the_dike', action: 'open', label: 'Who closed the dike?', evidenceSegments: [1] },
        { key: 'who_closed_the_dike', action: 'advance', note: 'New evidence.', evidenceSegments: [2] },
      ],
    }, executionContext)
    expect(collector.continuityProjection.threadOperations.map(({ action }) => action)).toEqual(['open', 'advance'])
  })

  it('grounds contradictions on both the prose and a reusable record', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice has green eyes.' })
    const record = mockFragment({ id: 'ch-0001', content: 'Alice has blue eyes.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === prose.id ? prose : id === record.id ? record : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id })
    const result = await tools.reportAnalysis.execute!({
      summary: 'Alice has green eyes.',
      contradictions: [{
        description: 'Her eye colour conflicts.', sourceSegments: [1],
        conflictingEvidence: [{ fragmentId: record.id, segments: [1] }],
      }],
    }, executionContext)
    expect(result).toMatchObject({ ok: true, contradictionCount: 1 })
    expect(collector.contradictions[0]).toMatchObject({
      sourceEvidenceText: 'Alice has green eyes.',
      conflictingEvidence: [{ evidenceText: 'Alice has blue eyes.' }],
    })
  })

  it('uses exact mention text and places events from the scene line', () => {
    expect(anchorMentionText('Silver ash', 'alice found silver ash.')).toBe('Silver ash')
    expect(anchorMentionText('"Silver ash"', 'alice found silver ash.')).toBeNull()
    expect(timelineEventsFor(['Alice remembers.'], { transition: 'continue', line: 'flashback' }))
      .toEqual([{ event: 'Alice remembers.', position: 'before' }])
    expect(mentionInputSchema.safeParse({ fragmentId: 'bad-id', text: 'Alice' }).success).toBe(false)
  })
})

describe('record proposals', () => {
  const prose = mockFragment({
    id: 'pr-0001', type: 'prose',
    content: 'Alice resigned from the guard. The Lantern Archive opened.',
  })
  const record = mockFragment({
    id: 'ch-0001',
    content: 'Alice is captain of the guard. She keeps the north gate. She keeps the north gate.',
  })

  beforeEach(() => {
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === prose.id ? prose : id === record.id ? record : null)
  })

  function proposalTools(numberedFragmentIds: string[] = ['ch-0001']) {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id,
      disableDirections: true, numberedFragmentIds,
    })
    return { collector, tools }
  }

  it('resolves a numbered sentence into an exact oldText/newText operation', async () => {
    const { collector, tools } = proposalTools()
    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{ fragmentId: record.id, segment: 1, newText: 'Alice is the former captain of the guard.' }],
    }, executionContext)
    expect(result).toMatchObject({ ok: true, queuedOperationCount: 1 })
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      action: 'replace_text', fragmentId: record.id, oldText: 'Alice is captain of the guard.',
      newText: 'Alice is the former captain of the guard.', replaceAll: false,
    })
  })

  it('adds an occurrence only when the anchored sentence repeats', async () => {
    const { collector, tools } = proposalTools()
    await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{ fragmentId: record.id, segment: 3, newText: 'She leaves the north gate.' }],
    }, executionContext)
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({ occurrence: 2 })
  })

  it('keeps replacement text exactly as authored', async () => {
    const { collector, tools } = proposalTools()
    await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [{ fragmentId: record.id, segment: 1, newText: '[1] Alice resigned. She now advises the guard.' }],
    }, executionContext)
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      newText: '[1] Alice resigned. She now advises the guard.',
    })
  })

  it('rejects an invalid batch atomically', async () => {
    const { collector, tools } = proposalTools()
    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1],
      corrections: [
        { fragmentId: record.id, segment: 1, newText: 'Alice resigned.' },
        { fragmentId: record.id, segment: 99, newText: 'Missing sentence.' },
      ],
    }, executionContext)
    expect(result).toMatchObject({ ok: false, queuedOperationCount: 0, invalid: 1 })
    expect(collector.fragmentChangeProposals).toEqual([])
  })

  it('requires the target record to have been shown with numbered sentences', async () => {
    const { tools } = proposalTools([])
    const result = await tools.proposeRecordCorrections.execute!({
      evidenceSegments: [1], corrections: [{ fragmentId: record.id, segment: 1, newText: 'Alice resigned.' }],
    }, executionContext)
    expect(result).toMatchObject({ ok: false, queuedOperationCount: 0 })
    expect(JSON.stringify(result)).toContain('has not been shown with numbered sentences')
  })

  it('requires valid new-prose evidence', async () => {
    const { collector, tools } = proposalTools()
    const result = await tools.proposeNewRecords.execute!({
      evidenceSegments: [99],
      newFragments: [{ type: 'knowledge', name: 'Lantern Archive', description: 'An archive.', content: 'The archive opened.' }],
    }, executionContext)
    expect(result).toMatchObject({ ok: false, evidenceMatched: false, queuedOperationCount: 0 })
    expect(collector.fragmentChangeProposals).toEqual([])
  })

  it('does not deduplicate separate self-contained proposal calls', async () => {
    const { collector, tools } = proposalTools()
    const input = {
      title: 'A new institution', evidenceSegments: [2],
      newFragments: [{ type: 'knowledge', name: 'Lantern Archive', description: 'An archive.', content: 'The archive opened.' }],
    }
    await tools.proposeNewRecords.execute!(input, executionContext)
    await tools.proposeNewRecords.execute!(input, executionContext)
    expect(collector.fragmentChangeProposals).toHaveLength(2)
  })

  it('returns resolved candidate records once and numbers their contents', async () => {
    const { tools } = proposalTools([])
    const first = await tools.reportAnalysis.execute!({ summary: 'Alice resigned.', candidateFragmentIds: [record.id] }, executionContext)
    const second = await tools.reportAnalysis.execute!({ summary: 'Alice resigned.', candidateFragmentIds: [record.id] }, executionContext)
    expect(first.resolvedFragments[0].content).toContain('[1] Alice is captain')
    expect(first).toMatchObject({ inspectionRequired: true })
    expect(second).not.toHaveProperty('resolvedFragments')
  })

  it('still inspects a specifically requested record when suggestions are disabled', async () => {
    const tools = createAnalysisTools(createEmptyCollector(), {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id,
      disableSuggestions: true, disableDirections: true, numberedFragmentIds: [],
    })
    const result = await tools.reportAnalysis.execute!({
      summary: 'Alice resigned.', candidateFragmentIds: [record.id],
    }, executionContext)
    expect(result).toMatchObject({ inspectionRequired: true })
  })
})

describe('continuity registry addressing', () => {
  const registry = {
    state: [{ index: 1, key: 'captivity_status', label: 'Captivity status' }],
    thread: [{ index: 1, key: 'who_closed_the_dike', label: 'Who closed the dike?' }],
    knowledge: [{ index: 1, key: 'queen_identity', label: 'Queen identity', scope: 'ch-0001' }],
  }

  it('keeps continuity keys open rather than using a closed enum', () => {
    const schema = buildReportAnalysisInputSchema(registry)
    expect(schema.safeParse({
      summary: 'A new state emerged.',
      directions: [
        { title: 'Wait', description: 'The moment holds.', instruction: 'Remain in the moment.' },
        { title: 'Act', description: 'The state drives action.', instruction: 'Act on the new state.' },
        { title: 'Leave', description: 'The scene closes.', instruction: 'End the scene.' },
      ],
      stateOperations: [{
        key: 'new_state', action: 'set', subject: { label: 'Alice' }, facet: 'condition',
        value: 'free', evidenceSegments: [1],
      }],
    }).success).toBe(true)
  })

  it('skips a non-create action against an unknown identity while keeping the report', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'The question ended.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === prose.id ? prose : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id, continuityKeys: registry,
    })
    const result = await tools.reportAnalysis.execute!({
      summary: 'The question ended.',
      threadOperations: [{ key: 'unknown_question', action: 'resolve', evidenceSegments: [1] }],
    }, executionContext)
    expect(result).toMatchObject({ ok: true, threadOperationCount: 0 })
    expect(JSON.stringify(result)).toContain('No thread identity is tracked under unknown_question')
  })

  it('resolves a live identity by registry entry', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'The question ended.' })
    vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => id === prose.id ? prose : null)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id, continuityKeys: registry,
    })
    await tools.reportAnalysis.execute!({
      summary: 'The question ended.', threadOperations: [{ entry: 1, action: 'resolve', evidenceSegments: [1] }],
    }, executionContext)
    expect(collector.continuityProjection.threadOperations[0]).toMatchObject({
      threadKey: 'who_closed_the_dike', action: 'resolve',
    })
  })
})

describe('reportAnalysis resilience and forgiving boundaries', () => {
  it('forgives non-ISO time bounds and preserves descriptive label', () => {
    const schema = buildReportAnalysisInputSchema({}, { includeDirections: false })
    const parsed = schema.parse({
      summary: 'Night fell over the harbor.',
      scene: {
        transition: 'continue',
        time: {
          label: '03:14 at night',
          earliest: '03:14',
          latest: 'unknown',
        },
      },
    })
    expect(parsed.scene?.time?.label).toBe('03:14 at night')
    expect((parsed.scene?.time as Record<string, unknown> | undefined)?.earliest).toBeUndefined()
    expect((parsed.scene?.time as Record<string, unknown> | undefined)?.latest).toBeUndefined()
  })

  it('parses streamlined report schema with characters, entities, and threads', () => {
    const schema = buildReportAnalysisInputSchema({}, { includeDirections: false })
    const parsed = schema.parse({
      summary: 'Alice advanced her position.',
      threads: ['Who unlocked the gate?'],
       characters: [
         {
           name: 'Alice',
           immediate: 'Alert and scanning the perimeter',
           state: [{ key: 'posture', value: 'ready' }],
         },
       ],
     })
     expect(parsed.threads).toEqual(['Who unlocked the gate?'])
     expect(parsed.characters[0].name).toBe('Alice')
     expect(parsed.characters[0].immediate).toBe('Alert and scanning the perimeter')
     expect(parsed.characters[0].state).toEqual([{ key: 'posture', value: 'ready' }])
  })

  it('skips unknown fragment mentions and non-character knowledge operations without throwing', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice walked to the harbor.' })
    const character = mockFragment({ id: 'ch-0001', type: 'character', name: 'Alice', content: 'Alice is a guard.' })
    const location = mockFragment({ id: 'loc-0001', type: 'location', name: 'Harbor', content: 'A windy dock.' })

    vi.mocked(getFragment).mockImplementation(async (_dir, _story, id) => {
      if (id === prose.id) return prose
      if (id === character.id) return character
      if (id === location.id) return location
      return null
    })

    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: prose.id,
      continuityKeys: {},
    })

    const result = await tools.reportAnalysis.execute!({
      summary: 'Alice arrived at the harbor.',
      mentions: [
        { fragmentId: 'ch-0001', text: 'Alice' },
        { fragmentId: 'ch-9999', text: 'Ghost' },
      ],
      stateOperations: [
        {
          action: 'set',
          subject: { label: 'Alice', fragmentId: 'ch-9999' },
          facet: 'posture',
          value: 'alert',
          evidenceSegments: [1],
        },
      ],
      threadOperations: [
        {
          action: 'open',
          label: 'What lies in the mist?',
          relatedFragmentIds: ['ch-0001', 'ch-9999'],
          evidenceSegments: [1],
        },
      ],
      knowledgeOperations: [
        {
          characterId: 'ch-9999',
          action: 'learn',
          fact: 'The gate is unlocked.',
          evidenceSegments: [1],
        },
        {
          characterId: 'loc-0001',
          action: 'learn',
          fact: 'The harbor is quiet.',
          evidenceSegments: [1],
        },
      ],
    }, executionContext)

    expect(result.ok).toBe(true)
    expect(result.mentionCount).toBe(1)
    expect(result.skippedMentions).toHaveLength(1)
    expect(result.skippedMentions[0].fragmentId).toBe('ch-9999')

    expect(collector.continuityProjection.stateOperations).toHaveLength(1)
    const firstOp = collector.continuityProjection.stateOperations[0]
    expect(firstOp.action).toBe('set')
    if (firstOp.action === 'set') {
      expect(firstOp.subject.fragmentId).toBeUndefined()
      expect(firstOp.subject.label).toBe('Alice')
    }

    expect(collector.continuityProjection.threadOperations).toHaveLength(1)
    expect(collector.continuityProjection.threadOperations[0].relatedFragmentIds).toEqual(['ch-0001'])

    expect(result.skippedContinuity).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'knowledge', key: 'ch-9999' }),
      expect.objectContaining({ kind: 'knowledge', key: 'loc-0001' }),
    ]))
  })

  it('normalizes character and entity live states and falls back to summary for timeline events', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)
    const executionContext = { messages: [] }

    const result = await tools.reportAnalysis.execute({
      summary: 'Alice examined the old tower gates while the wind howled outside.',
      characters: [
        {
          name: 'Alice',
          characterId: 'ch-0001',
          immediate: 'Catching breath; dust clinging to boots',
           state: [
             { key: 'attire', value: 'tattered travel cloak' },
             { key: 'injury', value: 'none' },
             { key: 'gear', value: 'holding brass lantern' },
           ],
          knowledge: ['The tower gate was unlatched from within'],
          secrets: ['Carrying the brass key'],
        },
      ],
      entities: [
        {
          name: 'Old Tower',
          category: 'location',
          immediate: 'Cold draft whistling through the iron bars',
           state: [
             { key: 'gate', value: 'unlatched' },
           ],
          notes: ['Pre-war construction'],
        },
      ],
    }, executionContext)

    expect(result.ok).toBe(true)
    expect(collector.summaryUpdate).toContain('old tower gates')
    expect(collector.continuityProjection.characterStates).toBeDefined()
    expect(collector.continuityProjection.characterStates?.['ch-0001']).toEqual({
      characterId: 'ch-0001',
      name: 'Alice',
      immediate: 'Catching breath; dust clinging to boots',
      state: {
        attire: 'tattered travel cloak',
        injury: '',
        gear: 'holding brass lantern',
      },
      knowledge: ['The tower gate was unlatched from within'],
      secrets: ['Carrying the brass key'],
    })

    expect(collector.continuityProjection.entityStates).toBeDefined()
    expect(collector.continuityProjection.entityStates?.['old_tower']).toEqual({
      name: 'Old Tower',
      category: 'location',
      immediate: 'Cold draft whistling through the iron bars',
      state: {
        gate: 'unlatched',
      },
      notes: ['Pre-war construction'],
    })

    // Timeline events fallback when events is empty
    const timeline = timelineEventsFor([], collector.continuityProjection.scene, collector.summaryUpdate)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].event).toBe(collector.summaryUpdate)
    expect(timeline[0].position).toBe('after')
  })
})

describe('3-beat staged pipeline tools', () => {
  beforeEach(() => vi.mocked(getFragment).mockResolvedValue(null))

  it('reportObservation delivers resolved fragments with numbered sentences and grounds contradictions', async () => {
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'The old knight carried a silver sword. He opened the north gate alone.',
    })
    const record = mockFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Old Knight',
      content: 'The old knight carries a rusty spear. He refuses to guard the gate.',
    })
    vi.mocked(getFragment).mockImplementation(async (_dir, _story, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return record
      return null
    })

    const collector = createEmptyCollector()
    const numberedFragmentIds = new Set<string>()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      numberedFragmentIds,
    })

    const result = await tools.reportObservation.execute({
      summary: 'The old knight carried his silver sword and opened the north gate alone.',
      scene: { transition: 'advance', evidenceSegments: [2] },
      mentions: [{ fragmentId: 'ch-0001', text: 'old knight' }],
      candidateFragmentIds: ['ch-0001'],
      contradictions: [
        {
          description: 'The knight has a silver sword, not a rusty spear.',
          sourceSegments: [1],
          conflictingEvidence: [{ fragmentId: 'ch-0001', segments: [1] }],
        },
        {
          description: 'Invalid contradiction citing non-existent sentence.',
          sourceSegments: [99],
          conflictingEvidence: [{ fragmentId: 'ch-0001', segments: [1] }],
        },
      ],
    }, executionContext)

    expect(result.ok).toBe(true)
    expect(result.mentionCount).toBe(1)
    expect(result.contradictionCount).toBe(1)
    expect(result.skippedContradictions).toHaveLength(1)
    expect(result.skippedContradictions[0].reason).toContain('99')

    expect(result.resolvedFragments).toHaveLength(1)
    expect(result.resolvedFragments[0].id).toBe('ch-0001')
    expect(result.resolvedFragments[0].content).toContain('[1] The old knight carries a rusty spear.')
    expect(numberedFragmentIds.has('ch-0001')).toBe(true)

    expect(collector.summaryUpdate).toBe('The old knight carried his silver sword and opened the north gate alone.')
    expect(collector.contradictions).toHaveLength(1)
    expect(collector.contradictions[0].description).toBe('The knight has a silver sword, not a rusty spear.')
    expect(collector.contradictions[0].sourceSegments).toEqual([1])
  })

  it('reportContinuity processes live state and queues validated record corrections and new records', async () => {
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'The old knight carried a silver sword. He opened the north gate alone.',
    })
    const record = mockFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Old Knight',
      content: 'The old knight carries a rusty spear. He refuses to guard the gate.',
    })
    vi.mocked(getFragment).mockImplementation(async (_dir, _story, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-0001') return record
      return null
    })

    const collector = createEmptyCollector()
    const numberedFragmentIds = new Set<string>(['ch-0001'])
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      numberedFragmentIds,
    })

    const result = await tools.reportContinuity.execute({
      characters: [
        {
          characterId: 'ch-0001',
          name: 'Old Knight',
          immediate: 'Standing at the threshold',
           state: [
             { key: 'attire', value: 'worn chainmail' },
             { key: 'weapon', value: 'silver sword' },
           ],
          knowledge: ['The gate mechanism is undamaged'],
        },
      ],
      entities: [],
      threads: ['Why was the gate unlocked?'],
      evidenceSegments: [1],
      corrections: [
        {
          fragmentId: 'ch-0001',
          field: 'content',
          segment: 1,
          newText: 'The old knight carries a silver sword.',
          reason: 'Prose establishes the knight carries a silver sword.',
        },
      ],
      newRecords: [
        {
          type: 'knowledge',
          name: 'North Gate Lore',
          content: 'The north gate has stood since the first dynasty.',
        },
      ],
    }, executionContext)

    expect(result.ok).toBe(true)
    expect(result.characterCount).toBe(1)
    expect(result.threadCount).toBe(1)
    expect(result.proposalCount).toBe(2)

    expect(collector.fragmentChangeProposals).toHaveLength(2)
    const correctionProposal = collector.fragmentChangeProposals.find(p => p.proposalKind === 'correction')
    expect(correctionProposal).toBeDefined()
    expect(correctionProposal?.operations[0]).toEqual(expect.objectContaining({
      action: 'replace_text',
      fragmentId: 'ch-0001',
      oldText: 'The old knight carries a rusty spear.',
      newText: 'The old knight carries a silver sword.',
    }))

    const newRecordProposal = collector.fragmentChangeProposals.find(p => p.proposalKind === 'new-fragment')
    expect(newRecordProposal).toBeDefined()
    expect(newRecordProposal?.operations[0]).toEqual(expect.objectContaining({
      action: 'create_fragment',
      type: 'knowledge',
      name: 'North Gate Lore',
    }))
  })

  it('reportContinuity rejects corrections against records not shown numbered', async () => {
    const prose = mockFragment({
      id: 'pr-0001',
      type: 'prose',
      content: 'The old knight carried a silver sword.',
    })
    const unnumberedRecord = mockFragment({
      id: 'ch-9999',
      type: 'character',
      name: 'Mystery Knight',
      content: 'A mysterious knight.',
    })
    vi.mocked(getFragment).mockImplementation(async (_dir, _story, id) => {
      if (id === 'pr-0001') return prose
      if (id === 'ch-9999') return unnumberedRecord
      return null
    })

    const collector = createEmptyCollector()
    const numberedFragmentIds = new Set<string>() // ch-9999 is NOT in numberedFragmentIds
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      proseFragmentId: 'pr-0001',
      numberedFragmentIds,
    })

    const result = await tools.reportContinuity.execute({
      characters: [],
      evidenceSegments: [1],
      corrections: [
        {
          fragmentId: 'ch-9999',
          field: 'content',
          segment: 1,
          newText: 'An identified knight.',
        },
      ],
    }, executionContext)

    expect(result.ok).toBe(true)
    expect(result.proposalCount).toBe(0)
    expect(result.skippedProposals).toHaveLength(1)
    expect(result.skippedProposals[0].reason).toContain('has not been shown with numbered sentences')
  })

  it('reportDirections stores creative narrative options', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    const result = await tools.reportDirections.execute({
      directions: [
        { title: 'Press On', description: 'Cross the open courtyard.', instruction: 'Describe the perilous crossing.' },
        { title: 'Seek Cover', description: 'Duck into the guardhouse.', instruction: 'Investigate the abandoned post.' },
        { title: 'Call Out', description: 'Signal to the watchtower.', instruction: 'Shout a challenge to the parapet.' },
      ],
    }, executionContext)

    expect(result.ok).toBe(true)
    expect(result.directionCount).toBe(3)
    expect(collector.directions).toHaveLength(3)
    expect(collector.directions[0].title).toBe('Press On')
  })

  describe('forgiving schema parsing & official Gemma template compliance', () => {
    it('produces official JSON Schemas with 0 anyOf, 0 oneOf, and 0 type: null', () => {
      const schemas = [
        { name: 'reportObservation', schema: reportObservationInputSchema },
        { name: 'reportContinuity', schema: reportContinuityInputSchema },
        { name: 'reportDirections', schema: reportDirectionsInputSchema },
      ]

      for (const { name, schema } of schemas) {
        const jsonSchemaObj = z.toJSONSchema(schema)
        const jsonStr = JSON.stringify(jsonSchemaObj)
        const anyOfMatches = jsonStr.match(/"anyOf"/g) ?? []
        const oneOfMatches = jsonStr.match(/"oneOf"/g) ?? []
        const nullTypeMatches = jsonStr.match(/"type":\s*"null"/g) ?? []

        expect(anyOfMatches.length, `${name} has anyOf`).toBe(0)
        expect(oneOfMatches.length, `${name} has oneOf`).toBe(0)
        expect(nullTypeMatches.length, `${name} has type: "null"`).toBe(0)
      }
    })

    it('coerces empty string or null state to empty array [] without crashing', () => {
      const resultEmptyStr = reportContinuityInputSchema.safeParse({
        characters: [
          { name: 'Pieter van Reede', state: '' },
          { name: 'Hiddema', state: null },
        ],
      })
      expect(resultEmptyStr.success).toBe(true)
      if (resultEmptyStr.success) {
        expect(resultEmptyStr.data.characters[0].state).toEqual([])
        expect(resultEmptyStr.data.characters[1].state).toEqual([])
      }
    })

    it('coerces a plain state object with boolean or number values into key/value pairs', () => {
      const result = reportContinuityInputSchema.safeParse({
        characters: [
          { name: 'Victoria', state: { repaired: true, count: 2, condition: 'alert' } },
        ],
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.characters[0].state).toEqual([
          { key: 'repaired', value: 'true' },
          { key: 'count', value: '2' },
          { key: 'condition', value: 'alert' },
        ])
      }
    })

    it('coerces empty string or null arrays to empty arrays []', () => {
      const result = reportContinuityInputSchema.safeParse({
        characters: [
          { name: 'Victoria', knowledge: '', secrets: null },
        ],
        entities: '',
        threads: null,
        evidenceSegments: '',
        corrections: '',
        newRecords: null,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.characters[0].knowledge).toEqual([])
        expect(result.data.characters[0].secrets).toEqual([])
        expect(result.data.entities).toEqual([])
        expect(result.data.threads).toEqual([])
        expect(result.data.evidenceSegments).toEqual([])
        expect(result.data.corrections).toEqual([])
        expect(result.data.newRecords).toEqual([])
      }
    })

    it('coerces single string or number inputs into arrays', () => {
      const result = reportContinuityInputSchema.safeParse({
        characters: [
          { name: 'Victoria', knowledge: 'Learned the truth' },
        ],
        threads: 'Who poisoned the king?',
        evidenceSegments: 4,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.characters[0].knowledge).toEqual(['Learned the truth'])
        expect(result.data.threads).toEqual(['Who poisoned the king?'])
        expect(result.data.evidenceSegments).toEqual([4])
      }
    })

    it('coerces candidateFragmentIds, mentions, and contradictions in reportObservation', () => {
      const result = reportObservationInputSchema.safeParse({
        summary: 'A speech was given.',
        scene: { transition: 'advance' },
        mentions: '',
        candidateFragmentIds: 'ch-0001',
        contradictions: '',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.mentions).toEqual([])
        expect(result.data.candidateFragmentIds).toEqual(['ch-0001'])
        expect(result.data.contradictions).toEqual([])
      }
    })

    it('coerces string segment numbers in correctionProposalItemSchema', () => {
      const result = reportContinuityInputSchema.safeParse({
        characters: [],
        evidenceSegments: [1],
        corrections: [
          {
            fragmentId: 'ch-0001',
            segment: '2',
            newText: 'Updated content text.',
          },
        ],
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.corrections?.[0].segment).toBe(2)
      }
    })
  })
})
