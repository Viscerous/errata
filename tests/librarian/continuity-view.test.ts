import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getContentRoot } from '@/server/fragments/branches'
import { buildContinuityView, renderCharacterAwareness, renderContinuityView } from '@/server/librarian/continuity-view'
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

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-continuity',
    name: 'Continuity Story',
    description: '',
    coverImage: null,
    summary: '',
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
    structuredSummary: {
      events: [`Event ${position}`],
      stateChanges: [`State ${position}`],
      openThreads: [`Thread ${position}`],
    },
    mentions: [],
    contradictions: [],
    fragmentChangeProposals: [],
    timelineEvents: [],
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

  // buildContinuityView runs inside buildContextState on the writer's critical
  // path, and its view-cache signature includes every prose hash, so it misses
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
        version: 1,
        temporalFrame: { relation: 'forward' },
        stateOperations: [{
          stateKey: `state_${position}`,
          action: 'set',
          subject: `Subject ${position}`,
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
        version: 1,
        temporalFrame: { relation: 'forward' },
        stateOperations: [{
          stateKey: 'alice.location',
          action: 'set',
          subject: 'Alice location',
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
        version: 1,
        temporalFrame: { relation: 'forward' },
        stateOperations: [{
          stateKey: 'alice.location',
          action: 'set',
          subject: 'Alice location',
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
        version: 1,
        temporalFrame: { relation: 'flashback', anchor: 'years earlier', evidenceSegments: [1], evidenceText: 'Passage 3' },
        stateOperations: [{
          stateKey: 'alice.location',
          action: 'set',
          subject: 'Alice location',
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
        version: 1,
        temporalFrame: { relation: 'forward' },
        stateOperations: [{
          stateKey: 'alice.location',
          action: 'set',
          subject: 'Alice location',
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
    expect(view?.currentState).toMatchObject([{ stateKey: 'alice_location', value: 'great hall' }])
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
    expect(view?.temporalFrame).toMatchObject({ relation: 'flashback', anchor: 'years earlier' })
    expect(view?.staleProjectionCount).toBe(1)

    const rendered = renderContinuityView(view!, { characterIds: ['ch-0001'] })
    expect(rendered).toContain('Alice location: great hall')
    expect(rendered).toContain('[background] The missing key')
    expect(rendered).toContain('not tasks, promised beats')
    expect(rendered).toContain('ch-0001 explicitly knows:')
    expect(rendered).toContain('The key is missing.')
    expect(rendered).not.toContain('Present:')
    expect(rendered).not.toContain('Direct witnesses:')
    expect(rendered).not.toContain('incorrect place')
    expect(rendered).not.toContain('childhood village')
  })

  // Eight of twenty-three Timeline 10 analyses reported no focus at all. Taking
  // that as an assertion that nothing is relevant dropped every live thread to
  // dormant, and the Writer's unresolved-continuity section vanished with it.
  it('keeps the last real focus snapshot when a later analysis supplies none', async () => {
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
        version: 1,
        temporalFrame: { relation: 'forward' },
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
        version: 1,
        temporalFrame: { relation: 'forward' },
        stateOperations: [],
        threadOperations: [],
        threadFocus: [],
        knowledgeOperations: [],
      },
    })

    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: passages })

    expect(view?.liveThreads).toMatchObject([{ threadKey: 'the_missing_key', visibility: 'foreground' }])
    expect(renderContinuityView(view!)).toContain('[foreground] The missing key')
  })

  // Threads leave the live list only when resolved, so an uncapped list grows
  // for the life of the story — and it becomes a closed enum in the analysis
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
        version: 1,
        temporalFrame: { relation: 'forward' },
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

    const view = await buildContinuityView({ dataDir, storyId: story.id, activeProseFragments: [passage] })

    expect(view!.liveThreads).toHaveLength(24)
    expect(view!.liveThreads.map((thread) => thread.threadKey)).toContain('thread_00')
    // The retained dormant threads are the most recently updated ones.
    expect(view!.liveThreads.map((thread) => thread.threadKey)).toContain('thread_39')
    expect(view!.liveThreads.map((thread) => thread.threadKey)).not.toContain('thread_01')
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
        version: 1,
        temporalFrame: { relation: 'forward' },
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
    expect(renderContinuityView(view!)).not.toContain('who_sent_the_letter |')
  })
})

/**
 * The same records read two opposite ways, so a caller has to get exactly one
 * framing: "let these lie" for whoever writes the next passage, "here is what
 * you could pick up" for whoever proposes it.
 */
describe('continuity thread framing', () => {
  const view = makeContinuityView({
    currentState: [],
    liveThreads: [
      makeLiveThread({ threadKey: 'the_open_wound', label: 'The open wound' }),
      makeLiveThread({
        threadKey: 'who_sent_the_letter',
        label: 'Who sent the letter',
        note: 'Never followed up.',
        visibility: 'dormant',
      }),
    ],
    characterKnowledge: [],
  })

  it('hides dormant threads and frames the rest as limits by default', () => {
    const rendered = renderContinuityView(view)
    expect(rendered).toContain('The open wound')
    expect(rendered).not.toContain('Who sent the letter')
    expect(rendered).toContain('not tasks, promised beats')
    expect(rendered).not.toContain('legitimate direction')
  })

  it('offers every thread as latent material when asked for candidates', () => {
    const rendered = renderContinuityView(view, { threads: 'candidates' })
    expect(rendered).toContain('The open wound')
    expect(rendered).toContain('Who sent the letter — Never followed up.')
    expect(rendered).toContain('has simply gone quiet, not been resolved')
    expect(rendered).toContain('None of them is owed an answer')
    // The constraint framing is the opposite instruction; both at once is noise.
    expect(rendered).not.toContain('not tasks, promised beats')
  })
})

describe('renderCharacterAwareness', () => {
  const view = makeContinuityView({
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

  it('gives one character their own facts and how they came by them', () => {
    const rendered = renderCharacterAwareness(view, 'ch-0001')
    expect(rendered).toContain('The key is missing. (witnessed)')
    expect(rendered).not.toContain('The hero lied')
  })

  // A character handed the authorial records answers from offstage facts, which
  // is the one failure this block exists to prevent.
  it('withholds the durable state and open threads that belong to the author', () => {
    const rendered = renderCharacterAwareness(view, 'ch-0001')
    expect(rendered).not.toContain('north tower')
    expect(rendered).not.toContain('Who sent the letter')
    expect(rendered).not.toContain('ch-0001')
  })

  it('states the boundary even when the fold recorded nothing for the character', () => {
    const rendered = renderCharacterAwareness(view, 'ch-9999')
    expect(rendered).toContain('you have not learned it')
    expect(rendered).toContain('nothing beyond your character sheet')
  })
})
