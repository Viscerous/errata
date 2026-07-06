import type { Fragment } from '../fragments/schema'
import type { ContextBlock } from '../llm/context-builder'
import {
  buildFragmentContextLanes,
  findFragmentContextLane,
  fragmentCatalogBlock,
  fragmentContextBlock,
  type FragmentContextLane,
} from '../llm/fragment-context-blocks'
import type { AgentBlockContext } from './agent-block-context'

type FragmentCatalogSection = { type: string; label: string; fragments: Fragment[] }

function catalogSectionsForLanes(
  lanes: FragmentContextLane[],
  options: {
    includeGuidelines?: boolean
    includeKnowledge?: boolean
    includeCharacters?: boolean
    includeCustomFragments?: boolean
  },
  fragmentsForLane: (lane: FragmentContextLane) => Fragment[],
): FragmentCatalogSection[] {
  return lanes
    .filter((lane) => includeLane(lane, options))
    .sort((a, b) => laneOrder(a, 303) - laneOrder(b, 303))
    .map((lane) => ({
      type: lane.type,
      label: lane.label,
      fragments: fragmentsForLane(lane),
    }))
}

export interface PinnedFragmentCatalogOptions {
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

/** Pinned guideline, knowledge, character, and custom fragments as one aggregate catalog. */
function pinnedFragmentCatalogSections(
  ctx: AgentBlockContext,
  options: PinnedFragmentCatalogOptions = {},
): FragmentCatalogSection[] {
  const excludeIds = new Set(options.excludeIds ?? [])
  return catalogSectionsForLanes(
    buildFragmentContextLanes(ctx),
    options,
    (lane) => lane.sticky.filter((fragment) => !excludeIds.has(fragment.id)),
  ).filter((section) => section.fragments.length > 0)
}

export function pinnedFragmentCatalogBlocks(
  ctx: AgentBlockContext,
  options: PinnedFragmentCatalogOptions = {},
): ContextBlock[] {
  const block = fragmentCatalogBlock({
    id: 'fragment-pinned-catalog',
    sections: pinnedFragmentCatalogSections(ctx, options),
    order: 303,
    heading: 'Pinned Fragment Catalog',
    scope: 'pinned',
  })
  return block ? [block] : []
}

function summaryCatalogSection(
  lane: FragmentContextLane,
): { type: string; label: string; fragments: Fragment[]; summaryNote: (fragment: Fragment) => string | undefined } {
  const fragments: Fragment[] = []
  const notes = new Map<string, string>()
  const seen = new Set<string>()

  for (const set of [
    { fragments: lane.sticky, note: 'pinned' },
    { fragments: lane.recent, note: 'recent' },
    { fragments: lane.available },
  ]) {
    for (const fragment of set.fragments) {
      if (seen.has(fragment.id)) continue
      seen.add(fragment.id)
      fragments.push(fragment)
      if (set.note) notes.set(fragment.id, set.note)
    }
  }

  return {
    type: lane.type,
    label: lane.label,
    fragments,
    summaryNote: (fragment: Fragment) => notes.get(fragment.id),
  }
}

export interface FragmentSummaryCatalogOptions {
  includeGuidelines?: boolean
  includeKnowledge?: boolean
  includeCharacters?: boolean
  includeCustomFragments?: boolean
}

/**
 * One aggregate catalog for tool-using contexts. Pinned and recent entries stay
 * visible as inline notes instead of becoming separate duplicate-looking blocks
 * of the same type.
 */
export function fragmentSummaryCatalogBlocks(
  ctx: AgentBlockContext,
  options: FragmentSummaryCatalogOptions = {},
): ContextBlock[] {
  const sections = buildFragmentContextLanes(ctx)
    .filter((lane) => includeLane(lane, options))
    .sort((a, b) => laneOrder(a, 303) - laneOrder(b, 303))
    .map(summaryCatalogSection)
  const block = fragmentCatalogBlock({
    id: 'fragment-catalog',
    sections,
    order: 303,
  })
  return block ? [block] : []
}

/** All characters as a narrow one-type catalog for cross-reference. */
export function allCharactersCatalogBlock(ctx: AgentBlockContext): ContextBlock | null {
  const characters = findFragmentContextLane(buildFragmentContextLanes(ctx), 'character')?.all ?? []
  if (characters.length === 0) return null
  return fragmentContextBlock({
    id: 'character-catalog',
    type: 'character',
    label: 'Characters',
    fragments: characters,
    mode: 'summary-index',
    scope: 'all',
    order: 350,
  })
}

export interface AvailableFragmentCatalogOptions {
  includeCustomFragments?: boolean
}

/** Available fragments not already pinned or promoted to full recent context. */
export function availableFragmentCatalogBlocks(ctx: AgentBlockContext, options: AvailableFragmentCatalogOptions = {}): ContextBlock[] {
  const lanes = buildFragmentContextLanes(ctx)
  const sections = catalogSectionsForLanes(lanes, {
    includeCustomFragments: options.includeCustomFragments === true,
  }, (lane) => lane.available)
  const block = fragmentCatalogBlock({
    id: 'fragment-catalog',
    sections,
    order: 400,
  })
  return block ? [block] : []
}
