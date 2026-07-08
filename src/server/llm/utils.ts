import type { Fragment } from '../fragments/schema'

export function uniqueFragments(groups: Fragment[][]): Fragment[] {
  const seen = new Set<string>()
  const out: Fragment[] = []
  for (const group of groups) {
    for (const fragment of group) {
      if (seen.has(fragment.id)) continue
      seen.add(fragment.id)
      out.push(fragment)
    }
  }
  return out
}
