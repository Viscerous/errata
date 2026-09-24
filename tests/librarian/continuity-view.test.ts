import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getContentRoot } from '@/server/fragments/branches'
import {
  buildContinuityLedger,
  continuityRegistry,
  projectContinuityView,
  renderContinuity,
} from '@/server/librarian/continuity-view'
import {
  createTempDir,
  makeContinuityView,
  makeLiveState,
  makeLiveStateField,
  makeLiveStateItem,
  makeLiveThread,
  makeTestSettings,
} from '../setup'
import { createStory, createFragment, getFragment } from '@/server/fragments/storage'
import { appendLiveStateEdit, saveAnalysis, type LibrarianAnalysis } from '@/server/librarian/storage'
import type { Fragment, StoryMeta } from '@/contracts/story'
import type { ContinuityLedger, ContinuityProjection } from '@/contracts/continuity'
import { liveStateItemId, type LiveStateReport } from '@/contracts/live-state'
import { analysisSourceRevision } from '@/server/librarian/continuity-source'

async function buildContinuityView(
  params: Parameters<typeof buildContinuityLedger>[0],
): Promise<ReturnType<typeof projectContinuityView>> {
  return projectContinuityView(await buildContinuityLedger(params))
}

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-continuity',
    name: 'Continuity Story',
    description: '',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeFragment(overrides: Partial<Fragment>): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'pr-0001',
    type: 'prose',
    name: 'Passage',
    description: '',
    content: '',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    ...overrides,
  }
}

function analysis(fragmentId: string, position: number): LibrarianAnalysis {
  return {
    id: `la-${position}`,
    createdAt: `2026-01-${String(position).padStart(2, '0')}T00:00:00.000Z`,
    fragmentId,
    summaryUpdate: `Summary ${position}`,
    mentions: [],
    contradictions: [],
    fragmentChangeProposals: [],
    timelineEvents: [{ event: `Event ${position}`, position: 'after' }],
  }
}

/** A stored projection; the parts a test does not state are empty. */
function projection(overrides: Partial<ContinuityProjection> = {}): ContinuityProjection {
  return {
    version: 4,
    scene: { transition: 'continue', line: 'present' },
    threadOperations: [],
    threadFocus: [],
    liveStates: [],
    ...overrides,
  }
}

const knows = (text: string) => ({ id: liveStateItemId('Knows', text), field: 'Knows', text })

/** Alice in the scene, somewhere. */
function aliceAt(where: string, changes: Partial<LiveStateReport> = {}): LiveStateReport {
  return {
    kind: 'character', key: 'ch-0001', fragmentId: 'ch-0001', name: 'Alice', present: true,
    set: [{ field: 'Where', value: where }], add: [], update: [], ...changes,
  }
}

describe('continuity view', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('caps live state by latest source position rather than first insertion order', () => {
    const liveStates = Array.from({ length: 49 }, (_, index) => ({
      sourceFragmentId: `pr-${index}`,
      analysisId: `la-${index}`,
      narrativePosition: index === 0 ? 100 : index + 1,
      kind: 'character' as const,
      key: `ch-${index}`,
      fragmentId: `ch-${index}`,
      name: `Character ${index}`,
      present: false,
      fields: [{ field: 'Where', value: 'the hall', holds: 'lastKnown' as const, visibility: 'outward' as const, scenesAgo: 0, sourceFragmentId: `pr-${index}`, analysisId: `la-${index}`, narrativePosition: index + 1 }],
      items: [],
      ended: [],
    }))
    const ledger: ContinuityLedger = {
      liveThreads: [],
      liveStates,
      staleProjectionCount: 0,
    }

    const view = projectContinuityView(ledger)

    expect(view?.liveStates).toHaveLength(48)
    expect(view?.liveStates?.some((subject) => subject.key === 'ch-0')).toBe(true)
    expect(view?.liveStates?.some((subject) => subject.key === 'ch-1')).toBe(false)
  })

  it('does not turn analyses without a projection into a second Writer memory channel', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    for (let position = 1; position <= 3; position += 1) {
      const fragmentId = `pr-000${position}`
      await createFragment(dataDir, story.id, makeFragment({
        id: fragmentId,
        type: 'prose',
        order: position,
        content: `Prose ${position}`,
      }))
      await saveAnalysis(dataDir, story.id, analysis(fragmentId, position))
    }

    const view = await buildContinuityView({
      dataDir,
      storyId: story.id,
      activeProseFragments: await Promise.all(
        ['pr-0001', 'pr-0002', 'pr-0003'].map(async (id) => (await getFragment(dataDir, story.id, id))!),
      ),
    })

    expect(view).toBeUndefined()
  })

  it('keeps the last completed projection when a newer analysis is partial', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await createFragment(dataDir, story.id, makeFragment({
      id: 'pr-0001', type: 'prose', order: 1, content: 'Alice remained in the great hall.',
    }))
    const passage = (await getFragment(dataDir, story.id, 'pr-0001'))!
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passage),
      continuityProjection: projection({ liveStates: [aliceAt('great hall')] }),
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 2),
      summaryUpdate: 'A partial rerun stopped before completion.',
    })

    const view = await buildContinuityView({
      dataDir, storyId: story.id, activeProseFragments: [passage],
    })

    expect(view?.liveStates?.[0].fields).toMatchObject([{ field: 'Where', value: 'great hall' }])
  })

  it('keeps state from a passage that never determined its scene frame', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await createFragment(dataDir, story.id, makeFragment({
      id: 'pr-0001',
      type: 'prose',
      order: 1,
      content: 'Prose 1',
    }))
    const passage = (await getFragment(dataDir, story.id, 'pr-0001'))!
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passage),
      continuityProjection: projection({
        // The schema default. Making no claim about time is not a claim to have
        // stepped out of the present, so the state it reported still counts.
        scene: { transition: 'uncertain', line: 'uncertain' },
        liveStates: [aliceAt('the great hall')],
      }),
    })

    const view = await buildContinuityView({
      dataDir,
      storyId: story.id,
      activeProseFragments: [passage],
    })

    expect(view?.liveStates?.[0].fields).toMatchObject([{ field: 'Where', value: 'the great hall' }])
    // An undetermined frame is not worth a line in the Writer's context either.
    expect(view?.currentScene).toMatchObject({ line: 'present' })
    const rendered = renderContinuity({ continuityView: view }, 'generation.writer')!
    expect(rendered).not.toContain('Current scene frame')
  })

  it('surfaces the occasion a present-line passage names', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await createFragment(dataDir, story.id, makeFragment({
      id: 'pr-0001',
      type: 'prose',
      order: 1,
      content: 'Prose 1',
    }))
    const passage = (await getFragment(dataDir, story.id, 'pr-0001'))!
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passage),
      continuityProjection: projection({
        scene: { transition: 'continue', line: 'present', time: { label: 'during the First Address', certainty: 'exact' } },
      }),
    })

    const view = await buildContinuityView({
      dataDir,
      storyId: story.id,
      activeProseFragments: [passage],
    })
    const rendered = renderContinuity({ continuityView: view }, 'generation.writer')!

    expect(rendered).toContain('Current scene frame')
    expect(rendered).toContain('- Time: during the First Address (exact)')
  })

  // The ledger fold runs inside buildContextState on the writer's critical
  // path, and its cache signature includes every prose hash, so it misses
  // after every accepted passage. Without a per-analysis memo the fold re-read
  // one file per passage on every generation.
  it('does not re-read analysis files when a new passage invalidates the view cache', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passages: Fragment[] = []
    for (let position = 1; position <= 3; position += 1) {
      const fragmentId = `pr-100${position}`
      await createFragment(dataDir, story.id, makeFragment({
        id: fragmentId,
        type: 'prose',
        order: position,
        content: `Prose ${position}`,
      }))
      const record = analysis(fragmentId, position)
      record.id = `la-cache-${position}`
      record.sourceRevision = analysisSourceRevision(
        (await getFragment(dataDir, story.id, fragmentId))!,
      )
      record.continuityProjection = projection({
        threadOperations: [{ threadKey: `thread_${position}`, action: 'open', label: `Thread ${position}` }],
      })
      await saveAnalysis(dataDir, story.id, record)
      passages.push((await getFragment(dataDir, story.id, fragmentId))!)
    }

    const first = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: passages })
    expect(first?.liveThreads).toHaveLength(3)

    // Delete the analysis files outright. A second build with a changed prose
    // set must still fold them, which is only possible from the memo.
    const analysesDir = join(await getContentRoot(dataDir, story.id), 'librarian', 'analyses')
    expect(await readdir(analysesDir)).not.toHaveLength(0)
    await rm(analysesDir, { recursive: true })
    await expect(readdir(analysesDir)).rejects.toThrow()
    const second = await buildContinuityView({
      dataDir,
      storyId: story.id,
      activeProseFragments: passages.slice(0, 2),
    })

    expect(second?.liveThreads.map((thread) => thread.threadKey)).toEqual(['thread_1', 'thread_2'])
  })

  it('folds live state, thread focus, and temporal frames while rejecting stale sources', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passages: Fragment[] = []
    for (let position = 1; position <= 4; position += 1) {
      const fragment = makeFragment({
        id: `pr-000${position}`,
        type: 'prose',
        order: position,
        content: `Passage ${position}`,
      })
      passages.push(fragment)
      await createFragment(dataDir, story.id, fragment)
    }

    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passages[0]),
      continuityProjection: projection({
        liveStates: [aliceAt('north gate', { add: [knows('The key is missing.')] })],
        threadOperations: [{ threadKey: 'missing-key', action: 'open', label: 'The missing key' }],
        threadFocus: [{ threadKey: 'missing-key', visibility: 'foreground' }],
      }),
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0002', 2),
      sourceRevision: analysisSourceRevision(passages[1]),
      continuityProjection: projection({
        liveStates: [aliceAt('great hall')],
        threadOperations: [{ threadKey: 'missing-key', action: 'advance' }],
      }),
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0003', 3),
      sourceRevision: analysisSourceRevision(passages[2]),
      continuityProjection: projection({
        scene: { transition: 'enter-flashback', line: 'flashback', time: { label: 'years earlier', certainty: 'approximate' }, evidenceSegments: [1], evidenceText: 'Passage 3' },
        liveStates: [aliceAt('childhood village')],
        threadFocus: [{ threadKey: 'missing-key', visibility: 'background' }],
      }),
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0004', 4),
      sourceRevision: { ...analysisSourceRevision(passages[3]), contentHash: 'stale' },
      continuityProjection: projection({ liveStates: [aliceAt('incorrect place')] }),
    })

    const view = await buildContinuityView({
      dataDir,
      storyId: story.id,
      activeProseFragments: passages,
    })

    // Keys are normalized on the fold, so a hyphenated spelling resolves to one identity.
    expect(view?.liveThreads).toMatchObject([{ threadKey: 'missing_key', visibility: 'background' }])
    expect(view?.currentScene).toMatchObject({ line: 'flashback', time: { label: 'years earlier' } })
    expect(view?.staleProjectionCount).toBe(1)

    const rendered = renderContinuity(
      { continuityView: view, stickyCharacters: [{ id: 'ch-0001' }] },
      'generation.writer',
    )!
    expect(rendered).toContain('**Alice**')
    expect(rendered).toContain('- Where: childhood village')
    // What Alice knew is lasting, so the flashback still carries it.
    expect(rendered).toContain('The key is missing.')
    expect(rendered).toContain('**Background**\n- The missing key')
    expect(rendered).toContain('not tasks, promised beats')
    expect(rendered).not.toContain('ch-0001')
    expect(rendered).not.toContain('incorrect place')
    expect(rendered).not.toContain('great hall')
  })

  // Eight of twenty-three Timeline 10 analyses reported no focus at all. Taking
  // that as an assertion that nothing is relevant dropped every live thread to
  // dormant, and the Writer's unresolved-continuity section vanished with it.
  it('retains thread prominence when a later analysis supplies no update', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passages: Fragment[] = []
    for (let position = 1; position <= 2; position += 1) {
      const fragment = makeFragment({
        id: `pr-000${position}`,
        type: 'prose',
        order: position,
        content: `Passage ${position}`,
      })
      passages.push(fragment)
      await createFragment(dataDir, story.id, fragment)
    }

    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passages[0]),
      continuityProjection: projection({
        threadOperations: [{ threadKey: 'the_missing_key', action: 'open', label: 'The missing key' }],
        threadFocus: [{ threadKey: 'the_missing_key', visibility: 'foreground' }],
      }),
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0002', 2),
      sourceRevision: analysisSourceRevision(passages[1]),
      continuityProjection: projection(),
    })

    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: passages })

    expect(view?.liveThreads).toMatchObject([{ threadKey: 'the_missing_key', visibility: 'foreground' }])
    expect(renderContinuity({ continuityView: view }, 'generation.writer'))
      .toContain('**Foreground**\n- The missing key')
  })

  it('lets an explicit dormant update remove a thread from immediate writing context', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passages = [1, 2].map((position) => makeFragment({
      id: `pr-focus-${position}`, type: 'prose', order: position, content: `Passage ${position}`,
    }))
    for (const passage of passages) await createFragment(dataDir, story.id, passage)

    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[0].id, 1), sourceRevision: analysisSourceRevision(passages[0]),
      continuityProjection: projection({
        threadOperations: [{ threadKey: 'the_missing_key', action: 'open', label: 'The missing key' }],
        threadFocus: [{ threadKey: 'the_missing_key', visibility: 'foreground' }],
      }),
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[1].id, 2), sourceRevision: analysisSourceRevision(passages[1]),
      continuityProjection: projection({
        threadFocus: [{ threadKey: 'the_missing_key', visibility: 'dormant' }],
      }),
    })

    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: passages })
    expect(view?.liveThreads).toMatchObject([{ threadKey: 'the_missing_key', visibility: 'dormant' }])
    expect(renderContinuity({ continuityView: view }, 'generation.writer')).not.toContain('The missing key')
  })

  // Threads leave the live list only when resolved, so an uncapped list grows
  // for the life of the story — and every key rendered costs budget on the
  // analyst that reads it.
  it('caps the dormant thread tail without evicting a thread the latest passage still has in view', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passage = makeFragment({ id: 'pr-0001', type: 'prose', order: 1, content: 'Passage 1' })
    await createFragment(dataDir, story.id, passage)

    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passage),
      continuityProjection: projection({
        threadOperations: Array.from({ length: 40 }, (_, i) => ({
          threadKey: `thread_${String(i).padStart(2, '0')}`,
          action: 'open' as const,
          label: `Thread ${i}`,
        })),
        // The oldest thread is still in view, so it must survive the cap.
        threadFocus: [{ threadKey: 'thread_00', visibility: 'foreground' }],
      }),
    })

    const ledger = await buildContinuityLedger({ dataDir, storyId: story.id, activeProseFragments: [passage] })
    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: [passage] })

    expect(ledger!.liveThreads).toHaveLength(40)
    expect(view!.liveThreads).toHaveLength(24)
    expect(view!.liveThreads.map((thread) => thread.threadKey)).toContain('thread_00')
    // The retained dormant threads are the most recently updated ones.
    expect(view!.liveThreads.map((thread) => thread.threadKey)).toContain('thread_39')
    expect(view!.liveThreads.map((thread) => thread.threadKey)).not.toContain('thread_01')
    // The analyst may still address every live thread by key.
    expect(continuityRegistry({ continuityLedger: ledger, continuityView: view }).thread).toHaveLength(40)
  })

  it('folds the scene frame through overlays, returns, and elapsed time', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passages = Array.from({ length: 4 }, (_, index) => makeFragment({
      id: `pr-scene-${index + 1}`,
      type: 'prose',
      order: index + 1,
      content: `Scene passage ${index + 1}.`,
    }))
    for (const passage of passages) await createFragment(dataDir, story.id, passage)

    const scenes: ContinuityProjection['scene'][] = [
      {
        transition: 'cut', line: 'present',
        location: { key: 'courtyard', label: 'Courtyard' },
        time: { label: '10:00', certainty: 'exact', earliest: '2026-01-01T10:00:00.000Z', latest: '2026-01-01T10:00:00.000Z' },
      },
      { transition: 'advance', line: 'present', elapsed: { label: 'twenty minutes', minimumSeconds: 1200, maximumSeconds: 1200 } },
      { transition: 'enter-flashback', line: 'flashback', location: { key: 'village', label: 'Childhood village' } },
      { transition: 'return', line: 'present' },
    ]
    for (const [index, scene] of scenes.entries()) {
      await saveAnalysis(dataDir, story.id, {
        ...analysis(passages[index].id, index + 1),
        sourceRevision: analysisSourceRevision(passages[index]),
        continuityProjection: projection({ scene }),
      })
    }
    const frameAfter = async (count: number) => (await buildContinuityView({
      dataDir, storyId: story.id, activeProseFragments: passages.slice(0, count),
    }))?.currentScene

    expect(await frameAfter(2)).toMatchObject({
      line: 'present',
      location: { label: 'Courtyard' },
      time: { label: 'twenty minutes after 10:00', earliest: '2026-01-01T10:20:00.000Z', certainty: 'exact' },
    })
    expect(await frameAfter(3)).toMatchObject({ line: 'flashback', location: { label: 'Childhood village' } })
    expect(await frameAfter(4)).toMatchObject({
      line: 'present',
      location: { label: 'Courtyard' },
      time: { label: 'twenty minutes after 10:00' },
    })
  })

  /**
   * A key is a readable phrase by construction, so a label is wording the fold
   * can derive. Requiring one dropped the whole `open` — the thread never
   * existed — over a field that was never load-bearing.
   */
  // A record created after a subject was first reported by name, and a name
  // reported as both a character and an entity, are each one subject.
  it('gathers everything reported about a record under it, including before it existed', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await createFragment(dataDir, story.id, makeFragment({ id: 'ch-0009', type: 'character', name: 'Dr. Aris' }))
    const passages: Fragment[] = []
    for (let position = 1; position <= 2; position += 1) {
      const fragment = makeFragment({ id: `pr-000${position}`, type: 'prose', order: position, content: `Passage ${position}` })
      passages.push(fragment)
      await createFragment(dataDir, story.id, fragment)
    }
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passages[0]),
      continuityProjection: projection({
        liveStates: [
          { kind: 'character', key: 'dr_aris', name: 'Dr. Aris', present: true, set: [{ field: 'Where', value: 'the dais' }], add: [knows('He wrote the first journals.')], update: [] },
          { kind: 'entity', key: 'dr_aris', name: 'Dr. Aris', category: 'other', present: true, set: [], add: [{ id: liveStateItemId('Notes', 'Driven by fear.'), field: 'Notes', text: 'Driven by fear.' }], update: [] },
        ],
      }),
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0002', 2),
      sourceRevision: analysisSourceRevision(passages[1]),
      continuityProjection: projection({
        liveStates: [
          { kind: 'character', key: 'ch-0009', fragmentId: 'ch-0009', name: 'Dr. Aris', present: true, set: [{ field: 'Currently', value: 'kneeling' }], add: [], update: [] },
        ],
      }),
    })

    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: passages })

    expect(view?.liveStates).toHaveLength(1)
    expect(view?.liveStates?.[0]).toMatchObject({ kind: 'character', key: 'ch-0009', fragmentId: 'ch-0009', present: true })
    expect(view?.liveStates?.[0]).not.toHaveProperty('category')
    expect(view?.liveStates?.[0].fields.map((field) => field.value)).toEqual(['the dais', 'kneeling'])
    expect(view?.liveStates?.[0].items.map((item) => item.text)).toEqual(['He wrote the first journals.', 'Driven by fear.'])
  })

  it('opens a thread that arrived without a label, naming it from the key', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passage = makeFragment({ id: 'pr-0001', type: 'prose', order: 1, content: 'Passage 1' })
    await createFragment(dataDir, story.id, passage)

    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passage),
      continuityProjection: projection({
        threadOperations: [{ threadKey: 'who_sent_the_letter', action: 'open' }],
        threadFocus: [{ threadKey: 'who_sent_the_letter', visibility: 'foreground' }],
      }),
    })

    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: [passage] })

    expect(view!.liveThreads).toHaveLength(1)
    expect(view!.liveThreads[0]).toMatchObject({
      threadKey: 'who_sent_the_letter',
      label: 'Who sent the letter',
      visibility: 'foreground',
    })
    // The rendered block must never put a raw snake_case key in front of the author.
    expect(renderContinuity({ continuityView: view }, 'generation.writer'))
      .not.toContain('who_sent_the_letter')
  })
})

/**
 * One entry point, and the reader's identity picks the presentation. These cases
 * are the presentation table read back as behaviour: the same records rendered
 * incompatible ways, and no caller in a position to choose the wrong one.
 */
describe('renderContinuity', () => {
  const view = makeContinuityView({
    liveThreads: [
      makeLiveThread({ threadKey: 'the_open_wound', label: 'The open wound' }),
      makeLiveThread({ threadKey: 'who_sent_the_letter', label: 'Who sent the letter', visibility: 'dormant' }),
    ],
    liveStates: [
      makeLiveState({
        key: 'villain', fragmentId: undefined, name: 'Villain', present: true,
        fields: [makeLiveStateField('Where', 'the north tower')],
      }),
      makeLiveState({ name: 'Zinozi', items: [makeLiveStateItem('Knows', 'The key is missing.')] }),
      makeLiveState({ fragmentId: 'ch-0002', name: 'Mara', items: [makeLiveStateItem('Knows', 'The hero lied about the key.')] }),
    ],
  })

  it('returns nothing for authorial readers when there is nothing folded yet', () => {
    for (const reader of [
      'generation.writer',
      'generation.prewriter',
      'directions.suggest',
      'librarian.analyze',
      'librarian.chat',
      'librarian.refine',
      'librarian.optimize-character',
    ] as const) {
      expect(renderContinuity({ character: { id: 'ch-0001' } }, reader), reader).toBeNull()
    }
  })

  describe('the writer and the planner, who write the next passage', () => {
    it('hides dormant threads and frames the rest as limits', () => {
      for (const reader of ['generation.writer', 'generation.prewriter'] as const) {
        const rendered = renderContinuity({ continuityView: view }, reader)!
        expect(rendered, reader).toContain('The open wound')
        expect(rendered, reader).not.toContain('Who sent the letter')
        expect(rendered, reader).toContain('not tasks, promised beats')
        expect(rendered, reader).not.toContain('legitimate direction')
      }
    })

    it('shows the scene and, of those elsewhere, the pinned and recently active cast', () => {
      const rendered = renderContinuity({
        continuityView: view,
        stickyCharacters: [{ id: 'ch-0001' }],
      }, 'generation.writer')!
      expect(rendered).toContain('**Villain**')
      expect(rendered).toContain('the north tower')
      expect(rendered).toContain('**Zinozi** — not in the current scene')
      expect(rendered).toContain('The key is missing.')
      expect(rendered).not.toContain('Mara')
      expect(rendered).not.toContain('ch-0001')
    })
  })

  describe('fragment editors, which must not contradict accepted prose', () => {
    it('scopes generic refinement to its target-related and active cast', () => {
      const rendered = renderContinuity({
        continuityView: view,
        stickyCharacters: [{ id: 'ch-0001' }],
        targetFragment: { id: 'ch-0002', type: 'character' },
      }, 'librarian.refine')!
      expect(rendered).toContain('The hero lied')
      expect(rendered).toContain('The key is missing.')
      expect(rendered).toContain('Respect it as evidence while editing')
      expect(rendered).toContain('not facts to bake into the target fragment')
      expect(rendered).not.toContain('present scene naturally engages')
      expect(rendered).toContain('The open wound')
      expect(rendered).not.toContain('Who sent the letter')
    })

    it('includes characters referenced by a non-character refinement target', () => {
      const rendered = renderContinuity({
        continuityView: view,
        targetFragment: { id: 'kn-0001', type: 'knowledge', refs: ['ch-0002'] },
      }, 'librarian.refine')!
      expect(rendered).toContain('The hero lied')
      expect(rendered).not.toContain('The key is missing.')
    })

    it('scopes character optimization to its target regardless of pinning or recency', () => {
      const rendered = renderContinuity({
        continuityView: view,
        targetFragment: { id: 'ch-0002', type: 'character' },
      }, 'librarian.optimize-character')!
      expect(rendered).toContain('The hero lied')
      expect(rendered).not.toContain('The key is missing.')
      expect(rendered).toContain('Respect it as evidence while editing')
    })
  })

  describe('directions, which only proposes', () => {
    it('offers every thread as latent material', () => {
      const rendered = renderContinuity({ continuityView: view }, 'directions.suggest')!
      expect(rendered).toContain('The open wound')
      expect(rendered).toContain('**Dormant**\n- Who sent the letter')
      expect(rendered).toContain('has simply gone quiet, not been resolved')
      expect(rendered).toContain('None of them is owed an answer')
      // The constraint framing is the opposite instruction; both at once is noise.
      expect(rendered).not.toContain('not tasks, promised beats')
    })
  })

  describe('the librarian', () => {
    it('reads the whole ledger in chat, including everyone elsewhere and quiet threads', () => {
      const rendered = renderContinuity({ continuityView: view }, 'librarian.chat')!
      expect(rendered).toContain('the whole ledger')
      expect(rendered).toContain('The key is missing.')
      expect(rendered).toContain('The hero lied')
      expect(rendered).toContain('**Dormant**\n- Who sent the letter')
    })

    it('shows the analyst the ids and numbers it reports against, and threads by the label it repeats', () => {
      const source = { continuityView: view, stickyCharacters: [{ id: 'ch-0001' }] }
      const rendered = renderContinuity(source, 'librarian.analyze')!
      expect(rendered).toContain('\n- The open wound')
      expect(rendered).not.toContain('the_open_wound')
      expect(rendered).toContain('**Zinozi** (`ch-0001`)')
      expect(rendered).toContain('  - [1] The key is missing.')
      expect(continuityRegistry(source).items).toEqual([
        expect.objectContaining({ index: 1, subjectKey: 'ch-0001', text: 'The key is missing.' }),
      ])
    })
  })

  describe('character chat, which is the character', () => {
    const source = { continuityView: view, character: { id: 'ch-0001' } }

    it('gives one character their own state', () => {
      const rendered = renderContinuity(source, 'character-chat.chat')!
      expect(rendered).toContain('The key is missing.')
      expect(rendered).not.toContain('The hero lied')
    })

    // A character handed the authorial records answers from offstage facts, which
    // is the one failure this presentation exists to prevent.
    it('withholds other characters, open threads, and keys that belong to the author', () => {
      const rendered = renderContinuity(source, 'character-chat.chat')!
      expect(rendered).not.toContain('north tower')
      expect(rendered).not.toContain('Who sent the letter')
      expect(rendered).not.toContain('ch-0001')
    })

    it('states the boundary even when the fold recorded nothing for the character', () => {
      const rendered = renderContinuity({ continuityView: view, character: { id: 'ch-9999' } }, 'character-chat.chat')!
      expect(rendered).toContain('you have not learned it')
      expect(rendered).toContain('nothing beyond your character sheet')
    })

    it('states the boundary before any continuity has been folded', () => {
      const rendered = renderContinuity({ character: { id: 'ch-0001' } }, 'character-chat.chat')!
      expect(rendered).toContain('you have not learned it')
      expect(rendered).toContain('nothing beyond your character sheet')
    })

    it('renders nothing when no character has been chosen', () => {
      expect(renderContinuity({ continuityView: view }, 'character-chat.chat')).toBeNull()
    })
  })

  describe('live states', () => {
    let dataDir: string
    let cleanup: () => Promise<void>
    const story = makeStory()

    beforeEach(async () => {
      const tmp = await createTempDir()
      dataDir = tmp.path
      cleanup = tmp.cleanup
      await createStory(dataDir, story)
    })

    afterEach(async () => {
      await cleanup()
    })

    async function passage(order: number, overrides: Partial<ContinuityProjection> = {}): Promise<Fragment> {
      const fragment = makeFragment({ id: `pr-000${order}`, type: 'prose', order, content: `Passage ${order}` })
      await createFragment(dataDir, story.id, fragment)
      await saveAnalysis(dataDir, story.id, {
        ...analysis(fragment.id, order),
        sourceRevision: analysisSourceRevision(fragment),
        continuityProjection: projection(overrides),
      })
      return fragment
    }

    function report(key: string, name: string, changes: Partial<LiveStateReport> = {}): LiveStateReport {
      return {
        kind: 'character',
        key,
        ...(key.startsWith('ch-') ? { fragmentId: key } : {}),
        name,
        present: true,
        set: [],
        add: [],
        update: [],
        ...changes,
      }
    }

    const entry = (field: string, text: string) => ({ id: liveStateItemId(field, text), field, text })

    async function fold(passages: Fragment[]) {
      const ledger = await buildContinuityLedger({ dataDir, storyId: story.id, activeProseFragments: passages })
      const subject = (key: string) => ledger?.liveStates?.find((candidate) => candidate.key === key)
      const field = (key: string, name: string) => subject(key)?.fields.find((candidate) => candidate.field === name)
      return { ledger, view: projectContinuityView(ledger), subject, field }
    }

    it('sets and clears fields, and merges an entry restated with different spelling', async () => {
      const first = await passage(1, { liveStates: [report('ch-0001', 'Alice', {
        set: [
          { field: 'Currently', value: 'catching her breath against the doorframe' },
          { field: 'Appearance', value: 'travel cloak' },
          { field: 'Condition', value: 'sprained ankle' },
        ],
        add: [entry('Knows', 'Gate was left unlatched'), entry('Secrets', 'Carrying the map')],
      })] })
      const second = await passage(2, { liveStates: [report('ch-0001', 'Alice', {
        set: [
          { field: 'Currently', value: 'sitting beside the hearth' },
          { field: 'Condition', value: '' },
          { field: 'gear', value: 'iron dagger' },
        ],
        add: [entry('Knows', 'Guards were absent'), entry('Knows', 'gate was left unlatched.')],
      })] })

      const { subject, view } = await fold([first, second])
      const alice = subject('ch-0001')!
      expect(alice.present).toBe(true)
      expect(alice.fields.map((field) => [field.field, field.value])).toEqual([
        ['Currently', 'sitting beside the hearth'],
        ['Appearance', 'travel cloak'],
        ['gear', 'iron dagger'],
      ])
      expect(alice.fields.find((field) => field.field === 'gear')).toMatchObject({ holds: 'lastKnown', visibility: 'inner' })
      expect(alice.items.map((item) => item.text)).toEqual(['Gate was left unlatched', 'Carrying the map', 'Guards were absent'])

      const writer = renderContinuity({ continuityView: view }, 'generation.writer')!
      expect(writer).toContain('### Where things stand')
      expect(writer).toContain('- Currently: sitting beside the hearth')
      expect(writer).not.toContain('sprained ankle')
      expect(writer).not.toContain('[1]')
      const analyst = renderContinuity({ continuityView: view }, 'librarian.analyze')!
      expect(analyst).toContain('  - [1] Gate was left unlatched')
      expect(analyst).toContain('  - [3] Guards were absent')

      const own = renderContinuity({ continuityView: view, character: { id: 'ch-0001' } }, 'character-chat.chat')!
      expect(own).toContain('Carrying the map')
      expect(own).toContain('- Currently: sitting beside the hearth')
    })

    it('ends an entry with what happened to it and keeps it as history', async () => {
      const secret = entry('Secrets', 'Carrying the map')
      const belief = entry('Knows', 'The guards are loyal')
      const first = await passage(1, { liveStates: [
        report('ch-0001', 'Alice', { add: [secret, belief] }),
        report('ch-0002', 'Bob'),
      ] })
      const second = await passage(2, { liveStates: [
        report('ch-0001', 'Alice', {
          update: [
            { id: secret.id, happened: 'revealed', to: ['ch-0002'] },
            { id: belief.id, happened: 'changed', now: { id: liveStateItemId('Knows', 'The guards were bribed'), text: 'The guards were bribed' } },
          ],
        }),
        report('ch-0002', 'Bob', { add: [entry('Knows', 'Alice carries the map')] }),
      ] })

      const { subject, view } = await fold([first, second])
      const alice = subject('ch-0001')!
      expect(alice.items.map((item) => item.text)).toEqual(['The guards were bribed'])
      expect(alice.ended).toEqual([
        expect.objectContaining({ text: 'Carrying the map', happened: 'revealed', to: ['ch-0002'] }),
        expect.objectContaining({ text: 'The guards are loyal', happened: 'changed', now: 'The guards were bribed' }),
      ])
      const writer = renderContinuity({ continuityView: view }, 'generation.writer')!
      expect(writer).toContain('- No longer (Secrets): Carrying the map — revealed to Bob')
    })

    it('treats the reported cast as the scene roster while remembering who left', async () => {
      const first = await passage(1, { liveStates: [
        report('ch-0001', 'Alice', { set: [{ field: 'Currently', value: 'leaning on the gate' }, { field: 'Appearance', value: 'red coat' }] }),
        report('ch-0002', 'Bob', { set: [{ field: 'Currently', value: 'watching the road' }] }),
      ] })
      const second = await passage(2, { liveStates: [
        report('ch-0002', 'Bob', { set: [{ field: 'Currently', value: 'alone at the gate' }] }),
      ] })

      const { subject, field, view } = await fold([first, second])
      expect(subject('ch-0001')?.present).toBe(false)
      expect(field('ch-0001', 'Currently')).toBeUndefined()
      expect(field('ch-0001', 'Appearance')?.value).toBe('red coat')

      const writer = renderContinuity({ continuityView: view }, 'generation.writer')!
      expect(writer).toContain('alone at the gate')
      expect(writer).not.toContain('red coat')
      const scoped = renderContinuity({ continuityView: view, recentCharacters: [{ id: 'ch-0001' }] }, 'generation.writer')!
      expect(scoped).toContain('**Alice** — not in the current scene')
      expect(scoped).toContain('- Appearance: red coat')
    })

    it('ends the moment at a scene boundary and ages what was last known', async () => {
      const first = await passage(1, { liveStates: [report('ch-0001', 'Alice', {
        set: [{ field: 'Currently', value: 'pacing' }, { field: 'Where', value: 'the archive' }],
      })] })
      const second = await passage(2, { scene: { transition: 'cut', line: 'present' } })
      const third = await passage(3, {
        scene: { transition: 'advance', line: 'present' },
        liveStates: [report('ch-0001', 'Alice')],
      })

      const { field, view } = await fold([first, second, third])
      expect(field('ch-0001', 'Currently')).toBeUndefined()
      expect(field('ch-0001', 'Where')).toMatchObject({ value: 'the archive', scenesAgo: 2 })
      expect(renderContinuity({ continuityView: view }, 'generation.writer')).toContain('- Where: the archive (2 scenes ago)')
    })

    it('keeps a flashback from replacing the present while carrying back what was learned in it', async () => {
      const present = await passage(1, { liveStates: [report('ch-0001', 'Alice', {
        set: [{ field: 'Where', value: 'the tower' }, { field: 'Condition', value: 'rested' }],
        add: [entry('Knows', 'The heir is missing')],
      })] })
      const flashback = await passage(2, {
        scene: { transition: 'enter-flashback', line: 'flashback' },
        liveStates: [report('ch-0001', 'Alice', {
          set: [{ field: 'Where', value: 'her childhood home' }, { field: 'Condition', value: 'feverish' }],
          add: [entry('Knows', 'Her mother hid the key')],
        })],
      })
      const stillBack = await passage(3, {
        scene: { transition: 'continue', line: 'flashback' },
        liveStates: [report('ch-0001', 'Alice')],
      })
      const back = await passage(4, {
        scene: { transition: 'return', line: 'present' },
        liveStates: [report('ch-0001', 'Alice')],
      })

      const during = await fold([present, flashback, stillBack])
      expect(during.field('ch-0001', 'Where')?.value).toBe('her childhood home')
      expect(during.field('ch-0001', 'Condition')?.value).toBe('feverish')

      const after = await fold([present, flashback, stillBack, back])
      expect(after.field('ch-0001', 'Where')?.value).toBe('the tower')
      expect(after.field('ch-0001', 'Condition')?.value).toBe('rested')
      expect(after.subject('ch-0001')?.items.map((item) => item.text)).toEqual(['The heir is missing', 'Her mother hid the key'])
    })

    it('discards what a flash-forward shows when the story returns', async () => {
      const present = await passage(1, { liveStates: [report('ch-0001', 'Alice', { add: [entry('Knows', 'The heir is missing')] })] })
      const ahead = await passage(2, {
        scene: { transition: 'enter-flash-forward', line: 'flash-forward' },
        liveStates: [report('ch-0001', 'Alice', { add: [entry('Knows', 'The heir was found in the south')] })],
      })
      const back = await passage(3, { scene: { transition: 'return', line: 'present' }, liveStates: [report('ch-0001', 'Alice')] })

      const { subject } = await fold([present, ahead, back])
      expect(subject('ch-0001')?.items.map((item) => item.text)).toEqual(['The heir is missing'])
    })

    it('applies an author correction after its passage, where a rerun analysis cannot erase it', async () => {
      const knows = entry('Knows', 'The gate was unlatched')
      const first = await passage(1, { liveStates: [report('ch-0001', 'Alice', { add: [knows] })] })
      await appendLiveStateEdit(dataDir, story.id, {
        kind: 'character',
        key: 'ch-0001',
        fragmentId: 'ch-0001',
        name: 'Alice',
        id: 'lse-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        afterFragmentId: first.id,
        set: [{ field: 'Wants', value: 'to leave the city' }],
        add: [],
        update: [],
        revise: [{ id: knows.id, text: 'The gate was unlatched from inside' }],
        remove: [],
      })
      const second = await passage(2, { liveStates: [report('ch-0001', 'Alice', {
        set: [{ field: 'Currently', value: 'packing' }],
      })] })

      const { subject, field } = await fold([first, second])
      expect(field('ch-0001', 'Wants')?.value).toBe('to leave the city')
      expect(field('ch-0001', 'Currently')?.value).toBe('packing')
      expect(subject('ch-0001')?.items).toEqual([expect.objectContaining({ id: knows.id, text: 'The gate was unlatched from inside' })])
    })

    it('folds through a passage to show what stood there, without later passages or corrections', async () => {
      const first = await passage(1, { liveStates: [report('ch-0001', 'Alice', { set: [{ field: 'Where', value: 'the harbour' }] })] })
      const second = await passage(2, { liveStates: [report('ch-0001', 'Alice', { set: [{ field: 'Where', value: 'the archive' }] })] })
      await appendLiveStateEdit(dataDir, story.id, {
        kind: 'character', key: 'ch-0001', fragmentId: 'ch-0001', name: 'Alice',
        id: 'lse-late', createdAt: '2026-01-01T00:00:00.000Z', afterFragmentId: second.id,
        set: [{ field: 'Wants', value: 'to leave the city' }], add: [], update: [], revise: [], remove: [],
      })

      const whole = await buildContinuityLedger({ dataDir, storyId: story.id, activeProseFragments: [first, second] })
      const atFirst = await buildContinuityLedger({
        dataDir, storyId: story.id, activeProseFragments: [first, second], throughFragmentId: first.id,
      })
      const fieldsOf = (ledger: ContinuityLedger | undefined) => Object.fromEntries(
        (ledger?.liveStates?.[0]?.fields ?? []).map((field) => [field.field, field.value]),
      )

      expect(fieldsOf(atFirst)).toEqual({ Where: 'the harbour' })
      expect(fieldsOf(whole)).toEqual({ Where: 'the archive', Wants: 'to leave the city' })
      // The partial fold does not displace the cached whole chain.
      expect(fieldsOf(await buildContinuityLedger({ dataDir, storyId: story.id, activeProseFragments: [first, second] })))
        .toEqual({ Where: 'the archive', Wants: 'to leave the city' })
    })
  })
})
