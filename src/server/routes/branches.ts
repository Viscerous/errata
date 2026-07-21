import { Elysia, t } from 'elysia'
import { withStory } from './_helpers'
import {
  getBranchesIndex,
  switchActiveBranch,
  createBranch,
  deleteBranch,
  renameBranch,
  markBranchDeleting,
} from '../fragments/branches'
import { cancelActiveAgentsForBranch } from '../agents/active-registry'
import { cancelPendingLibrarianForBranch } from '../librarian/scheduler'

export function branchRoutes(dataDir: string) {
  return new Elysia({ detail: { tags: ['Branches'] } })
    .get('/stories/:storyId/branches', withStory(dataDir, async (_story, { params }) => {
      return getBranchesIndex(dataDir, params.storyId)
    }), {
      detail: { summary: 'List all branches' },
    })

    .post('/stories/:storyId/branches', withStory(dataDir, async (_story, { params, body, set }) => {
      try {
        const branch = await createBranch(
          dataDir,
          params.storyId,
          body.name,
          body.parentBranchId,
          body.forkAfterIndex,
        )
        return branch
      } catch (err) {
        set.status = 400
        return { error: err instanceof Error ? err.message : 'Failed to create branch' }
      }
    }), {
      body: t.Object({
        name: t.String(),
        parentBranchId: t.String(),
        forkAfterIndex: t.Optional(t.Number()),
      }),
      detail: { summary: 'Create a new branch' },
    })

    .patch('/stories/:storyId/branches/active', withStory(dataDir, async (_story, { params, body, set }) => {
      try {
        await switchActiveBranch(dataDir, params.storyId, body.branchId)
        return { ok: true }
      } catch (err) {
        set.status = 400
        return { error: err instanceof Error ? err.message : 'Failed to switch branch' }
      }
    }), {
      body: t.Object({
        branchId: t.String(),
      }),
      detail: { summary: 'Switch the active branch' },
    })

    .put('/stories/:storyId/branches/:branchId', withStory(dataDir, async (_story, { params, body, set }) => {
      try {
        const branch = await renameBranch(dataDir, params.storyId, params.branchId, body.name)
        return branch
      } catch (err) {
        set.status = 400
        return { error: err instanceof Error ? err.message : 'Failed to rename branch' }
      }
    }), {
      body: t.Object({
        name: t.String(),
      }),
      detail: { summary: 'Rename a branch' },
    })

    .delete('/stories/:storyId/branches/:branchId', withStory(dataDir, async (_story, { params, set }) => {
      let releaseDeletion: (() => void) | undefined
      try {
        const current = await getBranchesIndex(dataDir, params.storyId)
        if (!current.branches.some(branch => branch.id === params.branchId)) {
          throw new Error(`Branch '${params.branchId}' not found`)
        }
        if (current.rootBranchId === params.branchId) {
          throw new Error(`Cannot delete the root branch '${params.branchId}'`)
        }
        releaseDeletion = markBranchDeleting(params.storyId, params.branchId)
        cancelPendingLibrarianForBranch(params.storyId, params.branchId)
        await cancelActiveAgentsForBranch(params.storyId, params.branchId)
        // A running agent can schedule analysis while it is settling.
        cancelPendingLibrarianForBranch(params.storyId, params.branchId)
        const index = await deleteBranch(dataDir, params.storyId, params.branchId)
        return { ok: true, activeBranchId: index.activeBranchId }
      } catch (err) {
        set.status = 400
        return { error: err instanceof Error ? err.message : 'Failed to delete branch' }
      } finally {
        releaseDeletion?.()
      }
    }), {
      detail: { summary: 'Delete a branch' },
    })
}
