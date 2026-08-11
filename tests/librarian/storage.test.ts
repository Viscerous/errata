import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createFragment, createStory, getFragment, updateFragment } from '@/server/fragments/storage'
import { analysisSourceRevision } from '@/server/librarian/continuity-source'
import {
  saveAnalysis,
  getAnalysis,
  listAnalyses,
  getState,
  saveState,
  getLatestAnalysisIdsByFragment,
  rebuildAnalysisIndex,
  type LibrarianAnalysis,
} from '@/server/librarian/storage'
import type { StoredLibrarianState } from '@/contracts/librarian'

function makeAnalysis(overrides: Partial<LibrarianAnalysis> = {}): LibrarianAnalysis {
  return {
    id: `analysis-${Date.now()}`,
    createdAt: new Date().toISOString(),
    fragmentId: 'pr-0001',
    summaryUpdate: 'The hero entered the cave.',
    mentions: [{ fragmentId: 'ch-0001', text: 'hero' }],
    contradictions: [],
    fragmentChangeProposals: [],
    timelineEvents: [],
    ...overrides,
  }
}

describe('librarian storage', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  const storyId = 'story-lib-test'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, {
      id: storyId,
      name: 'Test Story',
      description: 'For librarian tests',
    coverImage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: makeTestSettings(),
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('analysis CRUD', () => {
    it('saves and loads an analysis round-trip', async () => {
      const analysis = makeAnalysis({ id: 'analysis-a' })
      await saveAnalysis(dataDir, storyId, analysis)

      const loaded = await getAnalysis(dataDir, storyId, 'analysis-a')
      expect(loaded).toEqual(analysis)
    })

    it('returns isolated values from the analysis read cache', async () => {
      const analysis = makeAnalysis({ id: 'analysis-isolated' })
      await saveAnalysis(dataDir, storyId, analysis)

      const first = await getAnalysis(dataDir, storyId, analysis.id)
      first!.summaryUpdate = 'Caller-local mutation'

      const second = await getAnalysis(dataDir, storyId, analysis.id)
      expect(second!.summaryUpdate).toBe('The hero entered the cave.')
    })

    it('returns null for non-existent analysis', async () => {
      const loaded = await getAnalysis(dataDir, storyId, 'nonexistent')
      expect(loaded).toBeNull()
    })

    it('lists analyses sorted newest first', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-old',
        createdAt: '2025-01-01T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-new',
        createdAt: '2025-01-02T00:00:00.000Z',
      }))

      const summaries = await listAnalyses(dataDir, storyId)
      expect(summaries).toHaveLength(2)
      expect(summaries[0].id).toBe('analysis-new')
      expect(summaries[1].id).toBe('analysis-old')
    })

    it('list returns summaries with counts', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-counts',
        contradictions: [
          { description: 'Eye color changed', fragmentIds: ['pr-0001', 'pr-0002'] },
          { description: 'Dismissed old finding', fragmentIds: ['pr-0001'], dismissed: true },
        ],
        fragmentChangeProposals: [
          {
            operations: [{ operationId: 'op-1', action: 'create_fragment', type: 'knowledge', name: 'Cave', description: 'The dark cave', content: 'A cave in the mountains' }],
            validation: [{ operationId: 'op-1', action: 'create_fragment', status: 'valid' }],
          },
          {
            operations: [{ operationId: 'op-2', action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'old', newText: 'new', replaceAll: false }],
            validation: [{ operationId: 'op-2', action: 'replace_text', status: 'valid', target: { fragmentId: 'ch-0001', field: 'content' } }],
          },
        ],
        timelineEvents: [
          { event: 'Entered cave', position: 'before' },
          { event: 'Found sword', position: 'after' },
        ],
      }))

      const summaries = await listAnalyses(dataDir, storyId)
      expect(summaries[0].contradictionCount).toBe(1)
      expect(summaries[0].suggestionCount).toBe(2)
      expect(summaries[0].pendingSuggestionCount).toBe(2)
      expect(summaries[0].timelineEventCount).toBe(2)
    })

    it('returns empty list when no analyses exist', async () => {
      const summaries = await listAnalyses(dataDir, storyId)
      expect(summaries).toEqual([])
    })

    /**
     * Summaries are memoized per file so a five-second poll stops re-parsing
     * every trace. Rewriting an analysis — dismissing a contradiction, accepting
     * a proposal — must invalidate that, or the panel keeps showing counts the
     * user has already acted on.
     */
    it('reflects a rewritten analysis rather than a memoized summary', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-rewritten',
        contradictions: [
          { description: 'First', fragmentIds: ['ch-0001'] },
          { description: 'Second', fragmentIds: ['ch-0001'] },
        ],
      }))
      expect((await listAnalyses(dataDir, storyId))[0].contradictionCount).toBe(2)

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-rewritten',
        contradictions: [
          { description: 'First', fragmentIds: ['ch-0001'], dismissed: true },
          { description: 'Second', fragmentIds: ['ch-0001'] },
        ],
      }))
      expect((await listAnalyses(dataDir, storyId))[0].contradictionCount).toBe(1)
    })

    // The fold rejects a projection whose source prose changed. Without a flag
    // here that rejection is invisible: the passage's state and knowledge just
    // stop reaching the Writer with nothing prompting a re-analysis.
    it('flags an analysis whose source prose changed after it ran', async () => {
      await createFragment(dataDir, storyId, {
        id: 'pr-stale',
        type: 'prose',
        name: 'Passage',
        description: '',
        content: 'The original passage.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        order: 1,
        meta: {},
      })
      const prose = (await getFragment(dataDir, storyId, 'pr-stale'))!
      const projection = {
        version: 1 as const,
        temporalFrame: { relation: 'forward' as const },
        stateOperations: [],
        threadOperations: [],
        threadFocus: [],
        knowledgeOperations: [],
      }
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-fresh',
        fragmentId: 'pr-stale',
        sourceRevision: analysisSourceRevision(prose),
        continuityProjection: projection,
      }))

      expect((await listAnalyses(dataDir, storyId))[0].continuityStale).toBeUndefined()

      await updateFragment(dataDir, storyId, { ...prose, content: 'The passage was rewritten.' })

      expect((await listAnalyses(dataDir, storyId))[0].continuityStale).toBe(true)
    })

    it('updates latest-analysis index on save and reanalysis', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-old',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-01T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-new',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-02T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-other',
        fragmentId: 'pr-0002',
        createdAt: '2025-01-03T00:00:00.000Z',
      }))

      const latest = await getLatestAnalysisIdsByFragment(dataDir, storyId)
      expect(latest.get('pr-0001')).toBe('analysis-new')
      expect(latest.get('pr-0002')).toBe('analysis-other')
    })

    it('rebuilds analysis index from analysis files', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-a',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-01T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-b',
        fragmentId: 'pr-0001',
        createdAt: '2025-01-05T00:00:00.000Z',
      }))

      const rebuilt = await rebuildAnalysisIndex(dataDir, storyId)
      expect(rebuilt.latestByFragmentId['pr-0001']?.analysisId).toBe('analysis-b')

      const latest = await getLatestAnalysisIdsByFragment(dataDir, storyId)
      expect(latest.get('pr-0001')).toBe('analysis-b')
    })
  })

  describe('state persistence', () => {
    it('returns default state for new stories', async () => {
      const state = await getState(dataDir, storyId)
      expect(state).toEqual({
        lastAnalyzedFragmentId: null,
        recentMentions: {},
        timeline: [],
      })
    })

    it('saves and loads state', async () => {
      const state: StoredLibrarianState = {
        lastAnalyzedFragmentId: 'pr-0001',
        recentMentions: {
          'ch-0001': ['pr-0001', 'pr-0002'],
        },
        timeline: [
          { event: 'Hero entered cave', fragmentId: 'pr-0001' },
        ],
      }
      await saveState(dataDir, storyId, state)

      const loaded = await getState(dataDir, storyId)
      expect(loaded).toEqual(state)
    })

    it('overwrites previous state on save', async () => {
      await saveState(dataDir, storyId, {
        lastAnalyzedFragmentId: 'pr-0001',
        recentMentions: {},
        timeline: [],
      })

      await saveState(dataDir, storyId, {
        lastAnalyzedFragmentId: 'pr-0002',
        recentMentions: { 'ch-0001': ['pr-0002'] },
        timeline: [{ event: 'Battle', fragmentId: 'pr-0002' }],
      })

      const loaded = await getState(dataDir, storyId)
      expect(loaded.lastAnalyzedFragmentId).toBe('pr-0002')
      expect(loaded.recentMentions['ch-0001']).toEqual(['pr-0002'])
      expect(loaded.timeline).toHaveLength(1)
    })
  })
})
