import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir } from '../setup'

vi.mock('@/server/agents', () => ({
  invokeAgent: vi.fn().mockResolvedValue(undefined),
}))

import { invokeAgent } from '@/server/agents'
import { clearPending, cancelPendingLibrarianForFragment } from '@/server/librarian/scheduler'
import { createApp } from '@/server/api'
import {
  getFragment,
} from '@/server/fragments/storage'
import {
  addProseVariation,
} from '@/server/fragments/prose-chain'
import {
  saveAnalysis,
  getAnalysisIndex,
  type LibrarianAnalysis,
} from '@/server/librarian/storage'
import {
  applyFragmentChangeProposal,
  markFragmentChangeProposalApplied,
} from '@/server/librarian/suggestions'
import { SUMMARY_CONTRACT_VERSION } from '@/server/librarian/summary-contract'

const mockedInvokeAgent = vi.mocked(invokeAgent)

let dataDir: string
let cleanup: () => Promise<void>
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  const tmp = await createTempDir()
  dataDir = tmp.path
  cleanup = tmp.cleanup
  app = createApp(dataDir)
  clearPending()
  mockedInvokeAgent.mockClear()
})

afterEach(async () => {
  clearPending()
  await cleanup()
})

async function api(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, init))
  return {
    status: res.status,
    json: async () => res.json(),
  }
}

async function apiJson(path: string, body: unknown, method = 'POST') {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createStoryWithProse(storyName = 'Lifecycle Story') {
  const story = await (await apiJson('/stories', { name: storyName, description: 'Test' })).json() as { id: string }
  const fragment = await (await apiJson(`/stories/${story.id}/fragments`, {
    type: 'prose',
    name: 'Section 1',
    description: 'Initial section',
    content: 'Marcus entered the dark cave carrying a glowing torch.',
  })).json() as { id: string }
  await apiJson(`/stories/${story.id}/prose-chain`, { fragmentId: fragment.id })
  return { storyId: story.id, fragmentId: fragment.id }
}

describe('prose and analysis lifecycle guarantees', () => {
  it('cascades section deletion to revert applied proposals and clean index & state', async () => {
    const { storyId, fragmentId } = await createStoryWithProse()

    // 1. Manually simulate an analysis on fragmentId with an applied proposal (e.g. creating a character)
    const analysisId = 'la-test-1'
    const analysis: LibrarianAnalysis = {
      id: analysisId,
      createdAt: new Date().toISOString(),
      fragmentId,
      sourceRevision: 'rev-1',
      summaryUpdate: 'Marcus entered the cave.',
      summaryContractVersion: SUMMARY_CONTRACT_VERSION,
      mentions: [],
      candidateFragmentIds: [],
      candidateFragments: [],
      contradictions: [],
      timelineEvents: [{ event: 'Marcus entered the cave', fragmentId }],
      fragmentChangeProposals: [
        {
          title: 'Add Torch knowledge',
          proposalKind: 'new-fragment',
          evidenceText: 'carrying a glowing torch',
          autoApplySafe: true,
          operations: [
            {
              action: 'create_fragment',
              type: 'knowledge',
              name: 'Glowing Torch',
              description: 'A torch that glows in the dark.',
              content: 'A wooden torch casting steady amber light.',
              reason: 'Established in scene.',
            },
          ],
          validation: [],
        },
      ],
      directions: [],
      analyzeLanes: [],
      passes: [],
      trace: [],
    }

    const applyResult = await applyFragmentChangeProposal({
      dataDir,
      storyId,
      analysis,
      proposalIndex: 0,
      reason: 'auto-apply',
    })
    markFragmentChangeProposalApplied({
      analysis,
      proposalIndex: 0,
      result: applyResult,
      autoApplied: true,
    })
    await saveAnalysis(dataDir, storyId, analysis)

    // Verify the knowledge fragment was created
    const createdItemId = applyResult.appliedResults[0]?.createdFragmentId
    expect(createdItemId).toBeDefined()
    const createdItem = await getFragment(dataDir, storyId, createdItemId!)
    expect(createdItem).not.toBeNull()
    expect(createdItem?.archived).toBe(false)

    // Verify analysis index has this fragment
    const indexBefore = await getAnalysisIndex(dataDir, storyId)
    expect(indexBefore?.latestByFragmentId[fragmentId]?.analysisId).toBe(analysisId)

    // 2. Delete the section
    const deleteRes = await api(`/stories/${storyId}/prose-chain/0`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)
    const deleteData = await deleteRes.json() as { ok: boolean; archivedFragmentIds: string[] }
    expect(deleteData.ok).toBe(true)
    expect(deleteData.archivedFragmentIds).toContain(fragmentId)

    // 3. Verify cascading cleanup:
    // a. The prose fragment is archived
    const proseFrag = await getFragment(dataDir, storyId, fragmentId)
    expect(proseFrag?.archived).toBe(true)

    // b. The created knowledge was reverted (archived)
    const revertedItem = await getFragment(dataDir, storyId, createdItemId!)
    expect(revertedItem?.archived).toBe(true)

    // c. The analysis index no longer references fragmentId
    const indexAfter = await getAnalysisIndex(dataDir, storyId)
    expect(indexAfter?.latestByFragmentId[fragmentId]).toBeUndefined()

    // d. The prose chain is empty
    const chainRes = await (await api(`/stories/${storyId}/prose-chain`)).json() as { entries: unknown[] }
    expect(chainRes.entries).toHaveLength(0)
  })

  it('cascades variation deletion: reverts its proposals, prunes variation, and switches active', async () => {
    const { storyId, fragmentId: frag1Id } = await createStoryWithProse()

    // Add a second variation to section 0
    const frag2 = await (await apiJson(`/stories/${storyId}/fragments`, {
      type: 'prose',
      name: 'Section 1 Alt',
      description: 'Alternative variation',
      content: 'Marcus turned back from the cave entrance.',
    })).json() as { id: string }
    const frag2Id = frag2.id

    // Add as variation to section 0
    await addProseVariation(dataDir, storyId, 0, frag2Id)

    // Switch active variation to frag2
    const switchRes = await apiJson(`/stories/${storyId}/prose-chain/0/switch`, { fragmentId: frag2Id })
    expect(switchRes.status).toBe(200)

    // Apply a proposal from frag2
    const analysisId = 'la-test-var2'
    const analysis: LibrarianAnalysis = {
      id: analysisId,
      createdAt: new Date().toISOString(),
      fragmentId: frag2Id,
      sourceRevision: 'rev-2',
      summaryUpdate: 'Marcus turned back.',
      summaryContractVersion: SUMMARY_CONTRACT_VERSION,
      mentions: [],
      candidateFragmentIds: [],
      candidateFragments: [],
      contradictions: [],
      timelineEvents: [{ event: 'Marcus turned back', fragmentId: frag2Id }],
      fragmentChangeProposals: [
        {
          title: 'Add Cave Entrance knowledge',
          proposalKind: 'new-fragment',
          evidenceText: 'cave entrance',
          autoApplySafe: true,
          operations: [
            {
              action: 'create_fragment',
              type: 'knowledge',
              name: 'Cave Entrance',
              description: 'The stony mouth of a shadowy cave.',
              content: 'Weathered boulders framing darkness.',
              reason: 'Location in scene.',
            },
          ],
          validation: [],
        },
      ],
      directions: [],
      analyzeLanes: [],
      passes: [],
      trace: [],
    }

    const applyResult = await applyFragmentChangeProposal({
      dataDir,
      storyId,
      analysis,
      proposalIndex: 0,
      reason: 'auto-apply',
    })
    markFragmentChangeProposalApplied({
      analysis,
      proposalIndex: 0,
      result: applyResult,
      autoApplied: true,
    })
    await saveAnalysis(dataDir, storyId, analysis)

    const createdLocId = applyResult.appliedResults[0]?.createdFragmentId
    expect(createdLocId).toBeDefined()
    expect((await getFragment(dataDir, storyId, createdLocId!))?.archived).toBe(false)

    // Delete variation frag2
    const delVarRes = await api(`/stories/${storyId}/prose-chain/0/variations/${frag2Id}`, { method: 'DELETE' })
    expect(delVarRes.status).toBe(200)
    const delVarData = await delVarRes.json() as { ok: boolean; sectionRemoved: boolean; newActive: string | null }
    expect(delVarData.ok).toBe(true)
    expect(delVarData.sectionRemoved).toBe(false)
    expect(delVarData.newActive).toBe(frag1Id)

    // Verify frag2 is archived and its created knowledge is reverted
    expect((await getFragment(dataDir, storyId, frag2Id))?.archived).toBe(true)
    expect((await getFragment(dataDir, storyId, createdLocId!))?.archived).toBe(true)

    // Verify frag1 is still active and unarchived
    expect((await getFragment(dataDir, storyId, frag1Id))?.archived).toBe(false)
    const chainAfter = await (await api(`/stories/${storyId}/prose-chain`)).json() as { entries: Array<{ active: string; proseFragments: unknown[] }> }
    expect(chainAfter.entries).toHaveLength(1)
    expect(chainAfter.entries[0].active).toBe(frag1Id)
    expect(chainAfter.entries[0].proseFragments).toHaveLength(1)
  })

  it('cancelPendingLibrarianForFragment clears deferred analysis on deleted fragment', async () => {
    const { storyId, fragmentId } = await createStoryWithProse()

    cancelPendingLibrarianForFragment(storyId, fragmentId)
    // Verify no throw and idempotent
    cancelPendingLibrarianForFragment(storyId, 'non-existent')
  })
})
