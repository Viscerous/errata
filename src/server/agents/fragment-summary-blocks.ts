import type { Fragment } from '../fragments/schema'
import type { ContextBlock } from '../llm/context-builder'
import {
  buildFragmentContextLanes,
  findFragmentContextLane,
  fragmentContextBlock,
  fragmentContextBlocks,
  isBuiltinContextFragmentType,
  type FragmentContextGroup,
  type FragmentContextLane,
  type FragmentContextScope,
} from '../llm/fragment-context-blocks'
import type { AgentBlockContext } from './agent-block-context'

function summaryIndexBlock(
  id: string,
  type: string,
  label: string,
  items: Fragment[],
  order: number,
  scope: FragmentContextScope = 'available',
): ContextBlock | null {
  return fragmentContextBlock({
    id,
    type,
    label,
    fragments: items,
    mode: 'summary-index',
    scope,
    order,
  })
}

export interface PinnedFragmentSummaryOptions {
  includeGuidelines?: boolean
  includeKnowledge?: boolean
  includeCharacters?: boolean
  includeCustomFragments?: boolean
  excludeIds?: Iterable<string>
}

function shouldInclude(value: boolean | undefined): boolean {
  return value !== false
}

function includeLane(lane: FragmentContextLane, options: {
  includeGuidelines?: boolean
  includeKnowledge?: boolean
  includeCharacters?: boolean
  includeCustomFragments?: boolean
}): boolean {
  if (lane.type === 'guideline') return shouldInclude(options.includeGuidelines)
  if (lane.type === 'knowledge') return shouldInclude(options.includeKnowledge)
  if (lane.type === 'character') return shouldInclude(options.includeCharacters)
  return shouldInclude(options.includeCustomFragments)
}

function laneOrder(lane: FragmentContextLane, customBaseOrder: number): number {
  if (lane.type === 'guideline') return 300
  if (lane.type === 'knowledge') return 301
  if (lane.type === 'character') return 302
  return customBaseOrder
}

/** Pinned guideline, knowledge, character, and custom fragment summary indexes. */
export function pinnedFragmentSummaryGroups(
  ctx: AgentBlockContext,
  options: PinnedFragmentSummaryOptions = {},
): FragmentContextGroup[] {
  const excludeIds = new Set(options.excludeIds ?? [])
  const withoutExcluded = (fragments: Fragment[]): Fragment[] => fragments.filter((fragment) => !excludeIds.has(fragment.id))
  const groups: FragmentContextGroup[] = []
  let customOrder = 303
  for (const lane of buildFragmentContextLanes(ctx)) {
    if (!includeLane(lane, options)) continue
    const fragments = withoutExcluded(lane.sticky)
    if (fragments.length === 0) continue
    const order = laneOrder(lane, customOrder)
    if (!isBuiltinContextFragmentType(lane.type)) customOrder++
    groups.push({
      id: `${lane.type}-pinned-summary-index`,
      type: lane.type,
      label: lane.label,
      fragments,
      mode: 'summary-index',
      scope: 'pinned',
      order,
    })
  }

  return groups
}

export function pinnedFragmentSummaryBlocks(
  ctx: AgentBlockContext,
  options: PinnedFragmentSummaryOptions = {},
): ContextBlock[] {
  return fragmentContextBlocks(pinnedFragmentSummaryGroups(ctx, options))
}

interface SummaryCatalogSet {
  fragments: Fragment[]
  note?: string
}

function summaryCatalogBlock(
  id: string,
  type: string,
  label: string,
  sets: SummaryCatalogSet[],
  order: number,
): ContextBlock | null {
  const fragments: Fragment[] = []
  const notes = new Map<string, string>()
  const seen = new Set<string>()

  for (const set of sets) {
    for (const fragment of set.fragments) {
      if (seen.has(fragment.id)) continue
      seen.add(fragment.id)
      fragments.push(fragment)
      if (set.note) notes.set(fragment.id, set.note)
    }
  }

  return fragmentContextBlock({
    id,
    type,
    label,
    fragments,
    mode: 'summary-index',
    scope: 'catalog',
    order,
    summaryNote: (fragment) => notes.get(fragment.id),
  })
}

export interface FragmentSummaryCatalogOptions {
  includeGuidelines?: boolean
  includeKnowledge?: boolean
  includeCharacters?: boolean
  includeCustomFragments?: boolean
}

/**
 * One summary index per fragment type for tool-using catalog contexts. Pinned
 * and recent entries stay visible as inline notes instead of becoming separate
 * duplicate-looking blocks of the same type.
 */
export function fragmentSummaryCatalogBlocks(
  ctx: AgentBlockContext,
  options: FragmentSummaryCatalogOptions = {},
): ContextBlock[] {
  const blocks: ContextBlock[] = []
  const maybePush = (block: ContextBlock | null) => {
    if (block) blocks.push(block)
  }

  let customOrder = 303
  for (const lane of buildFragmentContextLanes(ctx)) {
    if (!includeLane(lane, options)) continue
    const order = laneOrder(lane, customOrder)
    if (!isBuiltinContextFragmentType(lane.type)) customOrder++
    maybePush(summaryCatalogBlock(`${lane.type}-summary-index`, lane.type, lane.label, [
      { fragments: lane.sticky, note: 'pinned' },
      { fragments: lane.recent, note: 'recent' },
      { fragments: lane.available },
    ], order))
  }

  return blocks
}

/** All characters list for cross-reference. */
export function allCharactersBlock(ctx: AgentBlockContext): ContextBlock | null {
  const characters = findFragmentContextLane(buildFragmentContextLanes(ctx), 'character')?.all ?? []
  if (characters.length === 0) return null
  return fragmentContextBlock({
    id: 'character-shortlist',
    type: 'character',
    label: 'Characters',
    fragments: characters,
    mode: 'summary-index',
    scope: 'all',
    order: 350,
  })
}

export interface ShortlistBlockOptions {
  includeCustomFragments?: boolean
}

/** Shortlist fragments not already pinned or promoted to full recent context. */
export function shortlistBlocks(ctx: AgentBlockContext, options: ShortlistBlockOptions = {}): ContextBlock[] {
  const blocks: ContextBlock[] = []
  const maybePush = (block: ContextBlock | null) => {
    if (block) blocks.push(block)
  }

  const lanes = buildFragmentContextLanes(ctx)
  maybePush(summaryIndexBlock('guideline-shortlist', 'guideline', 'Guidelines', findFragmentContextLane(lanes, 'guideline')?.available ?? [], 400))
  maybePush(summaryIndexBlock('knowledge-shortlist', 'knowledge', 'Knowledge', findFragmentContextLane(lanes, 'knowledge')?.available ?? [], 401))
  maybePush(summaryIndexBlock('character-shortlist', 'character', 'Characters', findFragmentContextLane(lanes, 'character')?.available ?? [], 402))

  if (options.includeCustomFragments) {
    let customOrder = 403
    for (const lane of lanes) {
      if (isBuiltinContextFragmentType(lane.type)) continue
      maybePush(summaryIndexBlock(`${lane.type}-shortlist`, lane.type, lane.label, lane.available, customOrder++))
    }
  }

  return blocks
}
