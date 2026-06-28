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

const BUILTIN_FRAGMENT_TYPES = new Set<string>(FRAGMENT_TYPES)
const BUILTIN_CONTEXT_LABELS: Record<string, string> = {
  guideline: 'Guidelines',
  knowledge: 'Knowledge',
  character: 'Characters',
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
  if (normalizedScope === 'pinned') return `Pinned ${normalized} (Summary Index)`
  if (normalizedScope === 'all') return `All ${normalized} (Summary Index)`
  return `${normalized} (Summary Index)`
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
    `Each bullet is a one-line summary, not the full fragment sheet. ${expand}`,
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
