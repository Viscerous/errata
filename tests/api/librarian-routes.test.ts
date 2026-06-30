import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createApp } from '@/server/api'
import {
  createStory,
  createFragment,
  getFragment,
  getStory,
  updateStory,
  listFragments,
  updateFragmentVersioned,
} from '@/server/fragments/storage'
import {
  saveAnalysis,
  saveState,
  type LibrarianAnalysis,
  type LibrarianState,
} from '@/server/librarian/storage'
import { fragmentBaseHash } from '@/server/fragments/change-operations'

// Mock the AI SDK to prevent real LLM calls
vi.mock('ai', () => ({
  stepCountIs: vi.fn((n: number) => n),
  streamText: vi.fn(() => {
    const text = 'Generated text'
    // Create a proper ReadableStream for textStream that supports tee()
    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(text)
        controller.close()
      },
    })
    return {
      textStream,
      text: Promise.resolve(text),
      usage: Promise.resolve({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
      finishReason: Promise.resolve('stop' as const),
      steps: Promise.resolve([]),
      toTextStreamResponse: () =>
        new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
    }
  }),
  tool: vi.fn((def: unknown) => def),
  generateText: vi.fn(),
  generateObject: vi.fn(),
}))

function makeAnalysis(overrides: Partial<LibrarianAnalysis> = {}): LibrarianAnalysis {
  return {
    id: `analysis-${Date.now()}`,
    createdAt: new Date().toISOString(),
    fragmentId: 'pr-0001',
    summaryUpdate: 'Something happened.',
    mentions: [{ fragmentId: 'ch-0001', text: 'hero' }],
    contradictions: [],
    fragmentChangeProposals: [],
    timelineEvents: [],
    ...overrides,
  }
}

describe('librarian API routes', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  const storyId = 'story-lib-api'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    app = createApp(dataDir)

    await createStory(dataDir, {
      id: storyId,
      name: 'Librarian API Test',
      description: 'Testing librarian routes',
      coverImage: null,
      summary: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      settings: makeTestSettings({ librarianProviderId: null, librarianModelId: null }),
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('GET /stories/:storyId/librarian/status', () => {
    it('returns default state for new story', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/status`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toMatchObject({
        lastAnalyzedFragmentId: null,
        recentMentions: {},
        timeline: [],
        runStatus: 'idle',
        pendingFragmentId: null,
        runningFragmentId: null,
        lastError: null,
      })
      expect(typeof data.updatedAt).toBe('string')
    })

    it('returns saved state', async () => {
      const state: LibrarianState = {
        lastAnalyzedFragmentId: 'pr-0001',
        summarizedUpTo: null,
        recentMentions: { 'ch-0001': ['pr-0001'] },
        timeline: [{ event: 'Battle', fragmentId: 'pr-0001' }],
      }
      await saveState(dataDir, storyId, state)

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/status`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.lastAnalyzedFragmentId).toBe('pr-0001')
      expect(data.recentMentions['ch-0001']).toEqual(['pr-0001'])
      expect(data.timeline).toHaveLength(1)
    })
  })

  describe('GET /stories/:storyId/librarian/analyses', () => {
    it('returns empty list when no analyses exist', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual([])
    })

    it('returns analyses sorted newest first', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-old',
        createdAt: '2025-01-01T00:00:00.000Z',
      }))
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-new',
        createdAt: '2025-01-02T00:00:00.000Z',
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toHaveLength(2)
      expect(data[0].id).toBe('analysis-new')
      expect(data[1].id).toBe('analysis-old')
      // Should be summaries
      expect(data[0]).toHaveProperty('contradictionCount')
      expect(data[0]).not.toHaveProperty('summaryUpdate')
    })
  })

  describe('GET /stories/:storyId/librarian/agent-runs', () => {
    it('returns empty list when no agent runs exist', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/agent-runs`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual([])
    })
  })

  describe('GET /stories/:storyId/librarian/analyses/:analysisId', () => {
    it('returns full analysis by ID', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-detail',
        summaryUpdate: 'The hero entered the cave.',
        mentions: [{ fragmentId: 'ch-0001', text: 'hero' }],
        contradictions: [
          { description: 'Eye color mismatch', fragmentIds: ['pr-0001'] },
        ],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-detail`),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.id).toBe('analysis-detail')
      expect(data.summaryUpdate).toBe('The hero entered the cave.')
      expect(data.mentions).toEqual([{ fragmentId: 'ch-0001', text: 'hero' }])
      expect(data.contradictions).toHaveLength(1)
    })

    it('returns 404 for non-existent analysis', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/nonexistent`),
      )
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /stories/:storyId/librarian/analyses/:analysisId', () => {
    it('updates the saved summary and syncs latest fragment/story summary text', async () => {
      await createFragment(dataDir, storyId, {
        id: 'pr-0001',
        type: 'prose',
        name: 'Scene 1',
        description: 'Opening scene',
        content: 'Original prose.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        order: 0,
        meta: {
          _librarian: {
            summary: 'Something happened.',
            analysisId: 'analysis-edit',
          },
        },
      })

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-edit',
        fragmentId: 'pr-0001',
        summaryUpdate: 'Something happened.',
      }))

      const story = await getStory(dataDir, storyId)
      await updateStory(dataDir, {
        ...story!,
        summary: 'Earlier events. Something happened. Later events.',
      })

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-edit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summaryUpdate: 'Something more precise happened.' }),
        }),
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.summaryUpdate).toBe('Something more precise happened.')

      const updatedAnalysis = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-edit`),
      )
      const updatedAnalysisJson = await updatedAnalysis.json()
      expect(updatedAnalysisJson.summaryUpdate).toBe('Something more precise happened.')

      const updatedFragment = await getFragment(dataDir, storyId, 'pr-0001')
      expect(updatedFragment?.meta?._librarian).toEqual({
        summary: 'Something more precise happened.',
        analysisId: 'analysis-edit',
      })

      const updatedStory = await getStory(dataDir, storyId)
      expect(updatedStory?.summary).toBe('Earlier events. Something more precise happened. Later events.')
    })
  })

  describe('POST /stories/:storyId/librarian/analyses/:analysisId/change-proposals/:index/accept', () => {
    it('marks a proposal as accepted and creates a fragment', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-accept',
        fragmentChangeProposals: [
          {
            title: 'Add dragon lore',
            operations: [{ operationId: 'op-1', action: 'create_fragment', type: 'knowledge', name: 'Dragon Lore', description: 'Dragons breathe fire', content: 'Full details about dragons.' }],
            validation: [{ operationId: 'op-1', action: 'create_fragment', status: 'valid' }],
          },
          {
            operations: [{ operationId: 'op-1', action: 'create_fragment', type: 'character', name: 'Hero', description: 'Main character', content: 'Hero backstory.' }],
            validation: [{ operationId: 'op-1', action: 'create_fragment', status: 'valid' }],
          },
        ],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-accept/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.analysis.fragmentChangeProposals[0].accepted).toBe(true)
      expect(data.analysis.fragmentChangeProposals[0].autoApplied).toBe(false)
      expect(data.analysis.fragmentChangeProposals[1].accepted).toBeUndefined()
      expect(data.createdFragmentIds[0]).toBeTruthy()

      const created = await getFragment(dataDir, storyId, data.createdFragmentIds[0])
      expect(created).toBeTruthy()
      expect(created?.name).toBe('Dragon Lore')
      expect(created?.type).toBe('knowledge')
      expect(created?.refs).toContain('pr-0001')
      expect(created?.meta?.sourceFragmentId).toBe('pr-0001')
    })

    it('reverts an accepted create proposal by archiving the created fragment', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-revert-create',
        fragmentChangeProposals: [{
          operations: [{ operationId: 'op-1', action: 'create_fragment', type: 'knowledge', name: 'Dragon Lore', description: 'Dragons breathe fire', content: 'Full details about dragons.' }],
          validation: [{ operationId: 'op-1', action: 'create_fragment', status: 'valid' }],
        }],
      }))

      const acceptRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-revert-create/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(acceptRes.status).toBe(200)
      const accepted = await acceptRes.json()
      const createdId = accepted.createdFragmentIds[0]
      expect(createdId).toBeTruthy()
      expect(accepted.appliedChanges[0]).toMatchObject({ kind: 'create', fragmentId: createdId })

      const revertRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-revert-create/change-proposals/0/revert`, {
          method: 'POST',
        }),
      )
      expect(revertRes.status).toBe(200)
      const revertedData = await revertRes.json()
      expect(revertedData.archivedFragmentIds).toEqual([createdId])
      expect(revertedData.analysis.fragmentChangeProposals[0].accepted).toBe(false)
      expect(revertedData.analysis.fragmentChangeProposals[0].appliedChanges).toBeUndefined()
      expect(revertedData.analysis.fragmentChangeProposals[0].revertedAt).toBeTruthy()

      const reverted = await getFragment(dataDir, storyId, createdId)
      expect(reverted?.archived).toBe(true)
    })

    it('updates an existing targeted fragment with set_fields', async () => {
      const now = new Date().toISOString()
      await createFragment(dataDir, storyId, {
        id: 'kn-0001',
        type: 'knowledge',
        name: 'Valdris',
        description: 'Ancient city',
        content: 'Valdris is an ancient city.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: now,
        updatedAt: now,
        order: 0,
        meta: {},
      })
      const target = await getFragment(dataDir, storyId, 'kn-0001')

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-target-update',
        fragmentChangeProposals: [{
          operations: [{
            operationId: 'op-1',
            action: 'set_fields',
            fragmentId: 'kn-0001',
            baseHash: fragmentBaseHash(target!),
            fields: {
              description: 'Ancient defended city',
              content: 'Valdris is an ancient city defended by stone sentinels.',
            },
          }],
          validation: [{ operationId: 'op-1', action: 'set_fields', status: 'valid', target: { fragmentId: 'kn-0001' } }],
        }],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-target-update/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.updatedFragmentIds).toEqual(['kn-0001'])

      const updated = await getFragment(dataDir, storyId, 'kn-0001')
      expect(updated).toBeTruthy()
      expect(updated?.description).toBe('Ancient defended city')
      expect(updated?.content).toContain('stone sentinels')
    })

    it('records applied changes and reverts an accepted update proposal', async () => {
      const now = new Date().toISOString()
      await createFragment(dataDir, storyId, {
        id: 'kn-revert',
        type: 'knowledge',
        name: 'Valdris',
        description: 'Ancient city',
        content: 'Valdris is an ancient city.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: now,
        updatedAt: now,
        order: 0,
        meta: {},
      })
      const target = await getFragment(dataDir, storyId, 'kn-revert')

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-revert-update',
        fragmentChangeProposals: [{
          operations: [{
            operationId: 'op-1',
            action: 'set_fields',
            fragmentId: 'kn-revert',
            baseHash: fragmentBaseHash(target!),
            fields: {
              description: 'Ancient defended city',
              content: 'Valdris is an ancient city defended by stone sentinels.',
            },
          }],
          validation: [{ operationId: 'op-1', action: 'set_fields', status: 'valid', target: { fragmentId: 'kn-revert' } }],
        }],
      }))

      const acceptRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-revert-update/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(acceptRes.status).toBe(200)
      const accepted = await acceptRes.json()
      expect(accepted.appliedChanges[0]).toMatchObject({
        kind: 'update',
        fragmentId: 'kn-revert',
        addedRefs: ['pr-0001'],
        fields: {
          description: {
            before: 'Ancient city',
            after: 'Ancient defended city',
          },
        },
      })

      const revertRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-revert-update/change-proposals/0/revert`, {
          method: 'POST',
        }),
      )
      expect(revertRes.status).toBe(200)
      const revertedData = await revertRes.json()
      expect(revertedData.updatedFragmentIds).toEqual(['kn-revert'])
      expect(revertedData.analysis.fragmentChangeProposals[0].accepted).toBe(false)
      expect(revertedData.analysis.fragmentChangeProposals[0].appliedChanges).toBeUndefined()
      expect(revertedData.analysis.fragmentChangeProposals[0].revertedAt).toBeTruthy()

      const reverted = await getFragment(dataDir, storyId, 'kn-revert')
      expect(reverted?.description).toBe('Ancient city')
      expect(reverted?.content).toBe('Valdris is an ancient city.')
      expect(reverted?.refs).not.toContain('pr-0001')
      expect(reverted?.meta.lastLibrarianChangeProposal).toBeUndefined()

      const reapplyRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-revert-update/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(reapplyRes.status).toBe(200)
      const reappliedData = await reapplyRes.json()
      expect(reappliedData.analysis.fragmentChangeProposals[0].accepted).toBe(true)
      expect(reappliedData.analysis.fragmentChangeProposals[0].revertedAt).toBeUndefined()

      const reapplied = await getFragment(dataDir, storyId, 'kn-revert')
      expect(reapplied?.description).toBe('Ancient defended city')
      expect(reapplied?.content).toContain('stone sentinels')
    })

    it('updates an existing targeted custom fragment without creating a duplicate', async () => {
      const story = await getStory(dataDir, storyId)
      await updateStory(dataDir, {
        ...story!,
        settings: {
          ...story!.settings,
          customFragmentTypes: [{
            type: 'location',
            name: 'Locations',
            description: 'Places in the story',
            icon: 'MapPin',
            showInSidebar: true,
          }],
        },
      })

      const now = new Date().toISOString()
      await createFragment(dataDir, storyId, {
        id: 'loc-0001',
        type: 'location',
        name: 'Ash Market',
        description: 'A market below the city',
        content: 'The Ash Market trades in debts.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: now,
        updatedAt: now,
        order: 0,
        meta: {},
      })
      const target = await getFragment(dataDir, storyId, 'loc-0001')

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-target-custom-update',
        fragmentChangeProposals: [{
          operations: [{
            operationId: 'op-1',
            action: 'set_fields',
            fragmentId: 'loc-0001',
            baseHash: fragmentBaseHash(target!),
            fields: {
              name: 'Ash Market Gate',
              description: 'The debt market entrance',
              content: 'The Ash Market Gate admits only debtors and oathkeepers.',
            },
          }],
          validation: [{ operationId: 'op-1', action: 'set_fields', status: 'valid', target: { fragmentId: 'loc-0001' } }],
        }],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-target-custom-update/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.updatedFragmentIds).toEqual(['loc-0001'])

      const updated = await getFragment(dataDir, storyId, 'loc-0001')
      expect(updated?.name).toBe('Ash Market Gate')
      expect(updated?.content).toContain('oathkeepers')
      const locations = await listFragments(dataDir, storyId, 'location')
      expect(locations.map((fragment) => fragment.id)).toEqual(['loc-0001'])
    })

    it('accepts a localized edit proposal and applies an exact text replacement', async () => {
      const now = new Date().toISOString()
      await createFragment(dataDir, storyId, {
        id: 'ch-0001',
        type: 'character',
        name: 'Alice',
        description: 'Captain of the guard',
        content: 'Alice is captain of the guard and lives in Valdris.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: now,
        updatedAt: now,
        order: 0,
        meta: {},
      })

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-edit-proposal',
        fragmentChangeProposals: [{
          operations: [{
            operationId: 'op-1',
            action: 'replace_text',
            fragmentId: 'ch-0001',
            field: 'content',
            oldText: 'captain of the guard',
            newText: 'former captain of the guard',
            replaceAll: false,
            reason: 'Alice resigned.',
          }],
          validation: [{ operationId: 'op-1', action: 'replace_text', status: 'valid', target: { fragmentId: 'ch-0001', field: 'content' } }],
        }],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-edit-proposal/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.updatedFragmentIds).toEqual(['ch-0001'])
      expect(data.analysis.fragmentChangeProposals[0].accepted).toBe(true)
      expect(data.analysis.fragmentChangeProposals[0].autoApplied).toBe(false)

      const updated = await getFragment(dataDir, storyId, 'ch-0001')
      expect(updated?.content).toContain('former captain of the guard')
      expect(updated?.refs).toContain('pr-0001')
    })

    it('returns operation-specific errors when accepting a stale proposal', async () => {
      const now = new Date().toISOString()
      await createFragment(dataDir, storyId, {
        id: 'ch-0001',
        type: 'character',
        name: 'Alice',
        description: 'Captain of the guard',
        content: 'Alice already resigned.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: now,
        updatedAt: now,
        order: 0,
        meta: {},
      })

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-stale-proposal',
        fragmentChangeProposals: [{
          operations: [{
            operationId: 'op-stale',
            action: 'replace_text',
            fragmentId: 'ch-0001',
            field: 'content',
            oldText: 'captain of the guard',
            newText: 'former captain of the guard',
            replaceAll: false,
          }],
          validation: [{ operationId: 'op-stale', action: 'replace_text', status: 'valid', target: { fragmentId: 'ch-0001', field: 'content' } }],
        }],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-stale-proposal/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(422)
      const data = await res.json()
      expect(data.error).toContain('op-stale')
      expect(data.error).toContain('oldText was not found')
      expect(data.error).toContain('Read first: ch-0001')

      // The failure is deterministic against current state, so the proposal is
      // marked stale (renders as dismissed) instead of staying pending to fail again.
      expect(data.analysis.fragmentChangeProposals[0]).toMatchObject({
        stale: true,
        dismissed: true,
      })
      expect(data.analysis.fragmentChangeProposals[0].staleReason).toContain('oldText was not found')
    })

    it('marks a duplicated sibling proposal stale on accept and revives it on revert', async () => {
      const now = new Date().toISOString()
      await createFragment(dataDir, storyId, {
        id: 'kn-dup',
        type: 'knowledge',
        name: 'Harbor District',
        description: 'Smuggling hub',
        content: 'The harbor district hosts the story\'s smuggling operation.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: now,
        updatedAt: now,
        order: 0,
        meta: {},
      })

      // Two proposals carrying the same fact — the shape a propose-retry used to
      // leave behind. Accepting one must not leave the other pending, because its
      // accept can only fail with a repeated-paragraph error.
      const paragraph = 'The Maritime Heritage Initiative branding is now serving as a cover for the smuggling operation across the harbor district.'
      const appendProposal = (operationId: string) => ({
        operations: [{
          operationId,
          action: 'append_paragraph' as const,
          fragmentId: 'kn-dup',
          field: 'content' as const,
          text: paragraph,
        }],
        validation: [{ operationId, action: 'append_paragraph' as const, status: 'valid' as const, target: { fragmentId: 'kn-dup', field: 'content' as const } }],
      })
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-dup-sibling',
        fragmentChangeProposals: [appendProposal('op-a'), appendProposal('op-b')],
      }))

      const acceptRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-dup-sibling/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(acceptRes.status).toBe(200)
      const accepted = await acceptRes.json()
      expect(accepted.analysis.fragmentChangeProposals[0].accepted).toBe(true)
      expect(accepted.analysis.fragmentChangeProposals[1]).toMatchObject({
        stale: true,
        dismissed: true,
      })
      expect(accepted.analysis.fragmentChangeProposals[1].staleReason).toContain('repeat the same paragraph')

      // Reverting removes the duplication, so the sibling becomes applicable again.
      const revertRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-dup-sibling/change-proposals/0/revert`, {
          method: 'POST',
        }),
      )
      expect(revertRes.status).toBe(200)
      const reverted = await revertRes.json()
      expect(reverted.analysis.fragmentChangeProposals[1].stale).toBeUndefined()
      expect(reverted.analysis.fragmentChangeProposals[1].dismissed).toBe(false)
    })

    it('returns 409 when reverting an accepted update after the fragment changed', async () => {
      const now = new Date().toISOString()
      await createFragment(dataDir, storyId, {
        id: 'ch-drift',
        type: 'character',
        name: 'Alice',
        description: 'Captain of the guard',
        content: 'Alice is captain of the guard.',
        tags: [],
        refs: [],
        sticky: false,
        placement: 'user',
        createdAt: now,
        updatedAt: now,
        order: 0,
        meta: {},
      })

      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-revert-drift',
        fragmentChangeProposals: [{
          operations: [{
            operationId: 'op-1',
            action: 'replace_text',
            fragmentId: 'ch-drift',
            field: 'content',
            oldText: 'captain of the guard',
            newText: 'former captain of the guard',
            replaceAll: false,
          }],
          validation: [{ operationId: 'op-1', action: 'replace_text', status: 'valid', target: { fragmentId: 'ch-drift', field: 'content' } }],
        }],
      }))

      const acceptRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-revert-drift/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(acceptRes.status).toBe(200)

      await updateFragmentVersioned(dataDir, storyId, 'ch-drift', {
        content: 'Alice left the guard entirely.',
      })

      const revertRes = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-revert-drift/change-proposals/0/revert`, {
          method: 'POST',
        }),
      )
      expect(revertRes.status).toBe(409)
      const data = await revertRes.json()
      expect(data.error).toContain('ch-drift changed since this proposal was applied')

      const drifted = await getFragment(dataDir, storyId, 'ch-drift')
      expect(drifted?.content).toBe('Alice left the guard entirely.')
    })

    it('returns 404 for non-existent analysis', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/nonexistent/change-proposals/0/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(404)
    })

    it('returns 422 for invalid proposal index', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-badidx',
        fragmentChangeProposals: [{
          operations: [{ operationId: 'op-1', action: 'create_fragment', type: 'knowledge', name: 'Test', description: 'Test', content: 'Test' }],
          validation: [{ operationId: 'op-1', action: 'create_fragment', status: 'valid' }],
        }],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-badidx/change-proposals/5/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(422)
      const data = await res.json()
      expect(data.error).toContain('Invalid fragment change proposal index')
    })

    it('returns 422 for negative index', async () => {
      await saveAnalysis(dataDir, storyId, makeAnalysis({
        id: 'analysis-negidx',
        fragmentChangeProposals: [{
          operations: [{ operationId: 'op-1', action: 'create_fragment', type: 'knowledge', name: 'Test', description: 'Test', content: 'Test' }],
          validation: [{ operationId: 'op-1', action: 'create_fragment', status: 'valid' }],
        }],
      }))

      const res = await app.fetch(
        new Request(`http://localhost/api/stories/${storyId}/librarian/analyses/analysis-negidx/change-proposals/-1/accept`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(422)
    })
  })
})
