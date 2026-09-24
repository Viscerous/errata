import { z } from 'zod/v4'
import type { Fragment } from '@/contracts/story'
import { FragmentIdSchema } from '@/contracts/story'
import {
  DEFAULT_LIVE_STATE_FIELDS,
  LIVE_STATE_ENTITY_CATEGORIES,
  LIVE_STATE_HAPPENED,
  liveStateFieldDefinition,
  liveStateKindOf,
  liveStateItemId,
  type LiveStateKind,
  type LiveStateRegistryEntry,
  type LiveStateReport,
} from '@/contracts/live-state'
import { normalizeContinuityKey } from '@/lib/continuity-keys'

/**
 * The continuity tool's live-state boundary: what a model may say about a
 * character or entity in one passage, and how that becomes a stored report.
 *
 * Numbers address items the prompt showed, so the item, and whose it is, comes
 * from the registry rather than from which character the model listed it under.
 */

const MAX_KEY_CHARS = 64
const CLEARED_VALUES = new Set(['none', 'cleared', 'removed', 'healed', 'empty', 'normal', 'default', 'null', 'undefined', 'n/a'])

function describeFields(kind: LiveStateKind, holds: 'value' | 'list'): string {
  return DEFAULT_LIVE_STATE_FIELDS[kind]
    .filter((definition) => (holds === 'list') === (definition.holds === 'lasting'))
    .map((definition) => `${definition.field} (${definition.description})`)
    .join('; ')
}

function forgivingList<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess((value) => {
    const items = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
    return items.filter((entry) => item.safeParse(entry).success).slice(0, max)
  }, z.array(item).max(max)).optional()
}

const fieldInput = z.string().trim().min(1).max(40)
const textInput = z.string().trim().min(1).max(160)
const itemNumber = z.preprocess((value) => {
  const number = typeof value === 'string' ? Number.parseInt(value.replace(/^\[|\]$/g, ''), 10) : value
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : undefined
}, z.number().int().positive())

function changesShape(kind: LiveStateKind) {
  return {
    set: forgivingList(z.object({ field: fieldInput, value: z.string().trim().max(160) }), 5)
      .describe(`Fields this passage establishes or changes. Suggested: ${describeFields(kind, 'value')}. Other field names are allowed. An empty value clears a field.`),
    add: forgivingList(z.object({ field: fieldInput, text: textInput }), 3)
      .describe(`New entries this passage establishes for a lasting list, each still true after this scene ends. Suggested: ${describeFields(kind, 'list')}. Numbered entries already shown stay recorded without repeating them.`),
  }
}

/**
 * Endings sit beside the characters rather than under one: the number already
 * says whose entry it is, and the bound is per passage rather than per person.
 * Named for what they are: a list named for updating reads as the place to
 * restate where things stand, which turns a standing fact into the moment.
 */
export const LiveStateEndingsInputSchema = forgivingList(z.object({
  item: itemNumber.describe('The number of an entry shown under "Where things stand".'),
  happened: z.enum(LIVE_STATE_HAPPENED)
    .describe('revealed: a hidden entry, usually a secret, became known to others (name them in to); changed: the story made it untrue, and a new fact of the same kind replaces it (say it in now); resolved: it no longer matters.'),
  to: forgivingList(z.string().trim().min(1).max(80), 3)
    .describe('For revealed: who learned it, by catalog ID or name.'),
  now: z.string().trim().max(160).optional()
    .describe('For changed: the fact that is true instead.'),
}), 6)
  .describe('Numbered entries this passage ends because the story ended them. An entry stays true until then; what someone is doing now belongs in their moment field, never here. Use empty [] if none.')

export type LiveStateEndingsInput = z.infer<typeof LiveStateEndingsInputSchema>

/**
 * The scene roster is a list of references, apart from the changes: a crowd
 * costs a few IDs rather than one formulaic entry per onlooker, and nobody with
 * a real change is crowded out of the bounded change list.
 */
export const LiveStatePresentInputSchema = forgivingList(z.string().trim().min(1).max(80), 16)
  .describe('Every character in the scene of this passage, by catalog ID or name, whether or not anything changed for them.')

export const CharacterReportInputSchema = z.object({
  character: z.string().trim().min(1).max(80).describe('One individual person: catalog ID when available, otherwise the name. A crowd or other collective is an entity.'),
  ...changesShape('character'),
})

export const EntityReportInputSchema = z.object({
  entity: z.string().trim().min(1).max(80).describe('Catalog ID when available; otherwise the name.'),
  category: z.enum(LIVE_STATE_ENTITY_CATEGORIES).optional()
    .describe('group for a crowd, audience, or other collective of people.'),
  ...changesShape('entity'),
})

export type CharacterReportInput = z.infer<typeof CharacterReportInputSchema>
export type EntityReportInput = z.infer<typeof EntityReportInputSchema>

/** The reference a report names, for callers that prefetch catalog records. */
export function reportRef(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const ref = record.character ?? record.entity
  return typeof ref === 'string' ? ref.trim() : ''
}

interface SubjectIdentity {
  kind: LiveStateKind
  key: string
  fragmentId?: string
  name: string
}

export interface LiveStateSkip {
  kind: string
  key: string
  reason: string
}

/**
 * Entry numbers are how the prompt addresses entries, never part of one. A
 * model copying a shown entry brings its number along, and one adding new
 * entries may continue the numbering ("6] ...", "6. ..."). Stripping it gives a
 * copy the identity of the entry it copied and a new entry its plain text.
 */
function statementText(text: string): string {
  return text
    .replace(/^\s*(?:\[?\d+\]\s*)+/, '')
    .replace(/^\s*\d{1,2}[.)]\s+/, '')
    // Sentence citations are how evidence is addressed, not part of a statement.
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\s*[,\]]?\s*$/, '')
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '')
    .trim()
}

function subjectKeyFor(name: string): string {
  return normalizeContinuityKey(name).slice(0, MAX_KEY_CHARS)
}

/**
 * Resolve a reference to a subject: a catalog record by ID or name, a name the
 * registry already knows, or else a new named subject. A catalog record decides
 * its own kind, and a name is one subject whichever list reported it, so the
 * same person reported as a character and as an entity stays one subject.
 */
function resolveSubject(
  kind: LiveStateKind,
  ref: string,
  checkedFragments: Map<string, Fragment> | undefined,
  known: SubjectIdentity[],
): SubjectIdentity | null {
  // A parenthetical is commentary on the reference ("Victoria (narrator)"), not part of the name.
  const trimmed = ref.replace(/\s*\([^)]*\)/g, '').trim()
  if (!trimmed) return null
  const catalogSubject = (id: string, fragment: Fragment): SubjectIdentity | null => (
    fragment.type === 'prose' ? null : { kind: liveStateKindOf(fragment.type), key: id, fragmentId: id, name: fragment.name }
  )
  if (FragmentIdSchema.safeParse(trimmed).success) {
    const fragment = checkedFragments?.get(trimmed)
    if (fragment) return catalogSubject(trimmed, fragment)
    const registered = known.find((subject) => subject.key === trimmed)
    if (registered) return registered
    if (!checkedFragments) return { kind, key: trimmed, fragmentId: trimmed, name: trimmed }
    return null
  }
  const lowered = trimmed.toLocaleLowerCase()
  const named = [...checkedFragments ?? []]
    .filter(([, fragment]) => fragment.type !== 'prose' && fragment.name.trim().toLocaleLowerCase() === lowered)
  const [id, fragment] = named.find(([, candidate]) => liveStateKindOf(candidate.type) === kind) ?? named[0] ?? []
  if (id && fragment) return catalogSubject(id, fragment)
  const key = subjectKeyFor(trimmed)
  if (!key) return null
  const registered = known.find((subject) => subject.key === key || subject.name.toLocaleLowerCase() === lowered)
  return registered ?? { kind, key, name: trimmed }
}

/**
 * Turn one passage's character and entity entries into stored reports.
 *
 * Every listed subject is present. A value written to a list field becomes an
 * entry and an entry written to a value field becomes its value, so the field's
 * definition, not the operation the model chose, decides the shape. An ending is
 * attached to the numbered item's owner; an owner not listed as present is
 * reported without being placed in the scene.
 */
export function normalizeLiveStateReports(
  input: { present?: string[]; characters?: unknown[]; entities?: unknown[]; endedEntries?: LiveStateEndingsInput },
  registryItems: LiveStateRegistryEntry[],
  checkedFragments?: Map<string, Fragment>,
): { reports: LiveStateReport[]; skipped: LiveStateSkip[] } {
  const skipped: LiveStateSkip[] = []
  const reports = new Map<string, LiveStateReport>()
  const known: SubjectIdentity[] = []
  for (const item of registryItems) {
    if (known.some((subject) => subject.key === item.subjectKey)) continue
    known.push({
      kind: item.kind,
      key: item.subjectKey,
      ...(FragmentIdSchema.safeParse(item.subjectKey).success ? { fragmentId: item.subjectKey } : {}),
      name: item.subjectName,
    })
  }
  const reportFor = (subject: SubjectIdentity, present: boolean): LiveStateReport => {
    const mapKey = subject.key
    const existing = reports.get(mapKey)
    if (existing) {
      if (present) existing.present = true
      return existing
    }
    const created: LiveStateReport = {
      kind: subject.kind,
      key: subject.key,
      ...(subject.fragmentId ? { fragmentId: subject.fragmentId } : {}),
      name: subject.name,
      present,
      set: [],
      add: [],
      update: [],
    }
    reports.set(mapKey, created)
    if (!known.some((entry) => entry.key === subject.key)) known.push(subject)
    return created
  }

  // Parsed here as well as at the tool boundary, which a direct caller skips.
  const entries: Array<{ kind: LiveStateKind; ref: string; category?: LiveStateReport['category']; changes: CharacterReportInput }> = []
  for (const raw of input.characters ?? []) {
    const parsed = CharacterReportInputSchema.safeParse(raw)
    if (parsed.success) entries.push({ kind: 'character', ref: parsed.data.character, changes: parsed.data })
    else skipped.push({ kind: 'character', key: reportRef(raw), reason: 'A character entry needs a character reference.' })
  }
  for (const raw of input.entities ?? []) {
    const parsed = EntityReportInputSchema.safeParse(raw)
    if (parsed.success) {
      entries.push({ kind: 'entity', ref: parsed.data.entity, category: parsed.data.category, changes: { ...parsed.data, character: parsed.data.entity } })
    } else {
      skipped.push({ kind: 'entity', key: reportRef(raw), reason: 'An entity entry needs an entity reference.' })
    }
  }

  for (const entry of entries) {
    const subject = resolveSubject(entry.kind, entry.ref, checkedFragments, known)
    if (!subject) {
      skipped.push({ kind: entry.kind, key: entry.ref, reason: `"${entry.ref}" is not a ${entry.kind} in the catalog; use its catalog ID or its name.` })
      continue
    }
    const report = reportFor(subject, true)
    if (entry.category) report.category = entry.category

    const addEntry = (field: string, raw: string) => {
      const text = statementText(raw)
      if (!text || report.add.some((existing) => existing.id === liveStateItemId(field, text))) return
      report.add.push({ id: liveStateItemId(field, text), field, text })
    }
    for (const { field, value } of entry.changes.set ?? []) {
      const lasting = liveStateFieldDefinition(entry.kind, field, 'value').holds === 'lasting'
      if (lasting) {
        if (value.trim()) addEntry(field, value.trim())
        continue
      }
      const text = statementText(value)
      report.set.push({ field, value: CLEARED_VALUES.has(text.toLowerCase()) ? '' : text })
    }
    for (const { field, text } of entry.changes.add ?? []) {
      if (liveStateFieldDefinition(entry.kind, field, 'item').holds !== 'lasting') {
        report.set.push({ field, value: statementText(text) })
        continue
      }
      addEntry(field, text)
    }
  }

  // The roster places known subjects; it cannot introduce one. A bare name with
  // nothing reported about it would be a subject with nothing to say.
  for (const ref of input.present ?? []) {
    const subject = resolveSubject('character', ref, checkedFragments, known)
    if (subject && (subject.fragmentId || known.some((entry) => entry.key === subject.key))) reportFor(subject, true)
    else skipped.push({ kind: 'character', key: ref, reason: `"${ref}" is not a known character; report them under characters with what this passage establishes.` })
  }

  for (const update of input.endedEntries ?? []) {
    const item = registryItems.find((candidate) => candidate.index === update.item)
    if (!item) {
      skipped.push({ kind: 'item', key: String(update.item), reason: `No entry [${update.item}] is shown under "Where things stand".` })
      continue
    }
    const owner = known.find((candidate) => candidate.key === item.subjectKey)
      ?? { kind: item.kind, key: item.subjectKey, name: item.subjectName }
    const ownerReport = reportFor(owner, false)
    if (ownerReport.update.some((existing) => existing.id === item.id)) continue
    const to = (update.to ?? [])
      .map((ref) => resolveSubject('character', ref, checkedFragments, known)?.key)
      .filter((key): key is string => Boolean(key))
    const nowText = update.happened === 'changed' && update.now ? statementText(update.now) : ''
    const now = nowText ? { id: liveStateItemId(item.field, nowText), text: nowText } : undefined
    // A reveal names who learned it; one that names nobody is only an ending.
    const happened = update.happened === 'revealed' && to.length === 0 ? 'resolved' : update.happened
    ownerReport.update.push({
      id: item.id,
      happened,
      ...(happened === 'revealed' ? { to: [...new Set(to)] } : {}),
      ...(now ? { now } : {}),
    })
  }

  return { reports: [...reports.values()], skipped }
}
