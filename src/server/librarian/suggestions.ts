import {
  archiveFragment,
  getFragment,
  restoreFragment,
  updateFragment,
  updateFragmentVersioned,
} from '../fragments/storage'
import type { Fragment } from '../fragments/schema'
import type { EditableField, FragmentChangeOperation, OperationValidation } from '../fragments/change-operations'
import {
  applyOperations,
  fragmentBaseHash,
  recommendedReadFragmentIds,
  validateOperations,
} from '../fragments/change-operations'
import type {
  LibrarianAnalysis,
  LibrarianAppliedProposalChange,
  LibrarianProposalRevertResult,
} from './storage'

export interface ApplyFragmentChangeProposalResult {
  appliedResults: OperationValidation[]
  appliedChanges: LibrarianAppliedProposalChange[]
  createdFragmentIds: string[]
  updatedFragmentIds: string[]
  archivedFragmentIds: string[]
  readFragmentIds: string[]
}

export interface RevertFragmentChangeProposalResult {
  revertResults: LibrarianProposalRevertResult[]
  updatedFragmentIds: string[]
  archivedFragmentIds: string[]
  restoredFragmentIds: string[]
}

export class ProposalRevertConflictError extends Error {
  partial?: RevertFragmentChangeProposalResult
}

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

const EDITABLE_FIELDS: EditableField[] = ['name', 'description', 'content']

type EditAction = FragmentChangeOperation['action']

const isProposalUpdateAction = (action: EditAction): boolean =>
  action !== 'create_fragment' && action !== 'archive_fragment'
const isProposalArchiveAction = (action: EditAction): boolean =>
  action === 'archive_fragment'

/** Applied target fragment IDs whose operation action matches `match`. */
function appliedTargetIds(
  results: OperationValidation[],
  match: (action: EditAction) => boolean,
): string[] {
  return unique(results
    .filter((result) => result.status === 'applied' && match(result.action))
    .map((result) => result.target?.fragmentId)
    .filter((id): id is string => Boolean(id)))
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

function operationTargetIds(operations: FragmentChangeOperation[]): string[] {
  return unique(operations
    .filter((operation): operation is Exclude<FragmentChangeOperation, { action: 'create_fragment' }> =>
      operation.action !== 'create_fragment',
    )
    .map((operation) => operation.fragmentId))
}

async function snapshotTargets(
  dataDir: string,
  storyId: string,
  operations: FragmentChangeOperation[],
): Promise<Map<string, Fragment>> {
  const snapshots = new Map<string, Fragment>()
  for (const fragmentId of operationTargetIds(operations)) {
    const fragment = await getFragment(dataDir, storyId, fragmentId)
    if (fragment) snapshots.set(fragmentId, fragment)
  }
  return snapshots
}

function changedFields(
  before: Pick<Fragment, EditableField>,
  after: Pick<Fragment, EditableField>,
): Partial<Record<EditableField, { before: string; after: string }>> {
  const fields: Partial<Record<EditableField, { before: string; after: string }>> = {}
  for (const field of EDITABLE_FIELDS) {
    if (before[field] !== after[field]) {
      fields[field] = {
        before: before[field],
        after: after[field],
      }
    }
  }
  return fields
}

function createdFields(fragment: Pick<Fragment, EditableField>): Partial<Record<EditableField, { before: string; after: string }>> {
  return {
    name: { before: '', after: fragment.name },
    description: { before: '', after: fragment.description },
    content: { before: '', after: fragment.content },
  }
}

async function captureAppliedChanges(args: {
  dataDir: string
  storyId: string
  beforeById: Map<string, Fragment>
  appliedResults: OperationValidation[]
}): Promise<LibrarianAppliedProposalChange[]> {
  const { dataDir, storyId, beforeById, appliedResults } = args
  const changes: LibrarianAppliedProposalChange[] = []

  for (const result of appliedResults) {
    if (result.status !== 'applied' || result.action !== 'create_fragment' || !result.createdFragmentId) continue
    const created = await getFragment(dataDir, storyId, result.createdFragmentId)
    if (!created) continue
    changes.push({
      kind: 'create',
      fragmentId: created.id,
      afterHash: fragmentBaseHash(created),
      fields: createdFields(created),
    })
  }

  const updatedFragmentIds = appliedTargetIds(appliedResults, isProposalUpdateAction)

  for (const fragmentId of updatedFragmentIds) {
    const before = beforeById.get(fragmentId)
    const after = await getFragment(dataDir, storyId, fragmentId)
    if (!before || !after) continue
    const fields = changedFields(before, after)
    if (Object.keys(fields).length === 0) continue
    changes.push({
      kind: 'update',
      fragmentId,
      beforeHash: fragmentBaseHash(before),
      afterHash: fragmentBaseHash(after),
      fields,
      addedRefs: after.refs.filter((ref) => !before.refs.includes(ref)),
      ...('lastLibrarianChangeProposal' in before.meta
        ? { previousLastLibrarianChangeProposal: before.meta.lastLibrarianChangeProposal }
        : {}),
    })
  }

  const archivedFragmentIds = appliedTargetIds(appliedResults, isProposalArchiveAction)

  for (const fragmentId of archivedFragmentIds) {
    const before = beforeById.get(fragmentId)
    const after = await getFragment(dataDir, storyId, fragmentId)
    if (!before || !after) continue
    changes.push({
      kind: 'archive',
      fragmentId,
      beforeHash: fragmentBaseHash(before),
      afterHash: fragmentBaseHash(after),
    })
  }

  return changes
}

function conflict(message: string): never {
  throw new ProposalRevertConflictError(message)
}

function currentHashMatches(fragment: Fragment, expectedHash: string): boolean {
  return fragmentBaseHash(fragment) === expectedHash
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
  const beforeById = await snapshotTargets(dataDir, storyId, validation.operations)

  const appliedAt = new Date().toISOString()
  const sourceFragmentId = sourceFragmentIdForProposal(analysis, proposal)
  const sourceRefs = sourceFragmentId ? [sourceFragmentId] : []

  const appliedResults = await applyOperations(dataDir, storyId, validation.operations, {
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

  // Any operation that reached 'applied' has already written to disk, so build
  // the full applied-change record for whatever landed before deciding whether
  // to throw. A partial failure must not discard that record (see
  // ProposalApplyError) or the on-disk change becomes invisible and unrevertible.
  const createdFragmentIds = appliedResults
    .map((result) => result.createdFragmentId)
    .filter((id): id is string => Boolean(id))
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

  const updatedFragmentIds = appliedTargetIds(appliedResults, isProposalUpdateAction)
  const archivedFragmentIds = appliedTargetIds(appliedResults, isProposalArchiveAction)

  const appliedChanges = await captureAppliedChanges({
    dataDir,
    storyId,
    beforeById,
    appliedResults,
  })

  const result: ApplyFragmentChangeProposalResult = {
    appliedResults,
    appliedChanges,
    createdFragmentIds,
    updatedFragmentIds,
    archivedFragmentIds,
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

  const revertResults: LibrarianProposalRevertResult[] = []
  const updatedFragmentIds: string[] = []
  const archivedFragmentIds: string[] = []
  const restoredFragmentIds: string[] = []

  const buildResult = (): RevertFragmentChangeProposalResult => ({
    revertResults,
    updatedFragmentIds: unique(updatedFragmentIds),
    archivedFragmentIds: unique(archivedFragmentIds),
    restoredFragmentIds: unique(restoredFragmentIds),
  })

  try {
    for (const change of [...proposal.appliedChanges].reverse()) {
      if (change.kind === 'create') {
        const current = await getFragment(dataDir, storyId, change.fragmentId)
        if (!current) {
          revertResults.push({
            kind: change.kind,
            fragmentId: change.fragmentId,
            status: 'skipped',
            message: 'Created fragment no longer exists.',
          })
          continue
        }
        if (current.archived) {
          revertResults.push({
            kind: change.kind,
            fragmentId: change.fragmentId,
            status: 'skipped',
            message: 'Created fragment is already archived.',
          })
          continue
        }
        if (!currentHashMatches(current, change.afterHash)) {
          conflict(`Cannot revert fragment change proposal: created fragment ${change.fragmentId} changed since this proposal was applied.`)
        }
        const archived = await archiveFragment(dataDir, storyId, change.fragmentId)
        if (!archived) {
          conflict(`Cannot revert fragment change proposal: created fragment ${change.fragmentId} disappeared before revert.`)
        }
        archivedFragmentIds.push(change.fragmentId)
        revertResults.push({
          kind: change.kind,
          fragmentId: change.fragmentId,
          status: 'reverted',
        })
        continue
      }

      if (change.kind === 'archive') {
        const current = await getFragment(dataDir, storyId, change.fragmentId)
        if (!current) {
          conflict(`Cannot revert fragment change proposal: archived fragment ${change.fragmentId} no longer exists.`)
        }
        if (!current.archived) {
          revertResults.push({
            kind: change.kind,
            fragmentId: change.fragmentId,
            status: 'skipped',
            message: 'Fragment is already restored.',
          })
          continue
        }
        if (!currentHashMatches(current, change.beforeHash)) {
          conflict(`Cannot revert fragment change proposal: archived fragment ${change.fragmentId} changed since this proposal was applied.`)
        }
        const restored = await restoreFragment(dataDir, storyId, change.fragmentId)
        if (!restored) {
          conflict(`Cannot revert fragment change proposal: archived fragment ${change.fragmentId} disappeared before revert.`)
        }
        restoredFragmentIds.push(change.fragmentId)
        revertResults.push({
          kind: change.kind,
          fragmentId: change.fragmentId,
          status: 'reverted',
        })
        continue
      }

      const current = await getFragment(dataDir, storyId, change.fragmentId)
      if (!current) {
        conflict(`Cannot revert fragment change proposal: updated fragment ${change.fragmentId} no longer exists.`)
      }
      if (current.archived) {
        conflict(`Cannot revert fragment change proposal: updated fragment ${change.fragmentId} is archived.`)
      }
      // Already back at its pre-proposal field values — e.g. retrying after a
      // partial revert, or the author restored it by hand. Skip idempotently
      // rather than conflicting on the stale afterHash.
      const alreadyReverted = EDITABLE_FIELDS.every((field) => {
        const fieldChange = change.fields[field]
        return !fieldChange || current[field] === fieldChange.before
      })
      if (alreadyReverted) {
        revertResults.push({
          kind: change.kind,
          fragmentId: change.fragmentId,
          status: 'skipped',
          message: 'Fragment already matches its pre-proposal values.',
        })
        continue
      }
      if (!currentHashMatches(current, change.afterHash)) {
        conflict(`Cannot revert fragment change proposal: updated fragment ${change.fragmentId} changed since this proposal was applied.`)
      }

      const updates: Partial<Pick<Fragment, EditableField>> = {}
      for (const field of EDITABLE_FIELDS) {
        const fieldChange = change.fields[field]
        if (fieldChange) updates[field] = fieldChange.before
      }
      const updated = await updateFragmentVersioned(dataDir, storyId, change.fragmentId, updates, {
        reason: 'librarian-revert-proposal',
      })
      if (!updated) {
        conflict(`Cannot revert fragment change proposal: updated fragment ${change.fragmentId} disappeared before revert.`)
      }
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
      updatedFragmentIds.push(change.fragmentId)
      revertResults.push({
        kind: change.kind,
        fragmentId: change.fragmentId,
        status: 'reverted',
      })
    }
  } catch (error) {
    // A conflict aborts the remaining reverts, but earlier ones already wrote to
    // disk. Attach what was reverted so the caller can surface and record it.
    if (error instanceof ProposalRevertConflictError) {
      error.partial = buildResult()
    }
    throw error
  }

  return buildResult()
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
