import {
  liveStateFieldKey,
  liveStateItemId,
  type FoldedLiveState,
  type LiveStateEdit,
} from '@/contracts/live-state'

export interface DesiredLiveState {
  fields: Array<{ field: string; value: string }>
  /** An item keeps its `id` when the author edits it; a new one has none. */
  items: Array<{ id?: string; field: string; text: string }>
}

type Correction = Pick<LiveStateEdit, 'set' | 'add' | 'update' | 'revise' | 'remove'>

/**
 * The author edits a subject's state as a whole; the record keeps only what
 * changed, as a correction. A reworded item keeps its identity, so later
 * passages that end it by number still find it.
 */
export function diffLiveStateCorrection(
  current: FoldedLiveState | undefined,
  desired: DesiredLiveState,
): Correction {
  const correction: Correction = { set: [], add: [], update: [], revise: [], remove: [] }
  const currentFields = new Map((current?.fields ?? []).map((field) => [liveStateFieldKey(field.field), field]))
  const desiredFieldKeys = new Set<string>()
  for (const { field, value } of desired.fields) {
    const key = liveStateFieldKey(field)
    if (!key) continue
    desiredFieldKeys.add(key)
    const trimmed = value.trim()
    if (currentFields.get(key)?.value !== trimmed) correction.set.push({ field: field.trim(), value: trimmed })
  }
  for (const [key, field] of currentFields) {
    if (!desiredFieldKeys.has(key)) correction.set.push({ field: field.field, value: '' })
  }

  const currentItems = new Map((current?.items ?? []).map((item) => [item.id, item]))
  const keptIds = new Set<string>()
  for (const item of desired.items) {
    const text = item.text.trim()
    if (!text) continue
    const existing = item.id ? currentItems.get(item.id) : undefined
    if (existing) {
      keptIds.add(existing.id)
      if (existing.text !== text) correction.revise.push({ id: existing.id, text })
      continue
    }
    correction.add.push({ id: liveStateItemId(item.field, text), field: item.field.trim(), text })
  }
  for (const id of currentItems.keys()) {
    if (!keptIds.has(id)) correction.remove.push(id)
  }
  return correction
}

export function isEmptyCorrection(correction: Correction): boolean {
  return correction.set.length === 0
    && correction.add.length === 0
    && correction.update.length === 0
    && correction.revise.length === 0
    && correction.remove.length === 0
}
