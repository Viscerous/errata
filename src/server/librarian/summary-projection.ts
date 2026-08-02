import type { Fragment } from '../fragments/schema'
import {
  getAnalysis,
  getAnalysisIndex,
  type LibrarianAnalysisIndex,
} from './storage'
import { proseContentHash } from './continuity-source'
import {
  listSummaryRollupNodes,
  markSummaryRollupNeeded,
  selectSummaryRollupFrontier,
  summaryRollupLeafId,
} from './summary-rollups'

export const SUMMARY_CONTRACT_VERSION = 1
export const SUMMARY_TOKEN_BUDGET = 3000
export const SUMMARY_RECENT_L0_COUNT = 6

export type SummaryReader =
  | 'generation.writer'
  | 'directions.suggest'
  | 'librarian.analyze'
  | 'editing'

export type SummaryGapReason = 'missing-analysis' | 'empty-summary' | 'unverified-source' | 'stale-source' | 'old-contract'

export interface SummaryProjectionItem {
  kind: 'contribution' | 'gap' | 'rollup'
  level: number
  proseId: string
  position: number
  endPosition?: number
  analysisId?: string
  nodeId?: string
  title?: string
  text?: string
  gapReason?: SummaryGapReason
  tokenCount: number
  rollupLeafId?: string
}

export interface AuthoredSummaryRecord {
  id: string
  name: string
  text: string
  validThrough?: string
}

export interface SummaryProjection {
  items: SummaryProjectionItem[]
  authored: AuthoredSummaryRecord[]
  firstRecentPosition?: number
  firstRecentProseId?: string
  omittedBefore?: { start: number; end: number }
  targetRelative: boolean
}

interface BuildSummaryProjectionParams {
  dataDir: string
  storyId: string
  /** Active prose in narrative order, already cut off before a regeneration target. */
  activeProseFragments: Fragment[]
  /** The exact prose window that will be rendered after the summary. */
  recentProseFragments: Fragment[]
  summaryFragments?: Fragment[]
  targetRelative?: boolean
  tokenBudget?: number
  analysisIndex?: LibrarianAnalysisIndex | null
  /** Marker-bounded segment identity parallel to activeProseFragments. */
  activeProseSegmentKeys?: string[]
}

const MAX_VIEW_CACHE_ENTRIES = 32
const viewCache = new Map<string, { signature: string; view: SummaryProjection }>()

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function cloneView(view: SummaryProjection): SummaryProjection {
  return structuredClone(view)
}

function cacheSet(key: string, signature: string, view: SummaryProjection): void {
  viewCache.delete(key)
  viewCache.set(key, { signature, view })
  while (viewCache.size > MAX_VIEW_CACHE_ENTRIES) {
    const oldest = viewCache.keys().next().value
    if (typeof oldest !== 'string') break
    viewCache.delete(oldest)
  }
}

function authoredRecords(
  summaries: Fragment[],
  activeIds: string[],
  targetRelative: boolean,
): AuthoredSummaryRecord[] {
  const positionById = new Map(activeIds.map((id, index) => [id, index]))
  return summaries
    .filter((fragment) => !fragment.archived && fragment.content.trim())
    .filter((fragment) => {
      if (!targetRelative) return true
      const validThrough = fragment.meta?.validThrough
      if (typeof validThrough !== 'string') return false
      // Target-relative callers already slice active prose before their target.
      // Membership in that prefix proves the record cannot contain future prose;
      // it need not end before the narrower recent-prose seam.
      return positionById.has(validThrough)
    })
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    .map((fragment) => ({
      id: fragment.id,
      name: fragment.name,
      text: fragment.content.trim(),
      ...(typeof fragment.meta?.validThrough === 'string'
        ? { validThrough: fragment.meta.validThrough }
        : {}),
    }))
}

function applyBudget(items: SummaryProjectionItem[], tokenBudget: number): {
  items: SummaryProjectionItem[]
  omittedBefore?: { start: number; end: number }
} {
  if (items.length === 0) return { items }

  // The six contributions nearest the prose seam are the minimum-resolution
  // band. Older L0 is admitted newest-first while budget remains. A future
  // derived-node frontier replaces those older entries without changing this
  // rendering contract.
  let used = 0
  let start = items.length
  for (let i = items.length - 1; i >= 0; i--) {
    const mustKeep = items.length - i <= SUMMARY_RECENT_L0_COUNT
    const next = items[i].tokenCount + 8 // passage label / markdown overhead
    if (!mustKeep && used + next > tokenBudget) break
    used += next
    start = i
  }

  if (start === 0) return { items }
  return {
    items: items.slice(start),
    omittedBefore: {
      start: items[0].position,
      end: items[start - 1].endPosition ?? items[start - 1].position,
    },
  }
}

export async function buildSummaryProjection(
  params: BuildSummaryProjectionParams,
): Promise<SummaryProjection> {
  const activeIds = params.activeProseFragments.map((fragment) => fragment.id)
  const recentIds = new Set(params.recentProseFragments.map((fragment) => fragment.id))
  const firstRecentIndex = params.activeProseFragments.findIndex((fragment) => recentIds.has(fragment.id))
  const boundary = firstRecentIndex >= 0 ? firstRecentIndex : params.activeProseFragments.length
  const targetRelative = params.targetRelative === true
  const index = 'analysisIndex' in params
    ? params.analysisIndex
    : await getAnalysisIndex(params.dataDir, params.storyId)
  const summaryFragments = params.summaryFragments ?? []
  const rollupNodes = await listSummaryRollupNodes(params.dataDir, params.storyId)

  const sourceSignatures = params.activeProseFragments.slice(0, boundary).map((fragment) => {
    const analysisId = index?.latestByFragmentId[fragment.id]?.analysisId ?? ''
    return `${fragment.id}:${proseContentHash(fragment)}:${analysisId}`
  })
  const authoredSignature = summaryFragments.map((fragment) => (
    `${fragment.id}:${fragment.updatedAt}:${fragment.archived ? 1 : 0}:${String(fragment.meta?.validThrough ?? '')}`
  ))
  const signature = [
    index?.updatedAt ?? '',
    boundary,
    targetRelative ? 1 : 0,
    params.tokenBudget ?? SUMMARY_TOKEN_BUDGET,
    ...(params.activeProseSegmentKeys ?? []),
    ...sourceSignatures,
    ...authoredSignature,
    ...rollupNodes.map((node) => `${node.id}:${node.artifactHash}`),
  ].join('|')
  const cacheKey = `${params.dataDir}\u0000${params.storyId}\u0000${activeIds.join(',')}\u0000${boundary}`
  const cached = viewCache.get(cacheKey)
  if (cached?.signature === signature) return cloneView(cached.view)

  const candidates = params.activeProseFragments.slice(0, boundary)
  const items = await Promise.all(candidates.map(async (fragment, indexInProjection): Promise<SummaryProjectionItem> => {
    const position = indexInProjection + 1
    const analysisId = index?.latestByFragmentId[fragment.id]?.analysisId
    if (!analysisId) {
      return { kind: 'gap', level: 0, proseId: fragment.id, position, gapReason: 'missing-analysis', tokenCount: 12 }
    }

    const analysis = await getAnalysis(params.dataDir, params.storyId, analysisId)
    if (!analysis?.summaryUpdate?.trim()) {
      return { kind: 'gap', level: 0, proseId: fragment.id, position, analysisId, gapReason: 'empty-summary', tokenCount: 12 }
    }
    if (!analysis.sourceRevision) {
      return { kind: 'gap', level: 0, proseId: fragment.id, position, analysisId, gapReason: 'unverified-source', tokenCount: 12 }
    }
    if (analysis.sourceRevision.contentHash !== proseContentHash(fragment)) {
      return { kind: 'gap', level: 0, proseId: fragment.id, position, analysisId, gapReason: 'stale-source', tokenCount: 12 }
    }
    if (analysis.summaryContractVersion !== SUMMARY_CONTRACT_VERSION) {
      return { kind: 'gap', level: 0, proseId: fragment.id, position, analysisId, gapReason: 'old-contract', tokenCount: 12 }
    }

    const text = analysis.summaryUpdate.trim()
    const sourceHash = analysis.sourceRevision.contentHash
    return {
      kind: 'contribution',
      level: 0,
      proseId: fragment.id,
      position,
      analysisId,
      text,
      tokenCount: estimateTokens(text),
      rollupLeafId: summaryRollupLeafId({
        proseId: fragment.id,
        analysisId,
        sourceHash,
        summary: text,
        contractVersion: analysis.summaryContractVersion,
      }),
    }
  }))

  const foldBeforeIndex = Math.max(0, items.length - SUMMARY_RECENT_L0_COUNT)
  const rollupFrontier = selectSummaryRollupFrontier(
    items.map((item) => item.kind === 'contribution' ? item.rollupLeafId ?? null : null),
    rollupNodes,
    foldBeforeIndex,
    params.activeProseSegmentKeys?.slice(0, boundary),
  )
  const rollupByStart = new Map(rollupFrontier.map((item) => [item.startIndex, item]))
  const projectedItems: SummaryProjectionItem[] = []
  for (let indexInProjection = 0; indexInProjection < items.length;) {
    const rollup = rollupByStart.get(indexInProjection)
    if (!rollup) {
      projectedItems.push(items[indexInProjection])
      indexInProjection += 1
      continue
    }
    projectedItems.push({
      kind: 'rollup',
      level: rollup.node.level,
      proseId: items[rollup.startIndex].proseId,
      position: items[rollup.startIndex].position,
      endPosition: items[rollup.endIndex].position,
      nodeId: rollup.node.id,
      title: rollup.node.title,
      text: rollup.node.text,
      tokenCount: rollup.node.tokenCount,
    })
    indexInProjection = rollup.endIndex + 1
  }

  const budgeted = applyBudget(projectedItems, params.tokenBudget ?? SUMMARY_TOKEN_BUDGET)
  const view: SummaryProjection = {
    items: budgeted.items,
    authored: authoredRecords(summaryFragments, activeIds, targetRelative),
    ...(boundary < params.activeProseFragments.length
      ? {
          firstRecentPosition: boundary + 1,
          firstRecentProseId: params.activeProseFragments[boundary].id,
        }
      : {}),
    ...(budgeted.omittedBefore ? { omittedBefore: budgeted.omittedBefore } : {}),
    targetRelative,
  }
  cacheSet(cacheKey, signature, view)
  if (budgeted.omittedBefore) markSummaryRollupNeeded(params.dataDir, params.storyId)
  return cloneView(view)
}

const GUIDANCE_BY_READER: Record<SummaryReader, string> = {
  'generation.writer': 'This is a compressed record of events that already happened. Do not continue from it as though it were the current scene, and do not promote compressed details into present-moment sensory facts.',
  'directions.suggest': 'Use this record for narrative shape and distance. Older threads may be reintroduced deliberately; they are not part of the current scene unless the recent prose makes them so.',
  'librarian.analyze': 'Use the coverage labels to avoid reporting material that was already recorded. The new prose remains the source of truth for this analysis.',
  editing: 'Use this as historical evidence while editing. Do not copy compressed narrative history into the target fragment as live prose.',
}

function gapText(reason: SummaryGapReason | undefined): string {
  switch (reason) {
    case 'stale-source': return 'summary unavailable because the passage changed after analysis'
    case 'unverified-source': return 'summary unavailable because its source revision cannot be verified'
    case 'old-contract': return 'summary unavailable until the passage is reanalyzed with the current memory contract'
    case 'empty-summary': return 'analysis exists but recorded no summary'
    default: return 'no current analysis summary is available'
  }
}

export function renderSummaryProjection(
  projection: SummaryProjection | undefined,
  reader: SummaryReader,
): string | null {
  if (!projection) return null
  if (projection.items.length === 0 && projection.authored.length === 0 && !projection.omittedBefore) return null

  const parts: string[] = [GUIDANCE_BY_READER[reader]]
  if (projection.authored.length > 0) {
    parts.push('### Authored Story Memory')
    for (const record of projection.authored) {
      parts.push(`#### ${record.name}\n${record.text}`)
    }
  }

  if (projection.omittedBefore) {
    const { start, end } = projection.omittedBefore
    parts.push(`_Passages ${start}\u2013${end} are omitted from this prompt by the story-memory token budget._`)
  }

  if (projection.items.length > 0) {
    parts.push('### Recent Story Record')
    for (const item of projection.items) {
      const endPosition = item.endPosition ?? item.position
      const label = endPosition > item.position
        ? `**Passages ${item.position}\u2013${endPosition}**`
        : `**Passage ${item.position}**`
      parts.push(item.kind === 'gap'
        ? `- ${label} \u2014 _Coverage gap: ${gapText(item.gapReason)}._`
        : item.kind === 'rollup'
          ? `- ${label} \u2014 **${item.title}**: ${item.text}`
          : `- ${label} \u2014 ${item.text}`)
    }
  }

  if (projection.firstRecentPosition !== undefined) {
    const last = projection.items.at(-1)
    if ((last?.endPosition ?? last?.position) === projection.firstRecentPosition - 1 && last?.kind !== 'gap') {
      parts.push(`The record is contiguous with the recent prose, which begins at Passage ${projection.firstRecentPosition}.`)
    } else {
      parts.push(`The recent prose begins at Passage ${projection.firstRecentPosition}; the preceding memory has a gap or budget seam.`)
    }
  }

  parts.push('## End of Story Summary')
  return parts.join('\n\n')
}
