import {
  BookMarked,
  BookOpen,
  Boxes,
  Database,
  FileText,
  Hash,
  Image,
  Landmark,
  MapPin,
  NotebookText,
  ScrollText,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { CustomFragmentType } from '@/lib/api'

export const BUILTIN_FRAGMENT_TYPES = new Set([
  'prose',
  'character',
  'guideline',
  'knowledge',
  'image',
  'icon',
  'marker',
  'summary',
])

export interface FragmentTypeVisual {
  type: string
  label: string
  singularLabel: string
  icon: string
  order: number
  isBuiltin: boolean
}

const BUILTIN_FRAGMENT_TYPE_VISUALS: Record<string, FragmentTypeVisual> = {
  prose: { type: 'prose', label: 'Prose', singularLabel: 'Prose', icon: 'FileText', order: 0, isBuiltin: true },
  guideline: { type: 'guideline', label: 'Guidelines', singularLabel: 'Guideline', icon: 'BookOpen', order: 10, isBuiltin: true },
  character: { type: 'character', label: 'Characters', singularLabel: 'Character', icon: 'Users', order: 20, isBuiltin: true },
  knowledge: { type: 'knowledge', label: 'Knowledge', singularLabel: 'Knowledge', icon: 'Database', order: 30, isBuiltin: true },
  image: { type: 'image', label: 'Images', singularLabel: 'Image', icon: 'Image', order: 40, isBuiltin: true },
  icon: { type: 'icon', label: 'Icons', singularLabel: 'Icon', icon: 'Sparkles', order: 50, isBuiltin: true },
  marker: { type: 'marker', label: 'Markers', singularLabel: 'Marker', icon: 'MapPin', order: 60, isBuiltin: true },
  summary: { type: 'summary', label: 'Summaries', singularLabel: 'Summary', icon: 'BookMarked', order: 70, isBuiltin: true },
}

export const FRAGMENT_TYPE_ICON_OPTIONS = [
  { value: 'Hash', label: 'Hash' },
  { value: 'FileText', label: 'Document' },
  { value: 'BookOpen', label: 'Book' },
  { value: 'BookMarked', label: 'Marked book' },
  { value: 'NotebookText', label: 'Notebook' },
  { value: 'ScrollText', label: 'Scroll' },
  { value: 'Database', label: 'Database' },
  { value: 'Users', label: 'People' },
  { value: 'MapPin', label: 'Map pin' },
  { value: 'Landmark', label: 'Landmark' },
  { value: 'Boxes', label: 'Boxes' },
  { value: 'Image', label: 'Image' },
  { value: 'Sparkles', label: 'Sparkles' },
] as const

const ICONS: Record<string, LucideIcon> = {
  Hash,
  FileText,
  BookOpen,
  BookMarked,
  NotebookText,
  ScrollText,
  Database,
  Users,
  MapPin,
  Landmark,
  Boxes,
  Image,
  Sparkles,
}

function customTypeMap(customTypes?: CustomFragmentType[] | Map<string, CustomFragmentType>): Map<string, CustomFragmentType> {
  if (!customTypes) return new Map()
  return Array.isArray(customTypes)
    ? new Map(customTypes.map((def) => [def.type, def]))
    : customTypes
}

export function titleFromFragmentType(type: string): string {
  return type
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function singularizeLabel(label: string): string {
  if (label.endsWith('ies')) return `${label.slice(0, -3)}y`
  if (label.endsWith('s') && !label.endsWith('ss')) return label.slice(0, -1)
  return label
}

export function inferFragmentTypeFromId(id: string): string | null {
  if (id.startsWith('pr-')) return 'prose'
  if (id.startsWith('ch-')) return 'character'
  if (id.startsWith('gl-')) return 'guideline'
  if (id.startsWith('kn-')) return 'knowledge'
  return null
}

export function getFragmentTypeVisual(
  type: string,
  customTypes?: CustomFragmentType[] | Map<string, CustomFragmentType>,
): FragmentTypeVisual {
  const builtin = BUILTIN_FRAGMENT_TYPE_VISUALS[type]
  if (builtin) return builtin

  const custom = customTypeMap(customTypes).get(type)
  const label = custom?.name?.trim() || titleFromFragmentType(type) || 'Custom Fragments'

  let order = 100
  if (customTypes) {
    const keys = Array.isArray(customTypes)
      ? customTypes.map((c) => c.type)
      : Array.from(customTypes.keys())
    const index = keys.indexOf(type)
    if (index >= 0) {
      order = 100 + index
    }
  }

  return {
    type,
    label,
    singularLabel: singularizeLabel(label),
    icon: custom?.icon || 'Database',
    order,
    isBuiltin: false,
  }
}

export function compareFragmentTypeVisuals(a: FragmentTypeVisual, b: FragmentTypeVisual): number {
  return a.order - b.order || a.label.localeCompare(b.label)
}

export function getFragmentTypeIconLabel(icon?: string) {
  return FRAGMENT_TYPE_ICON_OPTIONS.find((option) => option.value === icon)?.label ?? 'Hash'
}

export function FragmentTypeIcon({ icon, className }: { icon?: string; className?: string }) {
  const Icon = icon ? ICONS[icon] ?? Hash : Hash
  return <Icon className={className} />
}

export function FragmentTypeDisplayIcon({
  type,
  customTypes,
  className,
}: {
  type: string
  customTypes?: CustomFragmentType[] | Map<string, CustomFragmentType>
  className?: string
}) {
  return <FragmentTypeIcon icon={getFragmentTypeVisual(type, customTypes).icon} className={className} />
}
