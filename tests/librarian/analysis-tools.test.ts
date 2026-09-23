import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from 'ai'
import {
  buildPassageReportInputSchema,
  createAnalysisTools,
  createEmptyCollector,
  forgivingArray,
  forgivingNumberArray,
  listLibrarianAnalyzeToolNames,
  mentionInputSchema,
  reportMaintenanceInputSchema,
  reportPassageInputSchema,
  resolveMentionTerm,
  timelineEventsFor,
} from '@/server/librarian/analysis-tools'
import { liveStateItemId } from '@/contracts/live-state'
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

/** Call a report as the SDK does: validate the input against its schema, then execute. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function report(tool: Tool, input: unknown): Promise<any> {
  const schema = tool.inputSchema as { validate: (value: unknown) => Promise<{ success: boolean; value?: unknown; error?: unknown }> | { success: boolean; value?: unknown; error?: unknown } }
  const parsed = await schema.validate(input)
  if (!parsed.success) throw parsed.error
  return tool.execute!(parsed.value, executionContext)
}

function mockFragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: 'ch-0001', type: 'character', name: 'Alice', description: 'A warrior.',
    content: 'Alice is captain of the guard. She keeps the north gate.',
    tags: [], refs: [], sticky: false, placement: 'user', createdAt: '', updatedAt: '',
    order: 0, meta: {}, archived: false, version: 1, versions: [], ...overrides,
  }
}

function serveFragments(...fragments: Fragment[]) {
  const byId = new Map(fragments.map((fragment) => [fragment.id, fragment]))
  vi.mocked(getFragment).mockImplementation(async (_dataDir, _storyId, id) => byId.get(id) ?? null)
}

const threeDirections = [
  { title: 'Wait', description: 'The pause lengthens.', instruction: 'Continue the pause.' },
  { title: 'Enter', description: 'A visitor arrives.', instruction: 'Introduce the visitor.' },
  { title: 'Leave', description: 'Alice departs.', instruction: 'Follow Alice outside.' },
]

describe('analysis tool contracts', () => {
  beforeEach(() => vi.mocked(getFragment).mockResolvedValue(null))

  it('creates an empty collector', () => {
    expect(createEmptyCollector()).toEqual({
      summaryUpdate: '', events: [], mentions: [], newRecordNames: [], contradictions: [],
      fragmentChangeProposals: [], directions: [],
      continuityProjection: {
        version: 4, scene: { transition: 'uncertain' }, threadOperations: [], threadFocus: [], liveStates: [],
      },
    })
  })

  it('requires one self-contained report instead of synthesizing missing content', () => {
    expect(reportPassageInputSchema.safeParse({}).success).toBe(false)
    expect(reportPassageInputSchema.safeParse({ summary: '   ' }).success).toBe(false)
    const parsed = reportPassageInputSchema.parse({
      summary: 'Alice waited.', participantIds: ['ch-0001'], directions: threeDirections,
    })
    expect(parsed).not.toHaveProperty('participantIds')
  })

  it('keeps a report whose directions are missing or fewer than three', () => {
    expect(reportPassageInputSchema.parse({ summary: 'Alice waited.', directions: threeDirections.slice(0, 1) }).directions).toHaveLength(1)
    expect(reportPassageInputSchema.parse({ summary: 'Alice waited.' }).directions).toEqual([])
    expect(buildPassageReportInputSchema({ includeDirections: false }).parse({ summary: 'Alice waited.', directions: threeDirections }))
      .not.toHaveProperty('directions')
  })

  it('exposes the passage report and record maintenance to online Analyze', () => {
    const tools = createAnalysisTools(createEmptyCollector(), {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001',
    })
    expect(Object.keys(tools)).toEqual(['reportPassage', 'reportMaintenance'])
    expect(listLibrarianAnalyzeToolNames()).toEqual(Object.keys(tools))
  })

  it('omits record maintenance and directions when disabled', () => {
    const tools = createAnalysisTools(createEmptyCollector(), {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', disableSuggestions: true, disableDirections: true,
    })
    expect(Object.keys(tools)).toEqual(['reportPassage'])
    const schema = (tools.reportPassage.inputSchema as { jsonSchema: { properties: Record<string, unknown> } }).jsonSchema
    expect(schema.properties).not.toHaveProperty('directions')
  })

  it('collects directions in the passage report', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)
    await report(tools.reportPassage, { summary: 'Alice waited.', directions: threeDirections })
    expect(collector.directions).toHaveLength(3)
  })
})

describe('reportPassage', () => {
  beforeEach(() => vi.mocked(getFragment).mockResolvedValue(null))

  it('stores the model report directly and replaces it on a later report', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)
    await report(tools.reportPassage, {
      summary: 'First summary.', events: ['First event.', 'Second event.'],
      contradictions: [{ description: 'A conflict.', fragmentIds: [] }],
    })
    await report(tools.reportPassage, { summary: 'Replacement summary.', events: ['Replacement event.'] })
    expect(collector.summaryUpdate).toBe('Replacement summary.')
    expect(collector.events).toEqual(['Replacement event.'])
    expect(collector.contradictions).toEqual([])
  })

  it('publishes normalized progress when the report succeeds', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice entered the north hall.' })
    const record = mockFragment({ id: 'ch-0001', name: 'Alice Cooper' })
    serveFragments(prose, record)
    const onProgress = vi.fn()
    const tools = createAnalysisTools(createEmptyCollector(), {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id, onProgress,
    })

    await report(tools.reportPassage, {
      summary: 'Alice entered the hall.',
      events: ['Alice entered the north hall.'],
      mentions: [
        { fragmentId: record.id, text: 'Alice' },
        { fragmentId: record.id, text: 'Alice Cooper' },
      ],
      directions: threeDirections,
    })

    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      fragmentId: prose.id,
      stage: 'passage',
      summaryUpdate: 'Alice entered the hall.',
      mentions: [{ fragmentId: record.id, text: 'Alice' }],
      timelineEvents: [{ event: 'Alice entered the north hall.', position: 'after' }],
      directions: expect.arrayContaining([expect.objectContaining({ title: 'Wait' })]),
    }))
  })

  it('announces record maintenance when the report found evidence for it', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice rode to Valdris.' })
    serveFragments(prose)
    const onProgress = vi.fn()
    const tools = createAnalysisTools(createEmptyCollector(), {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id, onProgress,
    })
    await report(tools.reportPassage, { summary: 'Alice rode on.', newRecordNames: ['Valdris'] })
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'record-maintenance' }))
  })

  it('resolves mention highlights to the in-prose span or the catalog name', async () => {
    serveFragments(
      mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice studied the Silver ash by the gate.' }),
      mockFragment({ id: 'ch-0001', name: 'Alice' }),
      mockFragment({ id: 'kn-0001', name: 'Silver ash' }),
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })
    const result = await report(tools.reportPassage, {
      summary: 'Alice studies the ash.',
      mentions: [
        { fragmentId: 'ch-0001', text: 'Alice' },
        { fragmentId: 'kn-0001', text: '"Silver ash"' },
        { fragmentId: 'ch-0001', text: 'she' },
      ],
    })
    // 'Alice' appears verbatim in the prose so it is kept; '"Silver ash"' is not
    // verbatim (the quotes are not in the prose) so it resolves to the catalog
    // name; a pronoun is no highlight, so it also resolves to the catalog name
    // and collapses into the first Alice mention.
    expect(collector.mentions).toEqual([
      { fragmentId: 'ch-0001', text: 'Alice' },
      { fragmentId: 'kn-0001', text: 'Silver ash' },
    ])
    expect(result).toMatchObject({ mentionCount: 2 })
    expect(result.skippedMentions).toBeUndefined()
  })

  it('keeps one mention per record and wording', async () => {
    serveFragments(
      mockFragment({ id: 'pr-0001', type: 'prose', content: 'The old knight drew his sword. The old knight opened the gate.' }),
      mockFragment({ id: 'ch-0001', name: 'Old Knight', content: 'A knight.' }),
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })
    await report(tools.reportPassage, {
      summary: 'The old knight drew his sword and opened the gate.',
      mentions: [
        { fragmentId: 'ch-0001', text: 'old knight', segment: 1 },
        { fragmentId: 'ch-0001', text: 'Old Knight', segment: 2 },
        { fragmentId: 'ch-0001', text: 'his sword' },
      ],
    })
    expect(collector.mentions).toEqual([
      { fragmentId: 'ch-0001', text: 'old knight' },
      { fragmentId: 'ch-0001', text: 'his sword' },
    ])
  })

  it('skips mentions of unknown records without rejecting the report', async () => {
    serveFragments(
      mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice walked to the harbor.' }),
      mockFragment({ id: 'ch-0001', name: 'Alice' }),
    )
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })
    const result = await report(tools.reportPassage, {
      summary: 'Alice arrived at the harbor.',
      mentions: [
        { fragmentId: 'ch-0001', text: 'Alice' },
        { fragmentId: 'ch-9999', text: 'Ghost' },
      ],
      scene: { transition: 'continue', location: { key: 'harbor', label: 'Harbor', fragmentId: 'loc-9999' }, evidenceSegments: [1] },
    })
    expect(result).toMatchObject({ ok: true, mentionCount: 1 })
    expect(result.skippedMentions).toEqual([expect.objectContaining({ fragmentId: 'ch-9999' })])
    expect(collector.continuityProjection.scene.location).toEqual({ key: 'harbor', label: 'Harbor' })
  })

  it('grounds contradictions on both the prose and a reusable record, and delivers that record numbered once', async () => {
    const prose = mockFragment({
      id: 'pr-0001', type: 'prose',
      content: 'The old knight carried a silver sword. He opened the north gate alone.',
    })
    const record = mockFragment({
      id: 'ch-0001', name: 'Old Knight',
      content: 'The old knight carries a rusty spear. He refuses to guard the gate.',
    })
    serveFragments(prose, record)
    const collector = createEmptyCollector()
    const numberedFragmentIds = new Set<string>()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001', numberedFragmentIds,
    })
    const input = {
      summary: 'The old knight carried his silver sword and opened the north gate alone.',
      scene: { transition: 'advance', evidenceSegments: [2] },
      mentions: [{ fragmentId: 'ch-0001', text: 'old knight' }],
      contradictions: [
        {
          description: 'The knight has a silver sword, not a rusty spear.',
          sourceSegments: [1],
          conflictingEvidence: [{ fragmentId: 'ch-0001', segments: [1] }],
        },
        {
          description: 'Invalid contradiction citing a sentence that does not exist.',
          sourceSegments: [99],
          conflictingEvidence: [{ fragmentId: 'ch-0001', segments: [1] }],
        },
      ],
    }

    const first = await report(tools.reportPassage, input)
    const second = await report(tools.reportPassage, input)

    expect(first).toMatchObject({ ok: true, mentionCount: 1, contradictionCount: 1 })
    expect(first.skippedContradictions).toEqual([expect.objectContaining({ reason: expect.stringContaining('99') })])
    expect(first.resolvedFragments).toEqual([expect.objectContaining({
      id: 'ch-0001', content: expect.stringContaining('[1] The old knight carries a rusty spear.'),
    })])
    expect(second).not.toHaveProperty('resolvedFragments')
    expect(numberedFragmentIds.has('ch-0001')).toBe(true)
    expect(collector.contradictions).toEqual([expect.objectContaining({
      description: 'The knight has a silver sword, not a rusty spear.',
      sourceSegments: [1],
      sourceEvidenceText: 'The old knight carried a silver sword.',
      conflictingEvidence: [expect.objectContaining({ evidenceText: 'The old knight carries a rusty spear.' })],
    })])
  })

  it('keeps only new record names the prose uses and the catalog lacks', async () => {
    const prose = mockFragment({ id: 'pr-0001', type: 'prose', content: 'Alice rode to Valdris past the Salt Gate.' })
    const alice = mockFragment({ id: 'ch-0001', name: 'Alice' })
    serveFragments(prose, alice)
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })
    await report(tools.reportPassage, {
      summary: 'Alice rode to Valdris.',
      mentions: [{ fragmentId: 'ch-0001', text: 'Alice' }],
      newRecordNames: ['Valdris', 'salt gate', 'Alice', 'Mirewood'],
    })
    expect(collector.newRecordNames).toEqual(['Valdris', 'Salt Gate'])
  })

  it('withdraws a scene claim without evidence but keeps the rest of the report', async () => {
    serveFragments(mockFragment({ id: 'pr-0001', type: 'prose', content: 'Night fell. The ship waited.' }))
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, { dataDir: '/tmp', storyId: 'story-test', proseFragmentId: 'pr-0001' })
    const result = await report(tools.reportPassage, {
      summary: 'Night fell over the waiting ship.',
      scene: { transition: 'cut', evidenceSegments: [9] },
    })
    expect(result.ok).toBe(true)
    expect(collector.summaryUpdate).toBe('Night fell over the waiting ship.')
    expect(collector.continuityProjection.scene).toEqual({ transition: 'uncertain' })
    expect(result.skippedContinuity).toEqual([expect.objectContaining({ kind: 'scene', key: 'cut' })])
  })

  it('normalizes character and entity live states and falls back to the summary for timeline events', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector)

    const result = await report(tools.reportPassage, {
      summary: 'Alice examined the old tower gates while the wind howled outside.',
      characters: [{
        character: 'ch-0001',
        set: [
          { field: 'Currently', value: 'Catching breath; dust clinging to boots' },
          { field: 'attire', value: 'tattered travel cloak' },
          { field: 'injury', value: 'none' },
          { field: 'gear', value: 'holding brass lantern' },
        ],
        add: [
          { field: 'Knows', text: 'The tower gate was unlatched from within' },
          { field: 'Secrets', text: 'Carrying the brass key' },
        ],
      }],
      entities: [{
        entity: 'Old Tower',
        category: 'location',
        set: [
          { field: 'Currently', value: 'Cold draft whistling through the iron bars' },
          { field: 'gate', value: 'unlatched' },
        ],
        add: [{ field: 'Notes', text: 'Pre-war construction' }],
      }],
    })

    expect(result.ok).toBe(true)
    const [alice, tower] = collector.continuityProjection.liveStates
    expect(alice).toEqual({
      kind: 'character',
      key: 'ch-0001',
      fragmentId: 'ch-0001',
      name: 'ch-0001',
      present: true,
      set: [
        { field: 'Currently', value: 'Catching breath; dust clinging to boots' },
        { field: 'attire', value: 'tattered travel cloak' },
        { field: 'injury', value: '' },
        { field: 'gear', value: 'holding brass lantern' },
      ],
      add: [
        { id: liveStateItemId('Knows', 'The tower gate was unlatched from within'), field: 'Knows', text: 'The tower gate was unlatched from within' },
        { id: liveStateItemId('Secrets', 'Carrying the brass key'), field: 'Secrets', text: 'Carrying the brass key' },
      ],
      update: [],
    })
    expect(tower).toMatchObject({
      kind: 'entity',
      key: 'old_tower',
      name: 'Old Tower',
      category: 'location',
      present: true,
      add: [{ field: 'Notes', text: 'Pre-war construction' }],
    })

    const timeline = timelineEventsFor([], collector.continuityProjection.scene, collector.summaryUpdate)
    expect(timeline).toEqual([{ event: collector.summaryUpdate, position: 'after' }])
  })

  it('ends numbered entries on their owner and records who learned a revealed secret', async () => {
    serveFragments(
      mockFragment({ id: 'ch-0001', name: 'Victoria', content: 'The sovereign.' }),
      mockFragment({ id: 'ch-0002', name: 'Aris Thorne', content: 'A researcher.' }),
    )
    const secretId = liveStateItemId('Secrets', 'craves the ruin of her status')
    const beliefId = liveStateItemId('Knows', 'the baseline is only a sample')
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      registry: {
        items: [
          { index: 1, kind: 'character', subjectKey: 'ch-0001', subjectName: 'Victoria', id: secretId, field: 'Secrets', text: 'craves the ruin of her status' },
          { index: 2, kind: 'character', subjectKey: 'ch-0002', subjectName: 'Aris Thorne', id: beliefId, field: 'Knows', text: 'the baseline is only a sample' },
        ],
      },
    })

    const result = await report(tools.reportPassage, {
      summary: 'Thorne learned the truth.',
      characters: [{ character: 'ch-0002', set: [{ field: 'Currently', value: 'kneeling by the dais' }] }],
      // Only Thorne is present; the revealed secret is Victoria's.
      update: [
        { item: 1, happened: 'revealed', to: ['Aris Thorne'] },
        { item: 2, happened: 'changed', now: 'the baseline is the source' },
        { item: 9, happened: 'resolved' },
      ],
    })

    expect(result.ok).toBe(true)
    expect(collector.continuityProjection.liveStates).toEqual([
      expect.objectContaining({
        key: 'ch-0002',
        present: true,
        set: [{ field: 'Currently', value: 'kneeling by the dais' }],
        update: [{
          id: beliefId,
          happened: 'changed',
          now: { id: liveStateItemId('Knows', 'the baseline is the source'), text: 'the baseline is the source' },
        }],
      }),
      expect.objectContaining({
        key: 'ch-0001',
        name: 'Victoria',
        present: false,
        update: [{ id: secretId, happened: 'revealed', to: ['ch-0002'] }],
      }),
    ])
    expect(result.skippedContinuity).toEqual([expect.objectContaining({ kind: 'item', key: '9' })])
  })

  it('treats threads as a foreground snapshot and resolves existing keys explicitly', async () => {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp',
      storyId: 'story-test',
      registry: {
        thread: [
          { key: 'who_unlocked_the_gate', label: 'Who unlocked the gate?' },
          { key: 'where_is_the_map', label: 'Where is the map?' },
          { key: 'why_the_bells_rang', label: 'Why did the bells ring?' },
        ],
      },
    })

    const result = await report(tools.reportPassage, {
      summary: 'The map turned up.',
      threads: ['who_unlocked_the_gate', 'Who lit the beacon?'],
      resolvedThreads: ['Where is the map?', 'unknown_question'],
    })

    expect(result.ok).toBe(true)
    expect(collector.continuityProjection.threadOperations).toEqual([
      { threadKey: 'where_is_the_map', action: 'resolve' },
      { threadKey: 'who_unlocked_the_gate', action: 'advance', label: 'Who unlocked the gate?' },
      { threadKey: 'who_lit_the_beacon', action: 'open', label: 'Who lit the beacon?' },
    ])
    expect(collector.continuityProjection.threadFocus).toEqual([
      { threadKey: 'who_unlocked_the_gate', visibility: 'foreground' },
      { threadKey: 'who_lit_the_beacon', visibility: 'foreground' },
      { threadKey: 'why_the_bells_rang', visibility: 'dormant' },
    ])
    expect(result.skippedContinuity).toEqual([expect.objectContaining({ kind: 'thread', key: 'unknown_question' })])
  })
})

describe('mention terms', () => {
  it('places events from the scene line and validates mention fragment IDs', () => {
    expect(timelineEventsFor(['Alice remembers.'], { transition: 'continue', line: 'flashback' }))
      .toEqual([{ event: 'Alice remembers.', position: 'before' }])
    expect(mentionInputSchema.safeParse({ fragmentId: 'bad-id', text: 'Alice' }).success).toBe(false)
  })

  it('resolves mention highlight terms from the prose span or catalog name', () => {
    const resolveName = (id: string) => (id === 'ch-0001' ? 'Alice' : id === 'kn-0001' ? 'Silver ash' : undefined)
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'Alice', prose: 'Alice left.', resolveName })).toBe('Alice')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'Miss Alice', prose: 'Alice left.', resolveName })).toBe('Alice')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'the captain', prose: 'Alice left.', resolveName })).toBe('Alice')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', prose: 'Alice left.', resolveName })).toBe('Alice')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'the captain', prose: 'the captain left.', resolveName: () => 'Alice' })).toBe('the captain')
    expect(resolveMentionTerm({ fragmentId: 'kn-0001', resolveName })).toBe('')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'ghost', resolveName: () => undefined })).toBe('')
  })

  it('confirms a highlight as whole words and never guesses one from part of a name', () => {
    const resolveName = () => 'The Silver Ash and the Key'
    expect(resolveMentionTerm({ fragmentId: 'kn-0001', prose: 'She took the key and left.', resolveName })).toBe('')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'Ann', prose: 'Annabel left.', resolveName: () => 'Ann' })).toBe('')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'the  researcher', prose: 'Then the researcher knelt.', resolveName })).toBe('the researcher')
  })

  it('requires the words the prose uses for a mention', () => {
    expect(mentionInputSchema.safeParse({ fragmentId: 'ch-0001' }).success).toBe(false)
    expect(mentionInputSchema.parse({ fragmentId: 'ch-0001', text: 'the captain', segment: 3 })).toEqual({ fragmentId: 'ch-0001', text: 'the captain' })
  })

  it('highlights names and phrases, never a pronoun or a lone common word', () => {
    const prose = 'I watched my daughters. Hiddema and the girls waited in the hall.'
    const resolveName = () => undefined
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'I', prose, resolveName })).toBe('')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'my', prose, resolveName })).toBe('')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'hall', prose, resolveName })).toBe('')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'Hiddema', prose, resolveName })).toBe('Hiddema')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'the girls', prose, resolveName })).toBe('the girls')
    expect(resolveMentionTerm({ fragmentId: 'ch-0001', modelText: 'my daughters', prose, resolveName })).toBe('my daughters')
  })
})

describe('reportMaintenance', () => {
  const prose = mockFragment({
    id: 'pr-0001', type: 'prose',
    content: 'Alice resigned from the guard. The Lantern Archive opened.',
  })
  const record = mockFragment({
    id: 'ch-0001',
    content: 'Alice is captain of the guard. She keeps the north gate. She keeps the north gate.',
  })
  const archive = { type: 'knowledge', name: 'Lantern Archive', description: 'An archive.', content: 'The archive opened.' }

  beforeEach(() => serveFragments(prose, record))

  function maintenanceTools(numberedFragmentIds: string[] = ['ch-0001']) {
    const collector = createEmptyCollector()
    const tools = createAnalysisTools(collector, {
      dataDir: '/tmp', storyId: 'story-test', proseFragmentId: prose.id,
      disableDirections: true, numberedFragmentIds,
    })
    return { collector, tools }
  }

  it('resolves a numbered sentence into an exact oldText/newText operation', async () => {
    const { collector, tools } = maintenanceTools()
    const result = await report(tools.reportMaintenance, {
      evidenceSegments: [1],
      corrections: [{ fragmentId: record.id, segment: 1, newText: 'Alice is the former captain of the guard.' }],
    })
    expect(result).toMatchObject({ ok: true, queuedOperationCount: 1, invalid: 0 })
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      action: 'replace_text', fragmentId: record.id, oldText: 'Alice is captain of the guard.',
      newText: 'Alice is the former captain of the guard.', replaceAll: false,
    })
  })

  it('adds an occurrence only when the anchored sentence repeats', async () => {
    const { collector, tools } = maintenanceTools()
    await report(tools.reportMaintenance, {
      evidenceSegments: [1],
      corrections: [{ fragmentId: record.id, segment: 3, newText: 'She leaves the north gate.' }],
    })
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({ occurrence: 2 })
  })

  it('keeps replacement text exactly as authored', async () => {
    const { collector, tools } = maintenanceTools()
    await report(tools.reportMaintenance, {
      evidenceSegments: [1],
      corrections: [{ fragmentId: record.id, segment: 1, newText: '[1] Alice resigned. She now advises the guard.' }],
    })
    expect(collector.fragmentChangeProposals[0].operations[0]).toMatchObject({
      newText: '[1] Alice resigned. She now advises the guard.',
    })
  })

  it('rejects an invalid batch of corrections atomically', async () => {
    const { collector, tools } = maintenanceTools()
    const result = await report(tools.reportMaintenance, {
      evidenceSegments: [1],
      corrections: [
        { fragmentId: record.id, segment: 1, newText: 'Alice resigned.' },
        { fragmentId: record.id, segment: 99, newText: 'Missing sentence.' },
      ],
    })
    expect(result).toMatchObject({ queuedOperationCount: 0, invalid: 1 })
    expect(collector.fragmentChangeProposals).toEqual([])
  })

  it('requires the target record to have been shown with numbered sentences', async () => {
    const { tools } = maintenanceTools([])
    const result = await report(tools.reportMaintenance, {
      evidenceSegments: [1], corrections: [{ fragmentId: record.id, segment: 1, newText: 'Alice resigned.' }],
    })
    expect(result).toMatchObject({ proposalCount: 0, queuedOperationCount: 0 })
    expect(result.skippedProposals[0].reason).toContain('has not been shown with numbered sentences')
  })

  it('validates shared evidence once for mixed proposal work', async () => {
    const { collector, tools } = maintenanceTools()
    const result = await report(tools.reportMaintenance, {
      evidenceSegments: [99],
      corrections: [{ fragmentId: record.id, segment: 1, newText: 'Alice resigned.' }],
      newRecords: [archive],
    })
    expect(result).toMatchObject({ invalid: 1, queuedOperationCount: 0 })
    expect(result.skippedProposals).toEqual([expect.objectContaining({ note: expect.stringContaining('Cited sentence 99 does not exist') })])
    expect(collector.fragmentChangeProposals).toEqual([])
    expect(getFragment).toHaveBeenCalledTimes(1)
  })

  it('queues corrections and new records as separate proposals', async () => {
    const { collector, tools } = maintenanceTools()
    const result = await report(tools.reportMaintenance, {
      evidenceSegments: [1, 2],
      corrections: [{ fragmentId: record.id, segment: 1, newText: 'Alice resigned from the guard.' }],
      newRecords: [archive],
    })
    expect(result).toMatchObject({ proposalCount: 2, queuedOperationCount: 2 })
    expect(collector.fragmentChangeProposals.map((proposal) => proposal.proposalKind)).toEqual(['correction', 'new-fragment'])
    expect(collector.fragmentChangeProposals[1].operations[0]).toMatchObject({
      action: 'create_fragment', type: 'knowledge', name: 'Lantern Archive',
    })
  })

  it('holds a repeated new record for review instead of auto-applying it twice', async () => {
    const { collector, tools } = maintenanceTools()
    await report(tools.reportMaintenance, { evidenceSegments: [2], newRecords: [archive] })
    await report(tools.reportMaintenance, { evidenceSegments: [2], newRecords: [archive] })
    expect(collector.fragmentChangeProposals).toHaveLength(2)
    expect(collector.fragmentChangeProposals.every((proposal) => proposal.autoApplySafe === false)).toBe(true)
  })
})

describe('report schemas', () => {
  it('produce JSON Schemas with no anyOf, oneOf, or null type', () => {
    for (const [name, schema] of [['reportPassage', reportPassageInputSchema], ['reportMaintenance', reportMaintenanceInputSchema]] as const) {
      const json = JSON.stringify(z.toJSONSchema(schema))
      expect(json.match(/"anyOf"/g) ?? [], `${name} has anyOf`).toHaveLength(0)
      expect(json.match(/"oneOf"/g) ?? [], `${name} has oneOf`).toHaveLength(0)
      expect(json.match(/"type":\s*"null"/g) ?? [], `${name} has type: "null"`).toHaveLength(0)
    }
  })

  it('emit the passage report in the order each part builds on the last', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passage = z.toJSONSchema(reportPassageInputSchema) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maintenance = z.toJSONSchema(reportMaintenanceInputSchema) as any
    expect(Object.keys(passage.properties)).toEqual([
      'summary', 'events', 'scene', 'mentions', 'contradictions', 'newRecordNames',
      'present', 'characters', 'entities', 'update', 'threads', 'resolvedThreads', 'directions',
    ])
    expect(passage.required).toEqual(Object.keys(passage.properties))
    expect(passage.properties.characters.items.required).toContain('character')
    expect(passage.properties.entities.items.required).toContain('entity')
    expect(maintenance.required).toEqual(['evidenceSegments', 'corrections', 'newRecords'])
  })

  it('forgive a single object or empty value where a list belongs', () => {
    const passage = reportPassageInputSchema.parse({
      summary: 'A speech was given.',
      scene: { transition: 'advance' },
      mentions: '',
      contradictions: '',
      characters: [
        { character: 'Victoria', set: { field: 'Currently', value: 'standing' }, add: '' },
        { character: 'Hiddema', set: null },
      ],
      update: [{ item: '[2]', happened: 'resolved' }, { item: 'x', happened: 'resolved' }],
      entities: '',
      threads: 'Who poisoned the king?',
    })
    expect(passage.mentions).toEqual([])
    expect(passage.contradictions).toEqual([])
    expect(passage.characters[0].set).toEqual([{ field: 'Currently', value: 'standing' }])
    expect(passage.characters[0].add).toEqual([])
    expect(passage.characters[1].set).toEqual([])
    expect(passage.update).toEqual([{ item: 2, happened: 'resolved' }])
    expect(passage.entities).toEqual([])
    expect(passage.threads).toEqual(['Who poisoned the king?'])

    expect(reportMaintenanceInputSchema.parse({ evidenceSegments: '', corrections: '', newRecords: null }))
      .toEqual({ evidenceSegments: [], corrections: [], newRecords: [] })
    expect(reportMaintenanceInputSchema.parse({ evidenceSegments: 4 }).evidenceSegments).toEqual([4])
    expect(reportMaintenanceInputSchema.parse({
      corrections: [{ fragmentId: 'ch-0001', segment: '2', newText: 'Updated content text.' }],
    }).corrections[0].segment).toBe(2)
  })

  it('drop a malformed optional scene claim and keep the rest', () => {
    const parsed = reportPassageInputSchema.parse({
      summary: 'Night fell over the waiting ship.',
      scene: {
        transition: 'advance',
        time: { label: '03:14 at night', certainty: 'approximate', calendar: '', earliest: '03:14' },
        elapsed: { label: 'hours', minimumSeconds: 7200, maximumSeconds: 60 },
        evidenceSegments: [1],
      },
    })
    expect(parsed.summary).toBe('Night fell over the waiting ship.')
    expect(parsed.scene.time).toEqual({ label: '03:14 at night', certainty: 'approximate' })
    expect(parsed.scene.elapsed).toBeUndefined()
  })
})

describe('forgiving array per-item forgiveness', () => {
  it('drops a schema-invalid entry without failing the whole array', () => {
    const schema = forgivingArray(mentionInputSchema, { max: 24 })
    const result = schema.safeParse([
      { fragmentId: 'ch-0001', text: 'Alice' },
      { fragmentId: 'zzz', text: 'Zed' },
      { fragmentId: 'kn-bakagu', text: 'Bakagu' },
    ])
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual([
        { fragmentId: 'ch-0001', text: 'Alice' },
        { fragmentId: 'kn-bakagu', text: 'Bakagu' },
      ])
    }
  })

  it('trims an over-limit array instead of rejecting it', () => {
    const schema = forgivingArray(mentionInputSchema, { max: 2 })
    const items = Array.from({ length: 5 }, (_, i) => ({ fragmentId: `ch-000${i + 1}`, text: `Name ${i + 1}` }))
    const result = schema.safeParse(items)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual([{ fragmentId: 'ch-0001', text: 'Name 1' }, { fragmentId: 'ch-0002', text: 'Name 2' }])
    }
  })

  it('still fails a min-required array when every entry is dropped', () => {
    const schema = forgivingArray(mentionInputSchema, { min: 1, max: 24 })
    expect(schema.safeParse([{ fragmentId: 'zzz' }, { fragmentId: 'yyy' }]).success).toBe(false)
  })

  it('keeps a min-required array that still has one valid entry', () => {
    const schema = forgivingArray(mentionInputSchema, { min: 1, max: 24 })
    const result = schema.safeParse([{ fragmentId: 'zzz', text: 'Zed' }, { fragmentId: 'ch-0001', text: 'Alice' }])
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual([{ fragmentId: 'ch-0001', text: 'Alice' }])
    }
  })

  it('trims and filters a number array by the same rules', () => {
    const schema = forgivingNumberArray(z.number().int().positive(), { max: 3 })
    const result = schema.safeParse([1, '2', 0, 3, 4, '7'])
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual([1, 2, 3])
    }
  })
})
