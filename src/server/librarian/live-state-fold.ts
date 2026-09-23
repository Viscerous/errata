import {
  MOMENT_FIELD,
  liveStateFieldDefinition,
  liveStateFieldKey,
  liveStateItemId,
  type EndedLiveStateItem,
  type FoldedLiveState,
  type FoldedLiveStateItem,
  type LiveStateAdd,
  type LiveStateEdit,
  type LiveStateItemUpdate,
  type LiveStateKind,
  type LiveStateReport,
  type LiveStateSet,
  type LiveStateSource,
} from '@/contracts/live-state'
import type { SceneFrame } from '@/contracts/continuity'

const MAX_ACTIVE_ITEMS = 24
const MAX_ENDED_ITEMS = 24
const CLEARED_VALUES = new Set(['none', 'cleared', 'removed', 'healed', 'empty', 'normal', 'default', 'null', 'undefined', 'n/a'])

type NarrativeLine = SceneFrame['line']

interface FieldValue {
  field: string
  value: string
  source: LiveStateSource
  /** The frame's scene counter when the value was set. */
  scene: number
}

interface Subject {
  kind: LiveStateKind
  key: string
  fragmentId?: string
  name: string
  category?: FoldedLiveState['category']
  present: boolean
  source: LiveStateSource
  fields: Map<string, FieldValue>
  items: Map<string, FoldedLiveStateItem>
  ended: EndedLiveStateItem[]
}

interface SubjectIdentity {
  kind: LiveStateKind
  key: string
  fragmentId?: string
  name: string
  category?: FoldedLiveState['category']
}

/** A lasting-item operation made inside a flashback, replayed on return. */
interface CarriedOperation {
  subject: SubjectIdentity
  add?: LiveStateAdd
  update?: LiveStateItemUpdate
  source: LiveStateSource
}

interface LineFrame {
  line: NarrativeLine
  scene: number
  subjects: Map<string, Subject>
  carried: CarriedOperation[]
}

function subjectMapKey(kind: LiveStateKind, key: string): string {
  return `${kind}:${key}`
}

function cloneSubject(subject: Subject, keepFields: boolean): Subject {
  return {
    ...subject,
    fields: keepFields ? new Map(subject.fields) : new Map(),
    items: new Map(subject.items),
    ended: [...subject.ended],
  }
}

/**
 * Folds live-state reports and author corrections in reading order.
 *
 * Time is structural, never a value on an item. Each narrative line is a frame:
 * a flashback or flash-forward pushes an overlay and `return` pops it, so what
 * a flashback shows never replaces the present. Lasting items added or ended in
 * a flashback carry back on return, because the past it shows precedes the
 * present; a flash-forward's do not, because it has not happened yet. Scene
 * boundaries clear the moment and age last-known values.
 */
export class LiveStateFold {
  private readonly frames: LineFrame[] = [{ line: 'present', scene: 0, subjects: new Map(), carried: [] }]

  private get frame(): LineFrame {
    return this.frames[this.frames.length - 1]
  }

  /** An overlay keeps only lasting items: where someone is now is not where they were then. */
  enterLine(line: Exclude<NarrativeLine, 'present'>): void {
    const subjects = new Map<string, Subject>()
    for (const [key, subject] of this.frame.subjects) {
      subjects.set(key, { ...cloneSubject(subject, false), present: false })
    }
    this.frames.push({ line, scene: 0, subjects, carried: [] })
  }

  returnToPriorLine(): void {
    if (this.frames.length === 1) {
      this.sceneBoundary()
      return
    }
    const overlay = this.frames.pop()!
    if (overlay.line === 'flashback') {
      // Replayed through the recording path, so a flashback nested in another
      // flashback carries on to the outer line's return as well.
      for (const operation of overlay.carried) {
        const subject = this.subject(operation.subject, operation.source)
        this.recordLasting(subject, { add: operation.add, update: operation.update }, operation.source)
      }
    }
    this.sceneBoundary()
  }

  /** A cut, time skip, or line change starts a scene: the moment ends and nobody is placed yet. */
  sceneBoundary(): void {
    this.frame.scene += 1
    for (const subject of this.frame.subjects.values()) {
      subject.fields.delete(liveStateFieldKey(MOMENT_FIELD))
      subject.present = false
    }
  }

  /**
   * A passage's reports double as its roster: reported subjects are present and
   * everyone else is not, which also ends their moment. A passage without
   * reports says nothing about presence.
   */
  applyReports(reports: LiveStateReport[] | undefined, source: LiveStateSource): void {
    if (!reports) return
    const reported = new Set(reports.filter((report) => report.present).map((report) => subjectMapKey(report.kind, report.key)))
    for (const [key, subject] of this.frame.subjects) {
      if (reported.has(key)) continue
      subject.present = false
      subject.fields.delete(liveStateFieldKey(MOMENT_FIELD))
    }
    for (const report of reports) {
      const subject = this.subject(report, source)
      if (report.present) subject.present = true
      this.applyOperations(subject, report, source)
    }
  }

  applyEdit(edit: LiveStateEdit, source: LiveStateSource): void {
    const subject = this.subject(edit, source)
    this.applyOperations(subject, edit, source)
    for (const revision of edit.revise) {
      const item = subject.items.get(revision.id)
      if (item) subject.items.set(item.id, { ...item, ...source, text: revision.text })
    }
    // A removal corrects the record; it is not a story event and leaves no history.
    for (const id of edit.remove) subject.items.delete(id)
  }

  result(): FoldedLiveState[] {
    const frame = this.frame
    return [...frame.subjects.values()].map((subject) => ({
      ...subject.source,
      kind: subject.kind,
      key: subject.key,
      ...(subject.fragmentId ? { fragmentId: subject.fragmentId } : {}),
      name: subject.name,
      ...(subject.category ? { category: subject.category } : {}),
      present: subject.present,
      fields: [...subject.fields.values()].map((entry) => {
        const definition = liveStateFieldDefinition(subject.kind, entry.field, 'value')
        return {
          ...entry.source,
          field: entry.field,
          value: entry.value,
          holds: definition.holds,
          visibility: definition.visibility,
          scenesAgo: Math.max(frame.scene - entry.scene, 0),
        }
      }),
      items: [...subject.items.values()],
      ended: subject.ended,
    }))
  }

  private subject(identity: SubjectIdentity, source: LiveStateSource): Subject {
    const key = subjectMapKey(identity.kind, identity.key)
    const existing = this.frame.subjects.get(key)
    if (existing) {
      existing.name = identity.name || existing.name
      existing.fragmentId = identity.fragmentId ?? existing.fragmentId
      existing.category = identity.category ?? existing.category
      existing.source = source
      return existing
    }
    const created: Subject = {
      kind: identity.kind,
      key: identity.key,
      ...(identity.fragmentId ? { fragmentId: identity.fragmentId } : {}),
      name: identity.name,
      ...(identity.category ? { category: identity.category } : {}),
      present: false,
      source,
      fields: new Map(),
      items: new Map(),
      ended: [],
    }
    this.frame.subjects.set(key, created)
    return created
  }

  private applyOperations(
    subject: Subject,
    operations: { set: LiveStateSet[]; add: LiveStateAdd[]; update: LiveStateItemUpdate[] },
    source: LiveStateSource,
  ): void {
    for (const set of operations.set) {
      // A value written to a list field is an addition, whatever the operation said.
      if (liveStateFieldDefinition(subject.kind, set.field, 'value').holds === 'lasting') {
        if (set.value.trim()) {
          this.recordLasting(subject, { add: { id: liveStateItemId(set.field, set.value), field: set.field, text: set.value.trim() } }, source)
        }
        continue
      }
      const fieldKey = liveStateFieldKey(set.field)
      const value = set.value.trim()
      if (!value || CLEARED_VALUES.has(value.toLowerCase())) {
        subject.fields.delete(fieldKey)
        continue
      }
      subject.fields.set(fieldKey, {
        field: liveStateFieldDefinition(subject.kind, set.field, 'value').field,
        value,
        source,
        scene: this.frame.scene,
      })
    }
    for (const add of operations.add) this.recordLasting(subject, { add }, source)
    for (const update of operations.update) this.recordLasting(subject, { update }, source)
  }

  private recordLasting(
    subject: Subject,
    operation: { add?: LiveStateAdd; update?: LiveStateItemUpdate },
    source: LiveStateSource,
  ): void {
    if (operation.add) this.addItem(subject, operation.add, source)
    if (operation.update) this.updateItem(subject, operation.update, source)
    if (this.frame.line === 'flashback') {
      this.frame.carried.push({
        subject: {
          kind: subject.kind,
          key: subject.key,
          ...(subject.fragmentId ? { fragmentId: subject.fragmentId } : {}),
          name: subject.name,
          ...(subject.category ? { category: subject.category } : {}),
        },
        ...operation,
        source,
      })
    }
  }

  private addItem(subject: Subject, add: LiveStateAdd, source: LiveStateSource): void {
    const definition = liveStateFieldDefinition(subject.kind, add.field, 'item')
    // An item added to a value field is the new value of that field.
    if (definition.holds !== 'lasting') {
      subject.fields.set(liveStateFieldKey(add.field), {
        field: definition.field,
        value: add.text,
        source,
        scene: this.frame.scene,
      })
      return
    }
    const id = add.id || liveStateItemId(add.field, add.text)
    if (subject.items.has(id)) return
    subject.items.set(id, {
      ...source,
      id,
      field: definition.field,
      text: add.text,
      visibility: definition.visibility,
    })
    while (subject.items.size > MAX_ACTIVE_ITEMS) {
      subject.items.delete(subject.items.keys().next().value!)
    }
  }

  private updateItem(subject: Subject, update: LiveStateItemUpdate, source: LiveStateSource): void {
    const item = subject.items.get(update.id)
    if (!item) return
    subject.items.delete(update.id)
    subject.ended.push({
      ...item,
      happened: update.happened,
      ...(update.to?.length ? { to: update.to } : {}),
      ...(update.now ? { now: update.now.text } : {}),
      endedAt: source,
    })
    if (subject.ended.length > MAX_ENDED_ITEMS) subject.ended.splice(0, subject.ended.length - MAX_ENDED_ITEMS)
    if (update.happened === 'changed' && update.now) {
      this.addItem(subject, { id: update.now.id, field: item.field, text: update.now.text }, source)
    }
  }
}
