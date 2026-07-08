import {
  archiveFragment,
  getFragment,
  restoreFragment,
  updateFragmentVersioned,
} from './storage'
import type { Fragment } from './schema'
import {
  applyOperations,
  fragmentBaseHash,
  type ApplyOperationsOptions,
  type EditableField,
  type FragmentChangeOperation,
  type OperationValidation,
} from './change-operations'

/**
 * Storage-agnostic apply + revert core shared by every path that commits a batch
 * of fragment operations and later needs to reverse it: the librarian analysis
 * proposals (accept/revert in the Story tab) and the direct-apply chat edits
 * (the Undo button). Both capture the same {@link AppliedChange} snapshot at apply
 * time and reverse it through {@link revertAppliedChanges}, so the two surfaces
 * share one hash-guarded, conflict-aware revert instead of drifting copies.
 */

export interface AppliedFieldChange {
  before: string
  after: string
}

export type AppliedChange =
  | {
      kind: 'create'
      fragmentId: string
      afterHash: string
      fields: Partial<Record<EditableField, AppliedFieldChange>>
    }
  | {
      kind: 'update'
      fragmentId: string
      beforeHash: string
      afterHash: string
      fields: Partial<Record<EditableField, AppliedFieldChange>>
      addedRefs?: string[]
      /** Analysis-specific: the proposal marker present before this change, so a
       * revert can restore it. Opaque to the core; only the analysis hook reads it. */
      previousLastLibrarianChangeProposal?: unknown
    }
  | {
      kind: 'archive'
      fragmentId: string
      beforeHash: string
      afterHash: string
    }

export interface RevertResult {
  kind: AppliedChange['kind']
  fragmentId: string
  status: 'reverted' | 'skipped'
  message?: string
}

export interface RevertBatchResult {
  revertResults: RevertResult[]
  updatedFragmentIds: string[]
  archivedFragmentIds: string[]
  restoredFragmentIds: string[]
}

/**
 * Thrown when a revert cannot proceed because a fragment changed since the batch
 * was applied (its `baseHash` no longer matches the recorded snapshot). Carries
 * whatever was reverted before the conflict so callers can surface and record it.
 */
export class RevertConflictError extends Error {
  partial?: RevertBatchResult
}

const EDITABLE_FIELDS: EditableField[] = ['name', 'description', 'content']

type EditAction = FragmentChangeOperation['action']

const isUpdateAction = (action: EditAction): boolean =>
  action !== 'create_fragment' && action !== 'archive_fragment'
const isArchiveAction = (action: EditAction): boolean => action === 'archive_fragment'

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

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
): Partial<Record<EditableField, AppliedFieldChange>> {
  const fields: Partial<Record<EditableField, AppliedFieldChange>> = {}
  for (const field of EDITABLE_FIELDS) {
    if (before[field] !== after[field]) {
      fields[field] = { before: before[field], after: after[field] }
    }
  }
  return fields
}

function createdFields(fragment: Pick<Fragment, EditableField>): Partial<Record<EditableField, AppliedFieldChange>> {
  return {
    name: { before: '', after: fragment.name },
    description: { before: '', after: fragment.description },
    content: { before: '', after: fragment.content },
  }
}

/** Build the revertible before/after snapshot for whatever an apply actually landed. */
async function captureAppliedChanges(args: {
  dataDir: string
  storyId: string
  beforeById: Map<string, Fragment>
  appliedResults: OperationValidation[]
}): Promise<AppliedChange[]> {
  const { dataDir, storyId, beforeById, appliedResults } = args
  const changes: AppliedChange[] = []

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

  for (const fragmentId of appliedTargetIds(appliedResults, isUpdateAction)) {
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

  for (const fragmentId of appliedTargetIds(appliedResults, isArchiveAction)) {
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

/**
 * Apply a batch of operations and return both the per-operation results and the
 * {@link AppliedChange} snapshot needed to reverse them later. The snapshot is
 * taken before anything writes, so a partial apply still yields a faithful record
 * of exactly what landed.
 */
export async function applyOperationsWithSnapshot(
  dataDir: string,
  storyId: string,
  operations: FragmentChangeOperation[],
  options: ApplyOperationsOptions = {},
): Promise<{ appliedResults: OperationValidation[]; appliedChanges: AppliedChange[] }> {
  const beforeById = await snapshotTargets(dataDir, storyId, operations)
  const appliedResults = await applyOperations(dataDir, storyId, operations, options)
  const appliedChanges = await captureAppliedChanges({ dataDir, storyId, beforeById, appliedResults })
  return { appliedResults, appliedChanges }
}

function conflict(message: string): never {
  throw new RevertConflictError(message)
}

function currentHashMatches(fragment: Fragment, expectedHash: string): boolean {
  return fragmentBaseHash(fragment) === expectedHash
}

export interface RevertAppliedChangesOptions {
  /** Version reason recorded for reverted field updates. */
  reason?: string
  /** Runs after a field update is reverted, before the next change. Lets callers
   * layer their own bookkeeping (e.g. proposal markers, source refs) onto the
   * reverted fragment. Only fired for `update` changes. */
  onFragmentReverted?: (
    change: Extract<AppliedChange, { kind: 'update' }>,
    updated: Fragment,
  ) => void | Promise<void>
}

/**
 * Reverse an {@link AppliedChange} snapshot: archive creates, restore archives,
 * and roll field updates back to their recorded `before` values — in reverse
 * order, refusing (via {@link RevertConflictError}) when a fragment changed since
 * it was applied. Idempotent: a change already back at its pre-apply state is
 * skipped rather than conflicting.
 */
export async function revertAppliedChanges(
  dataDir: string,
  storyId: string,
  appliedChanges: AppliedChange[],
  options: RevertAppliedChangesOptions = {},
): Promise<RevertBatchResult> {
  const revertResults: RevertResult[] = []
  const updatedFragmentIds: string[] = []
  const archivedFragmentIds: string[] = []
  const restoredFragmentIds: string[] = []

  const buildResult = (): RevertBatchResult => ({
    revertResults,
    updatedFragmentIds: unique(updatedFragmentIds),
    archivedFragmentIds: unique(archivedFragmentIds),
    restoredFragmentIds: unique(restoredFragmentIds),
  })

  try {
    for (const change of [...appliedChanges].reverse()) {
      if (change.kind === 'create') {
        const current = await getFragment(dataDir, storyId, change.fragmentId)
        if (!current) {
          revertResults.push({ kind: change.kind, fragmentId: change.fragmentId, status: 'skipped', message: 'Created fragment no longer exists.' })
          continue
        }
        if (current.archived) {
          revertResults.push({ kind: change.kind, fragmentId: change.fragmentId, status: 'skipped', message: 'Created fragment is already archived.' })
          continue
        }
        if (!currentHashMatches(current, change.afterHash)) {
          conflict(`Cannot revert: created fragment ${change.fragmentId} changed since it was applied.`)
        }
        const archived = await archiveFragment(dataDir, storyId, change.fragmentId)
        if (!archived) {
          conflict(`Cannot revert: created fragment ${change.fragmentId} disappeared before revert.`)
        }
        archivedFragmentIds.push(change.fragmentId)
        revertResults.push({ kind: change.kind, fragmentId: change.fragmentId, status: 'reverted' })
        continue
      }

      if (change.kind === 'archive') {
        const current = await getFragment(dataDir, storyId, change.fragmentId)
        if (!current) {
          conflict(`Cannot revert: archived fragment ${change.fragmentId} no longer exists.`)
        }
        if (!current.archived) {
          revertResults.push({ kind: change.kind, fragmentId: change.fragmentId, status: 'skipped', message: 'Fragment is already restored.' })
          continue
        }
        if (!currentHashMatches(current, change.beforeHash)) {
          conflict(`Cannot revert: archived fragment ${change.fragmentId} changed since it was applied.`)
        }
        const restored = await restoreFragment(dataDir, storyId, change.fragmentId)
        if (!restored) {
          conflict(`Cannot revert: archived fragment ${change.fragmentId} disappeared before revert.`)
        }
        restoredFragmentIds.push(change.fragmentId)
        revertResults.push({ kind: change.kind, fragmentId: change.fragmentId, status: 'reverted' })
        continue
      }

      const current = await getFragment(dataDir, storyId, change.fragmentId)
      if (!current) {
        conflict(`Cannot revert: updated fragment ${change.fragmentId} no longer exists.`)
      }
      if (current.archived) {
        conflict(`Cannot revert: updated fragment ${change.fragmentId} is archived.`)
      }
      // Already back at its pre-apply field values — e.g. retrying after a partial
      // revert, or the author restored it by hand. Skip idempotently rather than
      // conflicting on the stale afterHash.
      const alreadyReverted = EDITABLE_FIELDS.every((field) => {
        const fieldChange = change.fields[field]
        return !fieldChange || current[field] === fieldChange.before
      })
      if (alreadyReverted) {
        revertResults.push({ kind: change.kind, fragmentId: change.fragmentId, status: 'skipped', message: 'Fragment already matches its pre-change values.' })
        continue
      }
      if (!currentHashMatches(current, change.afterHash)) {
        conflict(`Cannot revert: updated fragment ${change.fragmentId} changed since it was applied.`)
      }

      const updates: Partial<Pick<Fragment, EditableField>> = {}
      for (const field of EDITABLE_FIELDS) {
        const fieldChange = change.fields[field]
        if (fieldChange) updates[field] = fieldChange.before
      }
      const updated = await updateFragmentVersioned(dataDir, storyId, change.fragmentId, updates, {
        reason: options.reason ?? 'revert-applied-change',
      })
      if (!updated) {
        conflict(`Cannot revert: updated fragment ${change.fragmentId} disappeared before revert.`)
      }
      await options.onFragmentReverted?.(change, updated)
      updatedFragmentIds.push(change.fragmentId)
      revertResults.push({ kind: change.kind, fragmentId: change.fragmentId, status: 'reverted' })
    }
  } catch (error) {
    if (error instanceof RevertConflictError) {
      error.partial = buildResult()
    }
    throw error
  }

  return buildResult()
}
