import { registry } from '../fragments/registry'
import { FRAGMENT_TYPES, type Fragment, type StoryMeta } from '../fragments/schema'
import type { ContextBlock } from './context-builder'

export type FragmentContextMode = 'full' | 'summary-index'
export type FragmentContextScope = 'pinned' | 'recent' | 'available' | 'catalog' | 'all'

export interface FragmentContextMetadata {
  mode: FragmentContextMode
  scope: FragmentContextScope
  fragmentType: string
}

export interface FragmentContextGroup {
  id: string
  type: string
  label: string
  fragments: Fragment[]
  mode: FragmentContextMode
  scope: FragmentContextScope
  order: number
  role?: ContextBlock['role']
  editable?: boolean
  heading?: string
  summaryNote?: (fragment: Fragment) => string | undefined
  renderFragment?: (fragment: Fragment) => string
  separator?: string
}

export interface FragmentContextLane {
  type: string
  label: string
  sticky: Fragment[]
  recent: Fragment[]
  available: Fragment[]
  all: Fragment[]
}

export interface FragmentContextLaneSource {
  story: StoryMeta
  stickyGuidelines?: Fragment[]
  stickyKnowledge?: Fragment[]
  stickyCharacters?: Fragment[]
  stickyCustomFragments?: Fragment[]
  recentKnowledge?: Fragment[]
  recentCharacters?: Fragment[]
  recentCustomFragments?: Array<{ type: string; name: string; fragments: Fragment[] }>
  guidelineShortlist?: Fragment[]
  knowledgeShortlist?: Fragment[]
  characterShortlist?: Fragment[]
  customFragmentShortlists?: Array<{ type: string; name: string; fragments: Fragment[] }>
  allKnowledge?: Fragment[]
  allCharacters?: Fragment[]
  allCustomFragments?: Array<{ type: string; name: string; fragments: Fragment[] }>
}

const BUILTIN_FRAGMENT_TYPES = new Set<string>(FRAGMENT_TYPES)
const BUILTIN_CONTEXT_LABELS: Record<string, string> = {
  guideline: 'Guidelines',
  knowledge: 'Knowledge',
  character: 'Characters',
}

export function isBuiltinContextFragmentType(type: string): boolean {
  return BUILTIN_FRAGMENT_TYPES.has(type)
}

function titleFromType(type: string): string {
  return type
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function customContextFragmentTypes(story: StoryMeta): Array<{ type: string; name: string }> {
  const types = new Map<string, { type: string; name: string }>()

  for (const def of story.settings.customFragmentTypes ?? []) {
    if (BUILTIN_FRAGMENT_TYPES.has(def.type)) continue
    types.set(def.type, { type: def.type, name: def.name })
  }

  return [...types.values()]
}

export function fragmentTypeLabel(story: StoryMeta, type: string): string {
  const builtinLabel = BUILTIN_CONTEXT_LABELS[type]
  if (builtinLabel) return builtinLabel

  const custom = story.settings.customFragmentTypes?.find((def) => def.type === type)
  if (custom) return custom.name

  return titleFromType(type)
}

export function groupFragmentsByType(story: StoryMeta, fragments: Fragment[]): Array<{ type: string; label: string; fragments: Fragment[] }> {
  const groups = new Map<string, Fragment[]>()
  for (const fragment of fragments) {
    const group = groups.get(fragment.type) ?? []
    group.push(fragment)
    groups.set(fragment.type, group)
  }

  return [...groups.entries()].map(([type, group]) => ({
    type,
    label: fragmentTypeLabel(story, type),
    fragments: group,
  }))
}

function uniqueFragments(groups: Fragment[][]): Fragment[] {
  const seen = new Set<string>()
  const fragments: Fragment[] = []
  for (const group of groups) {
    for (const fragment of group) {
      if (seen.has(fragment.id)) continue
      seen.add(fragment.id)
      fragments.push(fragment)
    }
  }
  return fragments
}

function mergeLaneFragments(existing: Fragment[], incoming: Fragment[]): Fragment[] {
  return uniqueFragments([existing, incoming])
}

export function buildFragmentContextLanes(source: FragmentContextLaneSource): FragmentContextLane[] {
  const lanes = new Map<string, FragmentContextLane>()
  const ensureLane = (type: string, label = fragmentTypeLabel(source.story, type)): FragmentContextLane => {
    const existing = lanes.get(type)
    if (existing) {
      existing.label = label
      return existing
    }
    const lane: FragmentContextLane = {
      type,
      label,
      sticky: [],
      recent: [],
      available: [],
      all: [],
    }
    lanes.set(type, lane)
    return lane
  }

  const setSticky = (type: string, label: string, fragments: Fragment[] | undefined) => {
    const lane = ensureLane(type, label)
    lane.sticky = mergeLaneFragments(lane.sticky, fragments ?? [])
  }
  const setRecent = (type: string, label: string, fragments: Fragment[] | undefined) => {
    const lane = ensureLane(type, label)
    lane.recent = mergeLaneFragments(lane.recent, fragments ?? [])
  }
  const setAvailable = (type: string, label: string, fragments: Fragment[] | undefined) => {
    const lane = ensureLane(type, label)
    lane.available = mergeLaneFragments(lane.available, fragments ?? [])
  }
  const setAll = (type: string, label: string, fragments: Fragment[] | undefined) => {
    const lane = ensureLane(type, label)
    lane.all = mergeLaneFragments(lane.all, fragments ?? [])
  }

  setSticky('guideline', 'Guidelines', source.stickyGuidelines)
  setSticky('knowledge', 'Knowledge', source.stickyKnowledge)
  setSticky('character', 'Characters', source.stickyCharacters)
  setRecent('knowledge', 'Knowledge', source.recentKnowledge)
  setRecent('character', 'Characters', source.recentCharacters)
  setAvailable('guideline', 'Guidelines', source.guidelineShortlist)
  setAvailable('knowledge', 'Knowledge', source.knowledgeShortlist)
  setAvailable('character', 'Characters', source.characterShortlist)
  setAll('knowledge', 'Knowledge', source.allKnowledge)
  setAll('character', 'Characters', source.allCharacters)

  for (const def of customContextFragmentTypes(source.story)) {
    ensureLane(def.type, def.name)
  }
  for (const group of groupFragmentsByType(source.story, source.stickyCustomFragments ?? [])) {
    setSticky(group.type, group.label, group.fragments)
  }
  for (const group of source.recentCustomFragments ?? []) {
    setRecent(group.type, group.name, group.fragments)
  }
  for (const group of source.customFragmentShortlists ?? []) {
    setAvailable(group.type, group.name, group.fragments)
  }
  for (const group of source.allCustomFragments ?? []) {
    setAll(group.type, group.name, group.fragments)
  }

  return [...lanes.values()]
    .map((lane) => ({
      ...lane,
      all: lane.all.length > 0
        ? lane.all
        : uniqueFragments([lane.sticky, lane.recent, lane.available]),
    }))
    .filter((lane) => lane.sticky.length > 0 || lane.recent.length > 0 || lane.available.length > 0 || lane.all.length > 0)
}

export function findFragmentContextLane(lanes: FragmentContextLane[], type: string): FragmentContextLane | undefined {
  return lanes.find((lane) => lane.type === type)
}

function renderGenericFragmentContext(f: Fragment): string {
  return [
    `### ${f.name}`,
    f.description ? f.description : undefined,
    f.content,
  ].filter((part): part is string => Boolean(part)).join('\n')
}

export function renderContextFragment(f: Fragment): string {
  return registry.getType(f.type)
    ? registry.renderContext(f)
    : renderGenericFragmentContext(f)
}

export function renderFragmentWithMarker(f: Fragment): string {
  return `[@fragment=${f.id}]\n${renderContextFragment(f)}`
}

export function fragmentSummaryIndexHeading(label: string, scope?: FragmentContextScope | string): string {
  const normalized = label.trim() || 'Fragments'
  const normalizedScope = scope?.trim().toLowerCase()
  if (normalizedScope === 'pinned') return `Pinned ${normalized} (Shortlist)`
  if (normalizedScope === 'all') return `All ${normalized} (Shortlist)`
  return `${normalized} (Shortlist)`
}

export function fragmentSummaryList(
  heading: string,
  items: Array<{ id: string; name: string; description: string }>,
  opts: { editable?: boolean; summaryNote?: (item: { id: string; name: string; description: string }) => string | undefined } = {},
): string {
  const expand = opts.editable
    ? 'Read the full fragment with getFragment(id) before editing it or relying on details.'
    : 'Use getFragment(id) to read the full fragment before relying on details.'
  return [
    `## ${heading}`,
    `Each bullet is a one-line summary, not the full fragment. ${expand}`,
    ...items.map((f) => {
      const note = opts.summaryNote?.(f)
      return `- ${f.id}: ${f.name}${note ? ` (${note})` : ''} - ${f.description}`
    }),
  ].join('\n')
}

function fullContextHeading(label: string, scope: FragmentContextScope): string {
  if (scope === 'recent') return `${label} in Recent Prose`
  if (scope === 'pinned') return `Pinned ${label}`
  return label
}

export function renderFragmentContextGroup(group: FragmentContextGroup): string {
  const heading = group.heading
    ?? (group.mode === 'summary-index'
      ? fragmentSummaryIndexHeading(group.label, group.scope)
      : fullContextHeading(group.label, group.scope))

  if (group.mode === 'summary-index') {
    return fragmentSummaryList(heading, group.fragments, {
      editable: group.editable,
      summaryNote: group.summaryNote,
    })
  }

  const render = group.renderFragment ?? renderFragmentWithMarker
  return [
    `## ${heading}`,
    ...group.fragments.map(render),
  ].join(group.separator ?? '\n')
}

export function fragmentContextBlock(group: FragmentContextGroup): ContextBlock | null {
  if (group.fragments.length === 0) return null
  return {
    id: group.id,
    role: group.role ?? 'user',
    content: renderFragmentContextGroup(group),
    order: group.order,
    source: 'builtin',
    fragmentContext: {
      mode: group.mode,
      scope: group.scope,
      fragmentType: group.type,
    },
  }
}

export function fragmentContextBlocks(groups: FragmentContextGroup[]): ContextBlock[] {
  return groups
    .map(fragmentContextBlock)
    .filter((block): block is ContextBlock => block !== null)
}
