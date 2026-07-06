import type { Fragment } from '../fragments/schema'
import type { FragmentContextLane } from './fragment-context-blocks'

export type ContextSelectionSource =
  | 'sticky'
  | 'recent-context'
  | 'writer-context'
  | 'current-observation'
  | 'router'
  | 'catalog'

export interface FragmentSignal {
  fragmentId: string
  sources: ContextSelectionSource[]
}

export interface AttentionProfile {
  runner: string
  maxFullOverall?: number
  maxFullPerType?: Record<string, number>
  includeStickyFull?: boolean
  includeRecentFull?: boolean
  fullSignalSources?: ContextSelectionSource[]
  catalogScope?: 'all' | 'available' | 'none'
}

export interface AttentionLaneSelection {
  type: string
  label: string
  full: Fragment[]
  catalog: Fragment[]
  omitted: Array<{ fragmentId: string; reason: string }>
}

export interface AttentionDiagnostics {
  runner: string
  promotedFull: Array<{ fragmentId: string; type: string; sources: ContextSelectionSource[] }>
  catalogOnly: Array<{ fragmentId: string; type: string; sources: ContextSelectionSource[] }>
  omitted: Array<{ fragmentId: string; type: string; reason: string; sources: ContextSelectionSource[] }>
  demoted: Array<{ fragmentId: string; type: string; reason: string; sources: ContextSelectionSource[] }>
  budgets: {
    maxFullOverall?: number
    maxFullPerType?: Record<string, number>
  }
}

export interface AttentionSelection {
  lanes: AttentionLaneSelection[]
  diagnostics: AttentionDiagnostics
}

export function contextSignalMap(params: {
  fragmentIds?: Iterable<string>
  signals?: Iterable<FragmentSignal>
  defaultSource?: ContextSelectionSource
} = {}): Map<string, Set<ContextSelectionSource>> {
  const defaultSource = params.defaultSource ?? 'current-observation'
  const signals = new Map<string, Set<ContextSelectionSource>>()
  for (const signal of params.signals ?? []) {
    signals.set(signal.fragmentId, new Set(signal.sources))
  }
  for (const fragmentId of params.fragmentIds ?? []) {
    const sources = signals.get(fragmentId) ?? new Set<ContextSelectionSource>()
    if (sources.size === 0) sources.add(defaultSource)
    signals.set(fragmentId, sources)
  }
  return signals
}

function pushSource(map: Map<string, Set<ContextSelectionSource>>, fragmentId: string | undefined, source: ContextSelectionSource): void {
  if (!fragmentId) return
  const sources = map.get(fragmentId) ?? new Set<ContextSelectionSource>()
  sources.add(source)
  map.set(fragmentId, sources)
}

export function collectRecentContextSignals(proseFragments: Fragment[]): Map<string, Set<ContextSelectionSource>> {
  const signals = new Map<string, Set<ContextSelectionSource>>()

  for (const prose of proseFragments) {
    const annotations = Array.isArray(prose.meta?.annotations)
      ? (prose.meta.annotations as Array<{ type?: string; fragmentId?: string }>)
      : []
    for (const annotation of annotations) {
      if (annotation.type === 'mention') {
        pushSource(signals, annotation.fragmentId, 'recent-context')
      }
    }

    const writerContextIds = Array.isArray(prose.meta?.writerContextIds)
      ? (prose.meta.writerContextIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : []
    for (const fragmentId of writerContextIds) {
      pushSource(signals, fragmentId, 'writer-context')
    }
  }

  return signals
}

export function recentContextSignalIds(proseFragments: Fragment[]): Set<string> {
  return new Set(collectRecentContextSignals(proseFragments).keys())
}

function sourcesFor(
  fragment: Fragment,
  lane: FragmentContextLane,
  extraSignals: Map<string, Set<ContextSelectionSource>>,
): ContextSelectionSource[] {
  const sources = new Set<ContextSelectionSource>(extraSignals.get(fragment.id) ?? [])
  if (lane.sticky.some((f) => f.id === fragment.id)) sources.add('sticky')
  if (lane.recent.some((f) => f.id === fragment.id)) {
    sources.add('recent-context')
  }
  if (lane.available.some((f) => f.id === fragment.id) || lane.all.some((f) => f.id === fragment.id)) {
    sources.add('catalog')
  }
  return [...sources]
}

function uniqueFragments(groups: Fragment[][]): Fragment[] {
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

function sourceRank(source: ContextSelectionSource): number {
  switch (source) {
    case 'current-observation': return 0
    case 'router': return 1
    case 'writer-context': return 2
    case 'recent-context': return 3
    case 'sticky': return 4
    case 'catalog': return 5
  }
}

function bestSourceRank(sources: ContextSelectionSource[]): number {
  return sources.reduce((best, source) => Math.min(best, sourceRank(source)), Number.POSITIVE_INFINITY)
}

function hasPromotedSignal(
  fragment: Fragment,
  extraSignals: Map<string, Set<ContextSelectionSource>>,
  fullSignalSources: Set<ContextSelectionSource>,
): boolean {
  const sources = extraSignals.get(fragment.id)
  if (!sources) return false
  return [...sources].some((source) => fullSignalSources.has(source))
}

export function selectAttentionContext(
  lanes: FragmentContextLane[],
  profile: AttentionProfile,
  extraSignals: Map<string, Set<ContextSelectionSource>> = new Map(),
): AttentionSelection {
  const promotedFull: AttentionDiagnostics['promotedFull'] = []
  const catalogOnly: AttentionDiagnostics['catalogOnly'] = []
  const omitted: AttentionDiagnostics['omitted'] = []
  const demoted: AttentionDiagnostics['demoted'] = []
  const selectedLanes: AttentionLaneSelection[] = []
  let fullTotal = 0
  const promotedSignalSources = new Set<ContextSelectionSource>(
    profile.fullSignalSources ?? ['current-observation', 'router', 'writer-context'],
  )

  for (const lane of lanes) {
    const fullCandidates = uniqueFragments([
      profile.includeStickyFull === false ? [] : lane.sticky,
      profile.includeRecentFull === false ? [] : lane.recent,
      lane.all.filter((fragment) => hasPromotedSignal(fragment, extraSignals, promotedSignalSources)),
    ]).sort((a, b) => {
      const aSources = sourcesFor(a, lane, extraSignals)
      const bSources = sourcesFor(b, lane, extraSignals)
      const rankDiff = bestSourceRank(aSources) - bestSourceRank(bSources)
      if (rankDiff !== 0) return rankDiff
      return a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    })
    const maxForType = profile.maxFullPerType?.[lane.type] ?? profile.maxFullPerType?.default
    const full: Fragment[] = []

    for (const fragment of fullCandidates) {
      const wouldExceedType = maxForType !== undefined && full.length >= maxForType
      const wouldExceedOverall = profile.maxFullOverall !== undefined && fullTotal >= profile.maxFullOverall
      const sources = sourcesFor(fragment, lane, extraSignals)
      if (wouldExceedType || wouldExceedOverall) {
        const reason = wouldExceedType ? 'demoted-by-type-budget' : 'demoted-by-overall-budget'
        demoted.push({ fragmentId: fragment.id, type: fragment.type, reason, sources })
        continue
      }
      full.push(fragment)
      fullTotal += 1
      promotedFull.push({ fragmentId: fragment.id, type: fragment.type, sources })
    }

    const fullIds = new Set(full.map((fragment) => fragment.id))
    const catalogSource = profile.catalogScope === 'none'
      ? []
      : profile.catalogScope === 'available'
        ? lane.available
        : lane.all
    const catalog = uniqueFragments([catalogSource]).filter((fragment) => !fullIds.has(fragment.id))
    for (const fragment of catalog) {
      catalogOnly.push({ fragmentId: fragment.id, type: fragment.type, sources: sourcesFor(fragment, lane, extraSignals) })
    }

    const catalogIds = new Set(catalog.map((fragment) => fragment.id))
    for (const fragment of lane.all) {
      if (fullIds.has(fragment.id) || catalogIds.has(fragment.id)) continue
      const reason = profile.catalogScope === 'none' ? 'catalog-disabled' : 'not-promoted'
      omitted.push({ fragmentId: fragment.id, type: fragment.type, reason, sources: sourcesFor(fragment, lane, extraSignals) })
    }

    if (full.length > 0 || catalog.length > 0) {
      selectedLanes.push({
        type: lane.type,
        label: lane.label,
        full,
        catalog,
        omitted: omitted
          .filter((entry) => entry.type === lane.type)
          .map((entry) => ({ fragmentId: entry.fragmentId, reason: entry.reason })),
      })
    }
  }

  return {
    lanes: selectedLanes,
    diagnostics: {
      runner: profile.runner,
      promotedFull,
      catalogOnly,
      omitted,
      demoted,
      budgets: {
        maxFullOverall: profile.maxFullOverall,
        maxFullPerType: profile.maxFullPerType,
      },
    },
  }
}
