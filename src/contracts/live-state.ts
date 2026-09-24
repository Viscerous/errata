import { z } from 'zod/v4'
import { FragmentIdSchema } from './story'

/**
 * Live state: what is currently true of a character or entity, kept as named
 * fields and itemised lists.
 *
 * Field names are vocabulary, not schema. A story (and a model) may use any
 * field; the engine only acts on four structural properties, which a field
 * definition supplies and an unknown field defaults conservatively:
 *
 * - who the state belongs to (the subject key);
 * - who may see it (`outward`: others present can notice it; `inner`: only the
 *   character and the author know it);
 * - how long a value holds (`moment`: this moment only; `lastKnown`: until
 *   updated, rendered with its age; `lasting`: until something ends it);
 * - how an item ends (`revealed` to someone, `changed` into a new statement, or
 *   `resolved` because it stopped mattering).
 *
 * The model reports story events; the author corrects the record. A model
 * report can set a field, add an item, or end an item with a reason. Rewording
 * or deleting an item without a story reason is an author correction only.
 */

export type LiveStateKind = 'character' | 'entity'
export type LiveStateHolds = 'moment' | 'lastKnown' | 'lasting'
export type LiveStateVisibility = 'outward' | 'inner'

export const LIVE_STATE_HAPPENED = ['revealed', 'changed', 'resolved'] as const
export type LiveStateHappened = typeof LIVE_STATE_HAPPENED[number]

export const LIVE_STATE_ENTITY_CATEGORIES = ['location', 'artefact', 'faction', 'group', 'other'] as const
export type LiveStateEntityCategory = typeof LIVE_STATE_ENTITY_CATEGORIES[number]

export interface LiveStateFieldDefinition {
  field: string
  holds: LiveStateHolds
  visibility: LiveStateVisibility
  description: string
}

/** A catalog record's kind: a character sheet is a character, any other record an entity. */
export function liveStateKindOf(fragmentType: string): LiveStateKind {
  return fragmentType === 'character' ? 'character' : 'entity'
}

/** The field every subject has for what is true this moment. */
export const MOMENT_FIELD = 'Currently'

export const DEFAULT_LIVE_STATE_FIELDS: Record<LiveStateKind, LiveStateFieldDefinition[]> = {
  character: [
    { field: MOMENT_FIELD, holds: 'moment', visibility: 'outward', description: 'what they are doing, noticing, or feeling at this moment' },
    { field: 'Where', holds: 'lastKnown', visibility: 'outward', description: 'the place they are in' },
    { field: 'Appearance', holds: 'lastKnown', visibility: 'outward', description: 'clothing and visible look' },
    { field: 'Condition', holds: 'lastKnown', visibility: 'outward', description: 'injuries, exhaustion, or another physical or mental condition' },
    { field: 'Wants', holds: 'lastKnown', visibility: 'inner', description: 'what they are pursuing now' },
    { field: 'Knows', holds: 'lasting', visibility: 'inner', description: 'a fact they learned or a belief they now hold, which later scenes must respect; never what they do, notice, or feel in the moment' },
    { field: 'Secrets', holds: 'lasting', visibility: 'inner', description: 'what they hide or lie about' },
  ],
  entity: [
    { field: MOMENT_FIELD, holds: 'moment', visibility: 'outward', description: 'what is happening in or to it at this moment' },
    { field: 'Condition', holds: 'lastKnown', visibility: 'outward', description: 'its lasting physical condition' },
    { field: 'Notes', holds: 'lasting', visibility: 'outward', description: 'facts about it that matter to the story' },
  ],
}

/** Field identity ignores case, spacing, and punctuation. */
export function liveStateFieldKey(field: string): string {
  return field.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * The definition a field is folded and rendered by. An unknown field defaults to
 * inner, so nothing a model invents is shown to other characters, and to
 * `lastKnown` for a value or `lasting` for a list item.
 */
export function liveStateFieldDefinition(
  kind: LiveStateKind,
  field: string,
  shape: 'value' | 'item',
): LiveStateFieldDefinition {
  const key = liveStateFieldKey(field)
  const known = DEFAULT_LIVE_STATE_FIELDS[kind].find((definition) => liveStateFieldKey(definition.field) === key)
  if (known) return known
  return { field, holds: shape === 'item' ? 'lasting' : 'lastKnown', visibility: 'inner', description: '' }
}

/**
 * Item identity is derived from the field and the normalized statement, so the
 * same fact reported twice is the same item, and an analysis rerun addresses
 * the items it addressed before. A 53-bit FNV-1a hash keeps IDs short and works
 * identically in the browser and on the server.
 */
export function liveStateItemId(field: string, text: string): string {
  const input = `${liveStateFieldKey(field)}\u0000${liveStateFieldKey(text)}`
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const char of input) {
    hash ^= BigInt(char.codePointAt(0)!)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return (hash & 0x1fffffffffffffn).toString(36)
}

const fieldName = z.string().trim().min(1).max(60)
const statement = z.string().trim().min(1).max(300)
const subjectKey = z.string().trim().min(1).max(160)

export const LiveStateSetSchema = z.strictObject({
  field: fieldName,
  /** Empty clears the field. */
  value: z.string().trim().max(300),
})

export const LiveStateAddSchema = z.strictObject({
  id: z.string().min(1).max(32),
  field: fieldName,
  text: statement,
})

export const LiveStateItemUpdateSchema = z.strictObject({
  id: z.string().min(1).max(32),
  happened: z.enum(LIVE_STATE_HAPPENED),
  /** Subject keys an item was revealed to. */
  to: z.array(subjectKey).max(8).optional(),
  /** The statement a changed item now reads as; it becomes a new item. */
  now: LiveStateAddSchema.omit({ field: true }).optional(),
})

const liveStateSubject = {
  kind: z.enum(['character', 'entity']),
  key: subjectKey,
  fragmentId: FragmentIdSchema.optional(),
  name: z.string().trim().min(1).max(160),
  category: z.enum(LIVE_STATE_ENTITY_CATEGORIES).optional(),
}

/**
 * What one passage reports about one subject. A subject reported as present is
 * in the scene; one reported only because an item of theirs ended is not.
 */
export const LiveStateReportSchema = z.strictObject({
  ...liveStateSubject,
  present: z.boolean().default(true),
  set: z.array(LiveStateSetSchema).max(16).default([]),
  add: z.array(LiveStateAddSchema).max(16).default([]),
  update: z.array(LiveStateItemUpdateSchema).max(16).default([]),
})

export type LiveStateReport = z.infer<typeof LiveStateReportSchema>
export type LiveStateSet = z.infer<typeof LiveStateSetSchema>
export type LiveStateAdd = z.infer<typeof LiveStateAddSchema>
export type LiveStateItemUpdate = z.infer<typeof LiveStateItemUpdateSchema>

/**
 * An author correction to the record, applied after the passage it was made at
 * (`afterFragmentId`, null before any prose). Besides the story operations it
 * can reword an item or remove one outright, which a model report cannot.
 */
export const LiveStateEditSchema = z.strictObject({
  ...liveStateSubject,
  id: z.string().min(1).max(64),
  createdAt: z.string(),
  afterFragmentId: FragmentIdSchema.nullable(),
  set: z.array(LiveStateSetSchema).max(32).default([]),
  add: z.array(LiveStateAddSchema).max(32).default([]),
  update: z.array(LiveStateItemUpdateSchema).max(32).default([]),
  revise: z.array(z.strictObject({ id: z.string().min(1).max(32), text: statement })).max(32).default([]),
  remove: z.array(z.string().min(1).max(32)).max(32).default([]),
})

export type LiveStateEdit = z.infer<typeof LiveStateEditSchema>

export const LiveStateEditLogSchema = z.strictObject({
  version: z.literal(1),
  edits: z.array(LiveStateEditSchema).default([]),
})

export type LiveStateEditLog = z.infer<typeof LiveStateEditLogSchema>

// --- Folded shapes ---

export interface LiveStateSource {
  sourceFragmentId: string
  analysisId: string
  narrativePosition: number
}

export interface FoldedLiveStateField extends LiveStateSource {
  field: string
  value: string
  holds: LiveStateHolds
  visibility: LiveStateVisibility
  /** Scenes on the current narrative line since the value was set. */
  scenesAgo: number
}

export interface FoldedLiveStateItem extends LiveStateSource {
  id: string
  field: string
  text: string
  visibility: LiveStateVisibility
}

export interface EndedLiveStateItem extends FoldedLiveStateItem {
  happened: LiveStateHappened
  to?: string[]
  now?: string
  endedAt: LiveStateSource
}

export interface FoldedLiveState extends LiveStateSource {
  kind: LiveStateKind
  key: string
  fragmentId?: string
  name: string
  category?: LiveStateEntityCategory
  /** False means retained memory for a subject absent from the latest scene. */
  present: boolean
  fields: FoldedLiveStateField[]
  items: FoldedLiveStateItem[]
  /** Most recent last; bounded by the fold. */
  ended: EndedLiveStateItem[]
}

/** A numbered item as the analyst sees it; the number is how a report addresses it. */
export interface LiveStateRegistryEntry {
  index: number
  kind: LiveStateKind
  subjectKey: string
  subjectName: string
  id: string
  field: string
  text: string
}
