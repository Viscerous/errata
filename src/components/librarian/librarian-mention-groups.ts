import type { CustomFragmentType, Fragment } from '@/lib/api'
import {
  compareFragmentTypeVisuals,
  getFragmentTypeVisual,
  inferFragmentTypeFromId,
  type FragmentTypeVisual,
} from '@/components/fragments/fragment-type-icons'

export type MentionEntry = [string, string[]]
export type MentionGroup = { type: string; visual: FragmentTypeVisual; entries: MentionEntry[] }

export function buildMentionGroups(
  entries: MentionEntry[],
  fragmentById: Map<string, Fragment>,
  customTypeByType: Map<string, CustomFragmentType>,
): MentionGroup[] {
  const groups = new Map<string, MentionGroup>()
  for (const entry of entries) {
    const [fragmentId] = entry
    const type = fragmentById.get(fragmentId)?.type ?? inferFragmentTypeFromId(fragmentId) ?? 'custom'
    const group = groups.get(type) ?? {
      type,
      visual: getFragmentTypeVisual(type, customTypeByType),
      entries: [],
    }
    group.entries.push(entry)
    groups.set(type, group)
  }

  for (const group of groups.values()) {
    group.entries.sort((a, b) => {
      const countDiff = new Set(b[1]).size - new Set(a[1]).size
      if (countDiff !== 0) return countDiff
      const aName = fragmentById.get(a[0])?.name ?? a[0]
      const bName = fragmentById.get(b[0])?.name ?? b[0]
      return aName.localeCompare(bName)
    })
  }

  return [...groups.values()].sort((a, b) => compareFragmentTypeVisuals(a.visual, b.visual))
}
