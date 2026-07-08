import {
  getFragment,
  updateFragment,
} from '../fragments/storage'
import type { Fragment } from '../fragments/schema'
import type { OperationValidation } from '../fragments/change-operations'
import {
  fragmentBaseHash,
  recommendedReadFragmentIds,
  validateOperations,
} from '../fragments/change-operations'
import {
  applyOperationsWithSnapshot,
  revertAppliedChanges,
  RevertConflictError,
  type AppliedChange,
  type RevertResult,
} from '../fragments/change-apply'
import type { LibrarianAnalysis } from './storage'

export interface ApplyFragmentChangeProposalResult {
  appliedResults: OperationValidation[]
  appliedChanges: AppliedChange[]
  createdFragmentIds: string[]
  updatedFragmentIds: string[]
  archivedFragmentIds: string[]
  readFragmentIds: string[]
}

export interface RevertFragmentChangeProposalResult {
  revertResults: RevertResult[]
  updatedFragmentIds: string[]
  archivedFragmentIds: string[]
  restoredFragmentIds: string[]
}

/** Analysis-flavoured alias of the shared {@link RevertConflictError}, kept so the
 * accept/revert route handlers catch the same type they always did. */
export { RevertConflictError as ProposalRevertConflictError }

/**
 * Thrown when `applyOperations` wrote some targets to disk before a later target
 * failed. Carries the snapshot of what actually applied so callers can record it
 * on the proposal and keep the partial change visible and revertible.
 */
export class ProposalApplyError extends Error {
  constructor(message: string, readonly partial: ApplyFragmentChangeProposalResult) {
    super(message)
    this.name = 'ProposalApplyError'
  }
}

/**
 * Thrown when pre-apply validation rejects a proposal, before anything writes to
 * disk. Deterministic against current fragment state — typically the proposal is
 * stale (a sibling proposal or manual edit already changed the target), so
 * callers should mark it stale rather than leave it pending to fail again.
 */
export class ProposalValidationError extends Error {
  constructor(message: string, readonly results: OperationValidation[]) {
    super(message)
    this.name = 'ProposalValidationError'
  }
}

/** Fragment IDs recorded in an applied-change snapshot for a given change kind. */
function changedIdsOfKind(changes: AppliedChange[], kind: AppliedChange['kind']): string[] {
  return unique(changes.filter((change) => change.kind === kind).map((change) => change.fragmentId))
}

function sourceFragmentIdForProposal(
  analysis: LibrarianAnalysis,
  proposal: LibrarianAnalysis['fragmentChangeProposals'][number],
): string | null {
  return proposal.sourceFragmentId ?? analysis.fragmentId ?? null
}

function invalidValidationMessage(results: OperationValidation[]): string {
  return results
    .map((result) => {
      const messages = result.errors?.map((error) => error.message).join('; ') || 'operation is not valid'
      return `${result.operationId}: ${messages}`
    })
    .join(' | ')
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function currentProposalMarkerMatches(
  fragment: Fragment,
  analysisId: string,
  proposalIndex: number,
): boolean {
  const marker = fragment.meta.lastLibrarianChangeProposal
  return typeof marker === 'object'
    && marker !== null
    && (marker as Record<string, unknown>).analysisId === analysisId
    && (marker as Record<string, unknown>).proposalIndex === proposalIndex
}

export async function applyFragmentChangeProposal(args: {
  dataDir: string
  storyId: string
  analysis: LibrarianAnalysis
  proposalIndex: number
  reason: 'manual-accept' | 'auto-apply'
}): Promise<ApplyFragmentChangeProposalResult> {
  const { dataDir, storyId, analysis, proposalIndex, reason } = args
  const proposal = analysis.fragmentChangeProposals[proposalIndex]
  if (!proposal) {
    throw new Error('Invalid fragment change proposal index')
  }

  const validation = await validateOperations(dataDir, storyId, proposal.operations)
  const invalid = validation.results.filter((result) => result.status !== 'valid')
  const readFragmentIds = recommendedReadFragmentIds(validation.results)
  if (invalid.length > 0) {
    const readHint = readFragmentIds.length > 0
      ? ` Read first: ${readFragmentIds.join(', ')}.`
      : ''
    throw new ProposalValidationError(
      `Cannot apply fragment change proposal: ${invalidValidationMessage(invalid)}.${readHint}`,
      validation.results,
    )
  }
  const appliedAt = new Date().toISOString()
  const sourceFragmentId = sourceFragmentIdForProposal(analysis, proposal)
  const sourceRefs = sourceFragmentId ? [sourceFragmentId] : []

  // Shared core validates, applies atomically per target, and captures the
  // revert snapshot. The onFragmentUpdated hook layers analysis-specific
  // bookkeeping (source refs + proposal marker) onto each edited fragment.
  const { appliedResults, appliedChanges } = await applyOperationsWithSnapshot(dataDir, storyId, validation.operations, {
    reason: `librarian-${reason}`,
    createMetaSource: 'librarian-proposal',
    onFragmentUpdated: async (_before, updated) => {
      await updateFragment(dataDir, storyId, {
        ...updated,
        refs: unique([...updated.refs, ...sourceRefs]),
        meta: {
          ...updated.meta,
          lastLibrarianChangeProposal: {
            analysisId: analysis.id,
            proposalIndex,
            sourceFragmentId: sourceFragmentId ?? undefined,
            autoApplied: reason === 'auto-apply',
            appliedAt,
          },
        },
        updatedAt: appliedAt,
      })
    },
  })

  // Any operation that reached 'applied' has already written to disk. Layer the
  // proposal provenance onto created fragments (baseHash ignores refs/meta, so
  // this does not disturb the captured snapshot).
  const createdFragmentIds = changedIdsOfKind(appliedChanges, 'create')
  for (const fragmentId of createdFragmentIds) {
    const fragment = await getFragment(dataDir, storyId, fragmentId)
    if (!fragment) continue
    await updateFragment(dataDir, storyId, {
      ...fragment,
      refs: unique([...fragment.refs, ...sourceRefs]),
      meta: {
        ...fragment.meta,
        source: 'librarian-proposal',
        analysisId: analysis.id,
        proposalIndex,
        sourceFragmentId: sourceFragmentId ?? undefined,
        autoApplied: reason === 'auto-apply',
        createdFromProposalAt: appliedAt,
      },
      updatedAt: appliedAt,
    })
  }

  const result: ApplyFragmentChangeProposalResult = {
    appliedResults,
    appliedChanges,
    createdFragmentIds,
    updatedFragmentIds: changedIdsOfKind(appliedChanges, 'update'),
    archivedFragmentIds: changedIdsOfKind(appliedChanges, 'archive'),
    readFragmentIds,
  }

  const failed = appliedResults.filter((entry) => entry.status !== 'applied')
  if (failed.length > 0) {
    throw new ProposalApplyError(`Cannot fully apply fragment change proposal: ${invalidValidationMessage(failed)}.`, result)
  }

  return result
}

export function markFragmentChangeProposalApplied(args: {
  analysis: LibrarianAnalysis
  proposalIndex: number
  result: ApplyFragmentChangeProposalResult
  autoApplied: boolean
}): void {
  const { analysis, proposalIndex, result, autoApplied } = args
  const proposal = analysis.fragmentChangeProposals[proposalIndex]
  if (!proposal) {
    throw new Error('Invalid fragment change proposal index')
  }

  proposal.accepted = true
  proposal.autoApplied = autoApplied
  proposal.dismissed = false
  proposal.validation = result.appliedResults
  proposal.appliedResults = result.appliedResults
  proposal.appliedChanges = result.appliedChanges
  delete proposal.stale
  delete proposal.staleReason
  delete proposal.reverted
  delete proposal.revertedAt
  delete proposal.revertResults
}

/**
 * Mark a pending proposal as no longer applicable (its pre-apply validation
 * failed against current fragment state — typically because a sibling proposal
 * already landed the same change). Stale proposals render as dismissed so the
 * user is not offered an accept that can only fail, but stay distinguishable
 * from user dismissals via `stale`, and revive if a revert makes them valid again.
 */
export function markFragmentChangeProposalStale(args: {
  analysis: LibrarianAnalysis
  proposalIndex: number
  reason: string
  validation?: OperationValidation[]
}): void {
  const { analysis, proposalIndex, reason, validation } = args
  const proposal = analysis.fragmentChangeProposals[proposalIndex]
  if (!proposal) {
    throw new Error('Invalid fragment change proposal index')
  }
  proposal.stale = true
  proposal.staleReason = reason
  proposal.dismissed = true
  if (validation) proposal.validation = validation
}

/**
 * Re-validate every pending proposal on the analysis against current fragment
 * state. Proposals that became invalid (a sibling apply already landed their
 * change, moved their anchors, or bumped their baseHash) are marked stale;
 * previously stale proposals that are valid again (after a revert) revive.
 * User dismissals are never touched. Call after any apply or revert.
 */
export async function refreshPendingFragmentChangeProposals(args: {
  dataDir: string
  storyId: string
  analysis: LibrarianAnalysis
}): Promise<{ staleIndices: number[]; revivedIndices: number[] }> {
  const { dataDir, storyId, analysis } = args
  const staleIndices: number[] = []
  const revivedIndices: number[] = []

  for (let index = 0; index < analysis.fragmentChangeProposals.length; index += 1) {
    const proposal = analysis.fragmentChangeProposals[index]
    if (proposal.accepted) continue
    if (proposal.dismissed && !proposal.stale) continue

    const validation = await validateOperations(dataDir, storyId, proposal.operations)
    proposal.operations = validation.operations
    proposal.validation = validation.results

    const invalid = validation.results.filter((result) => result.status !== 'valid')
    if (invalid.length > 0 && !proposal.stale) {
      markFragmentChangeProposalStale({
        analysis,
        proposalIndex: index,
        reason: invalidValidationMessage(invalid),
        validation: validation.results,
      })
      staleIndices.push(index)
    } else if (invalid.length === 0 && proposal.stale) {
      delete proposal.stale
      delete proposal.staleReason
      proposal.dismissed = false
      revivedIndices.push(index)
    }
  }

  return { staleIndices, revivedIndices }
}

export async function revertFragmentChangeProposal(args: {
  dataDir: string
  storyId: string
  analysis: LibrarianAnalysis
  proposalIndex: number
}): Promise<RevertFragmentChangeProposalResult> {
  const { dataDir, storyId, analysis, proposalIndex } = args
  const proposal = analysis.fragmentChangeProposals[proposalIndex]
  if (!proposal) {
    throw new Error('Invalid fragment change proposal index')
  }
  if (!proposal.accepted) {
    throw new Error('Cannot revert a fragment change proposal that has not been applied.')
  }
  if (proposal.reverted) {
    throw new Error('Fragment change proposal is already reverted.')
  }
  if (!proposal.appliedChanges?.length) {
    throw new Error('Fragment change proposal has no applied-change snapshot and cannot be reverted safely.')
  }

  // Shared core reverses the snapshot (archive creates, restore archives, roll
  // updates back to `before`) with hash-guarded conflict detection. The hook
  // undoes the analysis-specific bookkeeping the apply layered on: source refs
  // and the proposal marker.
  return revertAppliedChanges(dataDir, storyId, proposal.appliedChanges, {
    reason: 'librarian-revert-proposal',
    onFragmentReverted: async (change, updated) => {
      const nextRefs = change.addedRefs?.length
        ? updated.refs.filter((ref) => !change.addedRefs?.includes(ref))
        : updated.refs
      const nextMeta = { ...updated.meta }
      if (currentProposalMarkerMatches(updated, analysis.id, proposalIndex)) {
        if ('previousLastLibrarianChangeProposal' in change) {
          nextMeta.lastLibrarianChangeProposal = change.previousLastLibrarianChangeProposal
        } else {
          delete nextMeta.lastLibrarianChangeProposal
        }
      }
      if (
        nextRefs.length !== updated.refs.length
        || nextMeta.lastLibrarianChangeProposal !== updated.meta.lastLibrarianChangeProposal
      ) {
        await updateFragment(dataDir, storyId, {
          ...updated,
          refs: nextRefs,
          meta: nextMeta,
        })
      }
    },
  })
}

export async function markFragmentChangeProposalReverted(args: {
  dataDir: string
  storyId: string
  analysis: LibrarianAnalysis
  proposalIndex: number
  result: RevertFragmentChangeProposalResult
}): Promise<void> {
  const { dataDir, storyId, analysis, proposalIndex, result } = args
  const proposal = analysis.fragmentChangeProposals[proposalIndex]
  if (!proposal) {
    throw new Error('Invalid fragment change proposal index')
  }

  proposal.accepted = false
  proposal.autoApplied = false
  delete proposal.appliedResults
  delete proposal.appliedChanges
  proposal.reverted = true
  proposal.revertedAt = new Date().toISOString()
  proposal.revertResults = result.revertResults

  for (const operation of proposal.operations) {
    if (operation.action !== 'set_fields') continue
    const fragment = await getFragment(dataDir, storyId, operation.fragmentId)
    if (fragment) operation.baseHash = fragmentBaseHash(fragment)
  }

  const validation = await validateOperations(dataDir, storyId, proposal.operations)
  proposal.operations = validation.operations
  proposal.validation = validation.results
}
