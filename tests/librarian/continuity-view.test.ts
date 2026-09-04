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
  makeCharacterKnowledge,
  makeContinuityView,
  makeLiveThread,
  makeTestSettings,
} from '../setup'
import { createStory, createFragment, getFragment } from '@/server/fragments/storage'
import { saveAnalysis, type LibrarianAnalysis } from '@/server/librarian/storage'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'
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

  it('does not turn legacy summary observations into a second Writer memory channel', async () => {
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
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [{
          stateKey: 'alice_location', action: 'set',
          subject: { key: 'alice', label: 'Alice' }, facet: 'location', value: 'great hall',
          certainty: 'explicit', scope: 'cross-scene', evidenceSegments: [1], evidenceText: passage.content,
        }],
        threadOperations: [], threadFocus: [], knowledgeOperations: [],
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 2),
      summaryUpdate: 'A partial rerun stopped before completion.',
    })

    const view = await buildContinuityView({
      dataDir, storyId: story.id, activeProseFragments: [passage],
    })

    expect(view?.currentState).toMatchObject([{ stateKey: 'alice_location', value: 'great hall' }])
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
      continuityProjection: {
        version: 2,
        // The schema default. Making no claim about time is not a claim to have
        // stepped out of the present, so the state it reported still counts.
        scene: { transition: 'uncertain', line: 'uncertain' },
        stateOperations: [{
          stateKey: 'alice_location',
          action: 'set',
          subject: { key: 'alice', label: 'Alice' },
          facet: 'location',
          certainty: 'explicit',
          scope: 'cross-scene',
          value: 'the great hall',
          evidenceSegments: [1], evidenceText: 'Prose 1',
        }],
        threadOperations: [],
        threadFocus: [],
        knowledgeOperations: [],
      },
    })

    const view = await buildContinuityView({
      dataDir,
      storyId: story.id,
      activeProseFragments: [passage],
    })

    expect(view?.currentState).toMatchObject([{ stateKey: 'alice_location', value: 'the great hall' }])
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
      continuityProjection: {
        version: 2,
        // What the removed `concurrent` relation was being used to say.
        scene: { transition: 'continue', line: 'present', time: { label: 'during the First Address', certainty: 'exact' } },
        stateOperations: [{
          stateKey: 'alice_location',
          action: 'set',
          subject: { key: 'alice', label: 'Alice' },
          facet: 'location',
          certainty: 'explicit',
          scope: 'cross-scene',
          value: 'the rail',
          evidenceSegments: [1], evidenceText: 'Prose 1',
        }],
        threadOperations: [],
        threadFocus: [],
        knowledgeOperations: [],
      },
    })

    const view = await buildContinuityView({
      dataDir,
      storyId: story.id,
      activeProseFragments: [passage],
    })
    const rendered = renderContinuity({ continuityView: view }, 'generation.writer')!

    // The occasion is the useful part; `forward` is not worth naming beside it.
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
      record.continuityProjection = {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [{
          stateKey: `state_${position}`,
          action: 'set',
          subject: { key: `subject_${position}`, label: `Subject ${position}` },
          facet: 'status',
          certainty: 'explicit',
          scope: 'cross-scene',
          value: `Value ${position}`,
          evidenceSegments: [1], evidenceText: `Prose ${position}`,
        }],
        threadOperations: [],
        threadFocus: [],
        knowledgeOperations: [],
      }
      await saveAnalysis(dataDir, story.id, record)
      passages.push((await getFragment(dataDir, story.id, fragmentId))!)
    }

    const first = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: passages })
    expect(first?.currentState).toHaveLength(3)

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

    expect(second?.currentState.map((entry) => entry.stateKey)).toEqual(['state_1', 'state_2'])
  })

  it('folds keyed state, thread focus, temporal frames, and character knowledge while rejecting stale sources', async () => {
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
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [{
          stateKey: 'alice.location',
          action: 'set',
          subject: { key: 'alice', label: 'Alice' },
          facet: 'location',
          certainty: 'explicit',
          scope: 'cross-scene',
          value: 'north gate',
          evidenceSegments: [1], evidenceText: 'Passage 1',
        }],
        threadOperations: [{
          threadKey: 'missing-key',
          action: 'open',
          label: 'The missing key',
          relatedFragmentIds: ['ch-0001'],
          evidenceSegments: [1], evidenceText: 'Passage 1',
        }],
        threadFocus: [{ threadKey: 'missing-key', visibility: 'foreground' }],
        knowledgeOperations: [{
          characterId: 'ch-0001',
          knowledgeKey: 'key.missing',
          action: 'learn',
          fact: 'The key is missing.',
          acquisition: 'witnessed',
          evidenceSegments: [1], evidenceText: 'Passage 1',
        }],
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0002', 2),
      sourceRevision: analysisSourceRevision(passages[1]),
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [{
          stateKey: 'alice.location',
          action: 'set',
          subject: { key: 'alice', label: 'Alice' },
          facet: 'location',
          certainty: 'explicit',
          scope: 'cross-scene',
          value: 'great hall',
          evidenceSegments: [1], evidenceText: 'Passage 2',
        }],
        threadOperations: [{
          threadKey: 'missing-key',
          action: 'advance',
          note: 'The search reached the great hall.',
          relatedFragmentIds: [],
          evidenceSegments: [1], evidenceText: 'Passage 2',
        }],
        threadFocus: [],
        knowledgeOperations: [],
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0003', 3),
      sourceRevision: analysisSourceRevision(passages[2]),
      continuityProjection: {
        version: 2,
        scene: { transition: 'enter-flashback', line: 'flashback', time: { label: 'years earlier', certainty: 'approximate' }, evidenceSegments: [1], evidenceText: 'Passage 3' },
        stateOperations: [{
          stateKey: 'alice.location',
          action: 'set',
          subject: { key: 'alice', label: 'Alice' },
          facet: 'location',
          certainty: 'explicit',
          scope: 'cross-scene',
          value: 'childhood village',
          evidenceSegments: [1], evidenceText: 'Passage 3',
        }],
        threadOperations: [],
        threadFocus: [{ threadKey: 'missing-key', visibility: 'background' }],
        knowledgeOperations: [],
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0004', 4),
      sourceRevision: { ...analysisSourceRevision(passages[3]), contentHash: 'stale' },
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [{
          stateKey: 'alice.location',
          action: 'set',
          subject: { key: 'alice', label: 'Alice' },
          facet: 'location',
          certainty: 'explicit',
          scope: 'cross-scene',
          value: 'incorrect place',
          evidenceSegments: [1], evidenceText: 'Passage 4',
        }],
        threadOperations: [],
        threadFocus: [],
        knowledgeOperations: [],
      },
    })

    const view = await buildContinuityView({
      dataDir,
      storyId: story.id,
      activeProseFragments: passages,
    })

    // Keys are normalized on the fold, so projections stored under the earlier
    // dotted/hyphenated spellings still resolve to one identity.
    expect(view?.currentState).toMatchObject([{ stateKey: 'alice_location', value: 'childhood village' }])
    expect(view?.liveThreads).toMatchObject([{
      threadKey: 'missing_key',
      visibility: 'background',
      note: 'The search reached the great hall.',
    }])
    expect(view?.characterKnowledge).toMatchObject([{
      characterId: 'ch-0001',
      knowledgeKey: 'key_missing',
      fact: 'The key is missing.',
    }])
    expect(view?.currentScene).toMatchObject({ line: 'flashback', time: { label: 'years earlier' } })
    expect(view?.staleProjectionCount).toBe(1)

    const rendered = renderContinuity(
      { continuityView: view, stickyCharacters: [{ id: 'ch-0001', name: 'Alice' }] },
      'generation.writer',
    )!
    expect(rendered).toContain('Alice — location: childhood village')
    expect(rendered).toContain('[background] The missing key')
    expect(rendered).toContain('not tasks, promised beats')
    expect(rendered).toContain('Alice knows or believes:')
    expect(rendered).not.toContain('ch-0001 knows or believes:')
    expect(rendered).toContain('The key is missing.')
    expect(rendered).not.toContain('Present:')
    expect(rendered).not.toContain('Direct witnesses:')
    expect(rendered).not.toContain('incorrect place')
    expect(rendered).not.toContain('Alice — location: great hall')
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
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [],
        threadOperations: [{
          threadKey: 'the_missing_key',
          action: 'open',
          label: 'The missing key',
          relatedFragmentIds: [],
          evidenceSegments: [1], evidenceText: 'Passage 1',
        }],
        threadFocus: [{ threadKey: 'the_missing_key', visibility: 'foreground' }],
        knowledgeOperations: [],
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0002', 2),
      sourceRevision: analysisSourceRevision(passages[1]),
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [],
        threadOperations: [],
        threadFocus: [],
        knowledgeOperations: [],
      },
    })

    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: passages })

    expect(view?.liveThreads).toMatchObject([{ threadKey: 'the_missing_key', visibility: 'foreground' }])
    expect(renderContinuity({ continuityView: view }, 'generation.writer'))
      .toContain('[foreground] The missing key')
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
      continuityProjection: {
        version: 2, scene: { transition: 'continue', line: 'present' }, stateOperations: [],
        threadOperations: [{
          threadKey: 'the_missing_key', action: 'open', label: 'The missing key',
          relatedFragmentIds: [], evidenceSegments: [1], evidenceText: passages[0].content,
        }],
        threadFocus: [{ threadKey: 'the_missing_key', visibility: 'foreground' }],
        knowledgeOperations: [],
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[1].id, 2), sourceRevision: analysisSourceRevision(passages[1]),
      continuityProjection: {
        version: 2, scene: { transition: 'continue', line: 'present' }, stateOperations: [],
        threadOperations: [],
        threadFocus: [{ threadKey: 'the_missing_key', visibility: 'dormant' }],
        knowledgeOperations: [],
      },
    })

    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: passages })
    expect(view?.liveThreads).toMatchObject([{ threadKey: 'the_missing_key', visibility: 'dormant' }])
    expect(renderContinuity({ continuityView: view }, 'generation.writer')).not.toContain('The missing key')
  })

  // Threads leave the live list only when resolved, so an uncapped list grows
  // for the life of the story — and it remains available in the analysis
  // tool schema, where every key costs budget on a small model.
  it('caps the dormant thread tail without evicting a thread the latest passage still has in view', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passage = makeFragment({ id: 'pr-0001', type: 'prose', order: 1, content: 'Passage 1' })
    await createFragment(dataDir, story.id, passage)

    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passage),
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [],
        threadOperations: Array.from({ length: 40 }, (_, i) => ({
          threadKey: `thread_${String(i).padStart(2, '0')}`,
          action: 'open' as const,
          label: `Thread ${i}`,
          relatedFragmentIds: [],
          evidenceSegments: [1],
          evidenceText: 'Passage 1',
        })),
        // The oldest thread is still in view, so it must survive the cap.
        threadFocus: [{ threadKey: 'thread_00', visibility: 'foreground' }],
        knowledgeOperations: [],
      },
    })

    const ledger = await buildContinuityLedger({ dataDir, storyId: story.id, activeProseFragments: [passage] })
    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: [passage] })

    expect(ledger!.liveThreads).toHaveLength(40)
    expect(view!.liveThreads).toHaveLength(24)
    expect(view!.liveThreads.map((thread) => thread.threadKey)).toContain('thread_00')
    // The retained dormant threads are the most recently updated ones.
    expect(view!.liveThreads.map((thread) => thread.threadKey)).toContain('thread_39')
    expect(view!.liveThreads.map((thread) => thread.threadKey)).not.toContain('thread_01')
  })

  it('retains every live state identity while bounding values in prompt projections', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passage = makeFragment({ id: 'pr-0001', type: 'prose', order: 1, content: 'Passage 1' })
    await createFragment(dataDir, story.id, passage)

    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passage),
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: Array.from({ length: 40 }, (_, index) => ({
          stateKey: `state_${String(index).padStart(2, '0')}`,
          action: 'set' as const,
          subject: { key: `subject_${index}`, label: `Subject ${index}` },
          facet: 'status',
          certainty: 'explicit',
          scope: 'cross-scene',
          value: `Value ${index}`,
          evidenceSegments: [1],
          evidenceText: 'Passage 1',
        })),
        threadOperations: [],
        threadFocus: [],
        knowledgeOperations: [],
      },
    })

    const ledger = await buildContinuityLedger({ dataDir, storyId: story.id, activeProseFragments: [passage] })
    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: [passage] })
    const registry = continuityRegistry({ continuityLedger: ledger, continuityView: view })

    expect(ledger!.currentState).toHaveLength(40)
    expect(view!.currentState).toHaveLength(24)
    expect(view!.currentState[0].stateKey).toBe('state_16')
    expect(registry.state).toHaveLength(40)
    expect(registry.state[0]).toMatchObject({ index: 1, key: 'state_00', label: 'Subject 0 — status' })
    expect(registry.state[0].detail).toBeUndefined()
    expect(registry.state[39]).toMatchObject({ index: 40, key: 'state_39', detail: 'Value 39' })

    const analyze = renderContinuity(
      { continuityLedger: ledger, continuityView: view },
      'librarian.analyze',
    )!
    const writer = renderContinuity(
      { continuityLedger: ledger, continuityView: view },
      'generation.writer',
    )!
    expect(analyze).toContain('[1] state_00 | Subject 0 — status')
    expect(analyze).not.toContain('Subject 0 — status | Value 0')
    expect(analyze).toContain('[40] state_39 | Subject 39 — status | Value 39')
    expect(writer).not.toContain('Subject 0 — status: Value 0')
    expect(writer).toContain('Subject 39 — status: Value 39')
  })

  it('folds scene lifecycle, temporal overlays, returns, and conservative expiry', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passages = Array.from({ length: 6 }, (_, index) => makeFragment({
      id: `pr-scene-${index + 1}`,
      type: 'prose',
      order: index + 1,
      content: `Scene passage ${index + 1}.`,
    }))
    for (const passage of passages) await createFragment(dataDir, story.id, passage)

    const emptyLanes = { threadOperations: [], threadFocus: [], knowledgeOperations: [] }
    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[0].id, 1),
      sourceRevision: analysisSourceRevision(passages[0]),
      continuityProjection: {
        version: 2,
        scene: {
          transition: 'cut',
          line: 'present',
          time: {
            label: '10:00', certainty: 'exact',
            earliest: '2026-01-01T10:00:00.000Z', latest: '2026-01-01T10:00:00.000Z',
          },
        },
        stateOperations: [
          {
            stateKey: 'courtyard_weather', action: 'set',
            subject: { key: 'courtyard', label: 'Courtyard' }, facet: 'weather', value: 'steady rain',
            certainty: 'explicit',
            scope: 'scene', evidenceSegments: [1], evidenceText: passages[0].content,
          },
          {
            stateKey: 'alice_injury', action: 'set',
            subject: { key: 'alice', label: 'Alice' }, facet: 'injury', value: 'sprained wrist',
            certainty: 'explicit',
            scope: 'cross-scene', evidenceSegments: [1], evidenceText: passages[0].content,
          },
          {
            stateKey: 'alice_invisibility', action: 'set',
            subject: { key: 'alice', label: 'Alice' }, facet: 'visibility', value: 'invisible',
            certainty: 'explicit',
            scope: 'cross-scene',
            until: {
              label: '10:30', certainty: 'exact',
              earliest: '2026-01-01T10:30:00.000Z', latest: '2026-01-01T10:30:00.000Z',
            },
            evidenceSegments: [1], evidenceText: passages[0].content,
          },
        ],
        ...emptyLanes,
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[1].id, 2), sourceRevision: analysisSourceRevision(passages[1]),
      continuityProjection: {
        version: 2,
        scene: {
          transition: 'advance', line: 'present',
          elapsed: { label: 'twenty minutes', minimumSeconds: 1200, maximumSeconds: 1200 },
        },
        stateOperations: [], ...emptyLanes,
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[2].id, 3), sourceRevision: analysisSourceRevision(passages[2]),
      continuityProjection: {
        version: 2,
        scene: { transition: 'enter-flashback', line: 'flashback' },
        stateOperations: [{
          stateKey: 'alice_location', action: 'set',
          subject: { key: 'alice', label: 'Alice' }, facet: 'location', value: 'childhood village',
          certainty: 'explicit',
          scope: 'scene', evidenceSegments: [1], evidenceText: passages[2].content,
        }],
        ...emptyLanes,
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[3].id, 4), sourceRevision: analysisSourceRevision(passages[3]),
      continuityProjection: {
        version: 2,
        scene: { transition: 'return', line: 'present' },
        stateOperations: [], ...emptyLanes,
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[4].id, 5), sourceRevision: analysisSourceRevision(passages[4]),
      continuityProjection: {
        version: 2,
        scene: {
          transition: 'advance', line: 'present',
          elapsed: { label: 'eleven minutes', minimumSeconds: 660, maximumSeconds: 660 },
        },
        stateOperations: [], ...emptyLanes,
      },
    })
    await saveAnalysis(dataDir, story.id, {
      ...analysis(passages[5].id, 6), sourceRevision: analysisSourceRevision(passages[5]),
      continuityProjection: {
        version: 2,
        scene: { transition: 'cut', line: 'present' },
        stateOperations: [], ...emptyLanes,
      },
    })

    const duringFlashback = await buildContinuityView({
      dataDir, storyId: story.id, activeProseFragments: passages.slice(0, 3),
    })
    expect(duringFlashback?.currentScene?.line).toBe('flashback')
    expect(duringFlashback?.currentState.map((entry) => entry.stateKey)).toEqual(['alice_location'])

    const afterReturn = await buildContinuityView({
      dataDir, storyId: story.id, activeProseFragments: passages.slice(0, 4),
    })
    expect(afterReturn?.currentScene?.line).toBe('present')
    expect(afterReturn?.currentState.map((entry) => entry.stateKey)).toEqual([
      'courtyard_weather', 'alice_injury', 'alice_invisibility',
    ])

    const afterExpiry = await buildContinuityView({
      dataDir, storyId: story.id, activeProseFragments: passages.slice(0, 5),
    })
    expect(afterExpiry?.currentState.map((entry) => entry.stateKey)).toEqual([
      'courtyard_weather', 'alice_injury',
    ])

    const afterCut = await buildContinuityView({
      dataDir, storyId: story.id, activeProseFragments: passages,
    })
    expect(afterCut?.currentState.map((entry) => entry.stateKey)).toEqual(['alice_injury'])
  })

  /**
   * A key is a readable phrase by construction, so a label is wording the fold
   * can derive. Requiring one dropped the whole `open` — the thread never
   * existed — over a field that was never load-bearing.
   */
  it('opens a thread that arrived without a label, naming it from the key', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    const passage = makeFragment({ id: 'pr-0001', type: 'prose', order: 1, content: 'Passage 1' })
    await createFragment(dataDir, story.id, passage)

    await saveAnalysis(dataDir, story.id, {
      ...analysis('pr-0001', 1),
      sourceRevision: analysisSourceRevision(passage),
      continuityProjection: {
        version: 2,
        scene: { transition: 'continue', line: 'present' },
        stateOperations: [],
        threadOperations: [{
          threadKey: 'who_sent_the_letter',
          action: 'open',
          relatedFragmentIds: [],
          evidenceSegments: [1],
          evidenceText: 'Passage 1',
        }],
        threadFocus: [{ threadKey: 'who_sent_the_letter', visibility: 'foreground' }],
        knowledgeOperations: [],
      },
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
      .not.toContain('who_sent_the_letter |')
  })
})

/**
 * One entry point, and the reader's identity picks the presentation. These cases
 * are the presentation table read back as behaviour: the same records rendered
 * five incompatible ways, and no caller in a position to choose the wrong one.
 */
describe('renderContinuity', () => {
  const view = makeContinuityView({
    liveThreads: [
      makeLiveThread({ threadKey: 'the_open_wound', label: 'The open wound' }),
      makeLiveThread({
        threadKey: 'who_sent_the_letter',
        label: 'Who sent the letter',
        note: 'Never followed up.',
        visibility: 'dormant',
      }),
    ],
    characterKnowledge: [
      makeCharacterKnowledge({ knowledgeKey: 'key_missing', fact: 'The key is missing.' }),
      makeCharacterKnowledge({
        characterId: 'ch-0002',
        knowledgeKey: 'hero_lied',
        fact: 'The hero lied about the key.',
        acquisition: 'told',
      }),
    ],
  })

  it('returns nothing for authorial readers when there is nothing folded yet', () => {
    for (const reader of [
      'generation.writer',
      'generation.prewriter',
      'directions.suggest',
      'librarian.analyze',
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

    it('scopes awareness to the pinned and recently active cast', () => {
      const rendered = renderContinuity({
        continuityView: view,
        stickyCharacters: [{ id: 'ch-0001', name: 'Zinozi' }],
      }, 'generation.writer')!
      expect(rendered).toContain('Zinozi knows or believes:')
      expect(rendered).not.toContain('ch-0001 knows or believes:')
      expect(rendered).toContain('The key is missing.')
      expect(rendered).not.toContain('The hero lied')
    })
  })

  describe('fragment editors, which must not contradict accepted prose', () => {
    it('scopes generic refinement to its target-related and active cast', () => {
      const rendered = renderContinuity({
        continuityView: view,
        stickyCharacters: [{ id: 'ch-0001', name: 'Zinozi' }],
        targetFragment: { id: 'ch-0002', type: 'character', name: 'Mara' },
      }, 'librarian.refine')!
      expect(rendered).toContain('Mara knows or believes:')
      expect(rendered).toContain('Zinozi knows or believes:')
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
        targetFragment: { id: 'kn-0001', type: 'knowledge', name: 'The Key', refs: ['ch-0002'] },
        characterCatalog: [{ id: 'ch-0002', name: 'Mara' }],
      }, 'librarian.refine')!
      expect(rendered).toContain('Mara knows or believes:')
      expect(rendered).toContain('The hero lied')
      expect(rendered).not.toContain('The key is missing.')
    })

    it('scopes character optimization to its target regardless of pinning or recency', () => {
      const rendered = renderContinuity({
        continuityView: view,
        targetFragment: { id: 'ch-0002', type: 'character', name: 'Mara' },
      }, 'librarian.optimize-character')!
      expect(rendered).toContain('Mara knows or believes:')
      expect(rendered).toContain('The hero lied')
      expect(rendered).not.toContain('The key is missing.')
      expect(rendered).toContain('Respect it as evidence while editing')
    })

    it('distinguishes unavailable and duplicate character names without leaking IDs', () => {
      const rendered = renderContinuity({
        continuityView: {
          ...view,
          characterKnowledge: [
            ...view.characterKnowledge,
            makeCharacterKnowledge({
              characterId: 'ch-missing1',
              knowledgeKey: 'missing_fact_1',
              fact: 'One unavailable character knows the path.',
            }),
            makeCharacterKnowledge({
              characterId: 'ch-missing2',
              knowledgeKey: 'missing_fact_2',
              fact: 'Another unavailable character knows the password.',
            }),
          ],
        },
        stickyCharacters: [
          { id: 'ch-0001', name: 'Mara' },
          { id: 'ch-0002', name: 'mara' },
          { id: 'ch-missing1' },
          { id: 'ch-missing2' },
        ],
      }, 'generation.writer')!
      // Both folded characters resolve to the same case-insensitive name, so
      // neither receives an ambiguous identical heading.
      expect(rendered).toContain('Mara (character 1) knows or believes:')
      expect(rendered).toContain('mara (character 2) knows or believes:')
      expect(rendered).toContain('Unavailable character 1 knows or believes:')
      expect(rendered).toContain('Unavailable character 2 knows or believes:')
      expect(rendered).not.toContain('ch-0001')
      expect(rendered).not.toContain('ch-0002')
      expect(rendered).not.toContain('ch-missing1')
      expect(rendered).not.toContain('ch-missing2')
    })
  })

  describe('directions, which only proposes', () => {
    it('offers every thread as latent material', () => {
      const rendered = renderContinuity({ continuityView: view }, 'directions.suggest')!
      expect(rendered).toContain('The open wound')
      expect(rendered).toContain('Who sent the letter — Never followed up.')
      expect(rendered).toContain('has simply gone quiet, not been resolved')
      expect(rendered).toContain('None of them is owed an answer')
      // The constraint framing is the opposite instruction; both at once is noise.
      expect(rendered).not.toContain('not tasks, promised beats')
    })
  })

  describe('the librarian, which writes the records back', () => {
    it('exposes the keys, and scopes knowledge to this passage rather than the cast', () => {
      const rendered = renderContinuity({
        continuityView: view,
        // Pinned characters are deliberately not the analyst's scope: pinning is
        // standing author intent, not evidence the new passage is about them.
        stickyCharacters: [{ id: 'ch-0001' }],
        attentionCandidateIds: ['ch-0002'],
        characterCatalog: [{ id: 'ch-0002', name: 'Mara' }],
      }, 'librarian.analyze')!
      expect(rendered).toContain('who_sent_the_letter |')
      // Every lane reads `[n] key | label | detail`, so an operation can cite n.
      expect(rendered).toMatch(/\[\d+\] hero_lied \| .* \| known by Mara \(ch-0002\)/)
      expect(rendered).toContain('the knower, not necessarily the person or thing described')
      expect(rendered).not.toContain('key_missing')
    })
  })

  describe('character chat, which is the character', () => {
    const source = { continuityView: view, character: { id: 'ch-0001' } }

    it('gives one character their own facts and how they came by them', () => {
      const rendered = renderContinuity(source, 'character-chat.chat')!
      expect(rendered).toContain('The key is missing. (witnessed)')
      expect(rendered).not.toContain('The hero lied')
    })

    // A character handed the authorial records answers from offstage facts, which
    // is the one failure this presentation exists to prevent.
    it('withholds the durable state, open threads, and keys that belong to the author', () => {
      const rendered = renderContinuity(source, 'character-chat.chat')!
      expect(rendered).not.toContain('north tower')
      expect(rendered).not.toContain('Who sent the letter')
      expect(rendered).not.toContain('key_missing')
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
})
