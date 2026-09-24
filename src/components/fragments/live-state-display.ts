import { BookOpen, EyeOff, List, type LucideIcon } from 'lucide-react'
import type { EndedLiveStateItem, FoldedLiveState, Fragment } from '@/lib/api'
import { DEFAULT_LIVE_STATE_FIELDS, liveStateFieldKey, type LiveStateKind } from '@/contracts/live-state'

/**
 * The folded live state that belongs to a record. The fold already gathers every
 * report of a record under its catalog ID, including those made by name before
 * the record existed.
 */
export function liveStateFor(subjects: FoldedLiveState[], fragment: Pick<Fragment, 'id'>): FoldedLiveState | null {
  return subjects.find((subject) => subject.fragmentId === fragment.id) ?? null
}

/** Template fields first, in template order; anything else after, as reported. */
export function fieldOrder(field: string, kind: LiveStateKind = 'character'): number {
  const template = DEFAULT_LIVE_STATE_FIELDS[kind]
  const index = template.findIndex((definition) => liveStateFieldKey(definition.field) === liveStateFieldKey(field))
  return index === -1 ? template.length : index
}

export function describeAge(scenesAgo: number): string | null {
  if (scenesAgo === 0) return null
  return scenesAgo === 1 ? 'previous scene' : `${scenesAgo} scenes ago`
}

export function describeEnding(ended: EndedLiveStateItem, names: Map<string, string>): string {
  if (ended.happened === 'revealed') {
    const to = (ended.to ?? []).map((key) => names.get(key) ?? key)
    return to.length > 0 ? `Revealed to ${to.join(', ')}` : 'Revealed'
  }
  if (ended.happened === 'changed') return ended.now ? `Changed; now: ${ended.now}` : 'Changed'
  return 'Resolved'
}

export function groupItems(items: FoldedLiveState['items'], kind: LiveStateKind = 'character'): Array<[string, FoldedLiveState['items']]> {
  const groups = new Map<string, FoldedLiveState['items']>()
  for (const item of items) groups.set(item.field, [...(groups.get(item.field) ?? []), item])
  return [...groups].sort(([left], [right]) => fieldOrder(left, kind) - fieldOrder(right, kind))
}

/** Knows and Secrets keep their own look; any other list reads as a plain list. */
export function listStyle(field: string): { icon: LucideIcon; iconClass: string; itemClass: string } {
  const key = liveStateFieldKey(field)
  if (key === 'knows') return { icon: BookOpen, iconClass: 'text-emerald-400', itemClass: '' }
  if (key === 'secrets') return { icon: EyeOff, iconClass: 'text-rose-400', itemClass: 'italic' }
  return { icon: List, iconClass: 'text-muted-foreground', itemClass: '' }
}
