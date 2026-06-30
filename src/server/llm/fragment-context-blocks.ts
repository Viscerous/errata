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

/** Collapse a value to a single pipe-table cell (no newlines, no pipe chars). */
function summaryCell(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
}

/**
 * The shared one-line identity for a fragment: `` `id` | name | desc ``. Used both
 * for shortlist rows and as the heading of a full sheet, so the model reads the
 * same `id | name | desc` grammar everywhere and distinguishes a full fragment
 * (a `###` heading followed by content) from a summary (a bare row) at a glance.
 */
export function fragmentSummaryLine(
  item: { id: string; name: string; description: string },
  note?: string,
): string {
  const name = `${item.name}${note ? ` (${note})` : ''}`
  return `\`${summaryCell(item.id)}\` | ${summaryCell(name)} | ${summaryCell(item.description)}`
}

/**
 * A full fragment sheet: the shared identity line as a `###` heading, then the
 * complete content. Distinct from a shortlist row (heading + body) yet cohesive
 * with it (same `id | name | desc` grammar), and it keeps the description that
 * proposals may target.
 */
export function renderFullFragmentSheet(f: Fragment): string {
  return `### ${fragmentSummaryLine(f)}\n${f.content}`
}

// ─── Shared block builders — one source for the house context grammar ───

/** The story header: the title as the prompt's single `#`, description beneath. */
export function storyHeaderContent(story: StoryMeta): string {
  return `# ${story.name}\n${story.description}`
}

/** Canonical heading for the rolling summary — one phrasing across every agent. */
export const STORY_SUMMARY_HEADING = 'Story Summary So Far'

export function storySummaryBlock(
  summary: string | undefined,
  opts: { order: number; id?: string; placeholder?: string },
): ContextBlock | null {
  const body = (summary?.trim() ? summary : opts.placeholder) ?? ''
  if (!body) return null
  return {
    id: opts.id ?? 'summary',
    role: 'user',
    content: `## ${STORY_SUMMARY_HEADING}\n${body}`,
    order: opts.order,
    source: 'builtin',
  }
}

/**
 * The recent-prose window — sections join as continuous manuscript, the end
 * marker fences prose off from whatever block follows — or, when no prose
 * exists yet, the new-story guidance (omitted entirely if none is given).
 */
export function proseWindowBlock(
  proseFragments: Fragment[],
  opts: { order: number; newStoryGuidance?: string },
): ContextBlock | null {
  if (proseFragments.length === 0) {
    if (!opts.newStoryGuidance) return null
    return {
      id: 'new-story',
      role: 'user',
      content: [
        '## New Story',
        'There is no existing prose yet. You are writing the very beginning of this story.',
        opts.newStoryGuidance,
        'Do NOT reference or continue from any prior narrative; start fresh.',
      ].join('\n'),
      order: opts.order,
      source: 'builtin',
    }
  }
  return {
    id: 'prose-recent',
    role: 'user',
    content: [
      '## Recent Prose',
      ...proseFragments.map(renderContextFragment),
      '## End of Recent Prose',
    ].join('\n\n'),
    order: opts.order,
    source: 'builtin',
  }
}

export function fragmentSummaryIndexHeading(label: string, scope?: FragmentContextScope | string): string {
  const normalized = label.trim() || 'Fragments'
  const normalizedScope = scope?.trim().toLowerCase()
  if (normalizedScope === 'pinned') return `Pinned ${normalized} (Shortlist)`
  if (normalizedScope === 'all') return `All ${normalized} (Shortlist)`
  return `${normalized} (Shortlist)`
}

export function fragmentSummaryList<T extends { id: string; name: string; description: string }>(
  heading: string,
  items: T[],
  opts: { editable?: boolean; summaryNote?: (item: T) => string | undefined } = {},
): string {
  const expand = opts.editable
    ? 'Read full fragments with readFragments before editing them or relying on details.'
    : 'Use readFragments to read the full fragment before relying on details.'
  return [
    `## ${heading}`,
    `Each line is a one-line summary, not the full fragment. Format: \`id\` | name | desc. ${expand}`,
    '',
    ...items.map((f) => fragmentSummaryLine(f, opts.summaryNote?.(f))),
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

  // Default full render is the literary form (name-first heading, no id): a
  // fragment already in full needs no lookup key, and ids stay confined to the
  // one machine surface — the `id | name | desc` shortlist rows. Agents that
  // edit fragments opt into renderFullFragmentSheet for id-bearing headings.
  // Blank-line separation is the default: with no per-fragment id markers,
  // spacing alone marks where one fragment ends and the next begins.
  const render = group.renderFragment ?? renderContextFragment
  return [
    `## ${heading}`,
    ...group.fragments.map(render),
  ].join(group.separator ?? '\n\n')
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
