import type { Fragment } from '../fragments/schema'
import type { ContextBlock } from '../llm/context-builder'
import {
  fragmentContextBlock,
  fragmentContextBlocks,
  groupFragmentsByType,
  type FragmentContextGroup,
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

/** Pinned guideline, knowledge, character, and custom fragment summary indexes. */
export function pinnedFragmentSummaryGroups(
  ctx: AgentBlockContext,
  options: PinnedFragmentSummaryOptions = {},
): FragmentContextGroup[] {
  const excludeIds = new Set(options.excludeIds ?? [])
  const withoutExcluded = (fragments: Fragment[]): Fragment[] => fragments.filter((fragment) => !excludeIds.has(fragment.id))
  const groups: FragmentContextGroup[] = []
  const maybePush = (
    id: string,
    type: string,
    label: string,
    fragments: Fragment[],
    order: number,
  ) => {
    const filtered = withoutExcluded(fragments)
    if (filtered.length === 0) return
    groups.push({
      id,
      type,
      label,
      fragments: filtered,
      mode: 'summary-index',
      scope: 'pinned',
      order,
    })
  }

  if (shouldInclude(options.includeGuidelines)) {
    maybePush('guideline-pinned-summary-index', 'guideline', 'Guidelines', ctx.stickyGuidelines, 300)
  }
  if (shouldInclude(options.includeKnowledge)) {
    maybePush('knowledge-pinned-summary-index', 'knowledge', 'Knowledge', ctx.stickyKnowledge, 301)
  }
  if (shouldInclude(options.includeCharacters)) {
    maybePush('character-pinned-summary-index', 'character', 'Characters', ctx.stickyCharacters, 302)
  }

  if (shouldInclude(options.includeCustomFragments)) {
    let customOrder = 303
    for (const group of groupFragmentsByType(ctx.story, withoutExcluded(ctx.stickyCustomFragments ?? []))) {
      maybePush(`${group.type}-pinned-summary-index`, group.type, group.label, group.fragments, customOrder++)
    }
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

  if (shouldInclude(options.includeGuidelines)) {
    maybePush(summaryCatalogBlock('guideline-summary-index', 'guideline', 'Guidelines', [
      { fragments: ctx.stickyGuidelines, note: 'pinned' },
      { fragments: ctx.guidelineShortlist },
    ], 300))
  }

  if (shouldInclude(options.includeKnowledge)) {
    maybePush(summaryCatalogBlock('knowledge-summary-index', 'knowledge', 'Knowledge', [
      { fragments: ctx.stickyKnowledge, note: 'pinned' },
      { fragments: ctx.recentKnowledge ?? [], note: 'recent' },
      { fragments: ctx.knowledgeShortlist },
    ], 301))
  }

  if (shouldInclude(options.includeCharacters)) {
    maybePush(summaryCatalogBlock('character-summary-index', 'character', 'Characters', [
      { fragments: ctx.stickyCharacters, note: 'pinned' },
      { fragments: ctx.recentCharacters ?? [], note: 'recent' },
      { fragments: ctx.characterShortlist },
    ], 302))
  }

  if (shouldInclude(options.includeCustomFragments)) {
    interface CustomCatalogLane {
      type: string
      label: string
      pinned: Fragment[]
      recent: Fragment[]
      available: Fragment[]
    }
    const lanes = new Map<string, CustomCatalogLane>()
    const ensureLane = (type: string, label: string, preferLabel = false): CustomCatalogLane => {
      const existing = lanes.get(type)
      if (existing) {
        if (preferLabel) existing.label = label
        return existing
      }
      const lane = { type, label, pinned: [], recent: [], available: [] }
      lanes.set(type, lane)
      return lane
    }

    for (const group of groupFragmentsByType(ctx.story, ctx.stickyCustomFragments ?? [])) {
      ensureLane(group.type, group.label).pinned = group.fragments
    }
    for (const group of ctx.recentCustomFragments ?? []) {
      ensureLane(group.type, group.name, true).recent = group.fragments
    }
    for (const group of ctx.customFragmentShortlists ?? []) {
      ensureLane(group.type, group.name, true).available = group.fragments
    }

    let customOrder = 303
    for (const lane of lanes.values()) {
      maybePush(summaryCatalogBlock(`${lane.type}-summary-index`, lane.type, lane.label, [
        { fragments: lane.pinned, note: 'pinned' },
        { fragments: lane.recent, note: 'recent' },
        { fragments: lane.available },
      ], customOrder++))
    }
  }

  return blocks
}

/** All characters list for cross-reference. */
export function allCharactersBlock(ctx: AgentBlockContext): ContextBlock | null {
  if (!ctx.allCharacters || ctx.allCharacters.length === 0) return null
  return fragmentContextBlock({
    id: 'character-shortlist',
    type: 'character',
    label: 'Characters',
    fragments: ctx.allCharacters,
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

  maybePush(summaryIndexBlock('guideline-shortlist', 'guideline', 'Guidelines', ctx.guidelineShortlist, 400))
  maybePush(summaryIndexBlock('knowledge-shortlist', 'knowledge', 'Knowledge', ctx.knowledgeShortlist, 401))
  maybePush(summaryIndexBlock('character-shortlist', 'character', 'Characters', ctx.characterShortlist, 402))

  if (options.includeCustomFragments) {
    let customOrder = 403
    for (const group of ctx.customFragmentShortlists ?? []) {
      maybePush(summaryIndexBlock(`${group.type}-shortlist`, group.type, group.name, group.fragments, customOrder++))
    }
  }

  return blocks
}
