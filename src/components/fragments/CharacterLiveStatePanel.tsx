import { useId, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, BookOpen, Check, History, Layers, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, type Fragment } from '@/lib/api'
import { q, qk, useActiveBranchId } from '@/lib/query-keys'
import { DEFAULT_LIVE_STATE_FIELDS } from '@/contracts/live-state'
import { describeAge, describeEnding, fieldOrder, groupItems, listStyle, liveStateFor } from './live-state-display'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/prose-text'
import { Input } from '@/components/ui/input'

interface CharacterLiveStatePanelProps {
  storyId: string
  fragment: Fragment
}

interface FieldRow {
  field: string
  value: string
}

interface ItemRow {
  id?: string
  field: string
  text: string
}

const MAX_SHOWN_ENDED = 5
const CHARACTER_FIELDS = DEFAULT_LIVE_STATE_FIELDS.character
const VALUE_FIELD_NAMES = CHARACTER_FIELDS.filter((definition) => definition.holds !== 'lasting').map((definition) => definition.field)
const LIST_FIELD_NAMES = CHARACTER_FIELDS.filter((definition) => definition.holds === 'lasting').map((definition) => definition.field)

export function CharacterLiveStatePanel({ storyId, fragment }: CharacterLiveStatePanelProps) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const valueFieldListId = useId()
  const listFieldListId = useId()

  const { data: continuityData } = useQuery({
    ...q.librarianContinuity(storyId, branchId),
    enabled: !!storyId,
  })

  const subjects = useMemo(
    () => continuityData?.view?.liveStates ?? continuityData?.ledger?.liveStates ?? [],
    [continuityData],
  )
  const liveState = useMemo(() => liveStateFor(subjects, fragment), [subjects, fragment])
  const names = useMemo(() => new Map(subjects.map((subject) => [subject.key, subject.name])), [subjects])

  const fields = useMemo(
    () => [...(liveState?.fields ?? [])].sort((left, right) => fieldOrder(left.field) - fieldOrder(right.field)),
    [liveState],
  )
  const itemGroups = useMemo(() => groupItems(liveState?.items ?? []), [liveState])
  const ended = useMemo(() => [...(liveState?.ended ?? [])].reverse().slice(0, MAX_SHOWN_ENDED), [liveState])

  const [isEditing, setIsEditing] = useState(false)
  const [fieldRows, setFieldRows] = useState<FieldRow[]>([])
  const [itemRows, setItemRows] = useState<ItemRow[]>([])

  const startEditing = () => {
    setFieldRows(fields.map((field) => ({ field: field.field, value: field.value })))
    setItemRows((liveState?.items ?? []).map((item) => ({ id: item.id, field: item.field, text: item.text })))
    setIsEditing(true)
  }

  const updateMutation = useMutation({
    mutationFn: () => api.librarian.updateLiveState(storyId, 'character', liveState?.key ?? fragment.id, {
      fields: fieldRows
        .map((row) => ({ field: row.field.trim(), value: row.value.trim() }))
        .filter((row) => row.field && row.value),
      items: itemRows
        .map((row) => ({ ...(row.id ? { id: row.id } : {}), field: row.field.trim(), text: row.text.trim() }))
        .filter((row) => row.field && row.text),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.librarianContinuity(storyId, branchId) })
      setIsEditing(false)
    },
  })

  const momentField = fields.find((field) => field.holds === 'moment')
  const otherFields = fields.filter((field) => field !== momentField)
  const hasContent = fields.length > 0 || itemGroups.length > 0 || ended.length > 0

  const editButton = !isEditing && (
    <div className="flex justify-end">
      <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={startEditing}>
        <Pencil className="size-3" />
        {hasContent ? 'Edit State' : 'Add state'}
      </Button>
    </div>
  )

  if (isEditing) {
    return (
      <section className="space-y-4 px-6 py-5">
        <datalist id={valueFieldListId}>
          {VALUE_FIELD_NAMES.map((name) => <option key={name} value={name} />)}
        </datalist>
        <datalist id={listFieldListId}>
          {LIST_FIELD_NAMES.map((name) => <option key={name} value={name} />)}
        </datalist>

        <div className="space-y-5 rounded-md border border-border/60 bg-muted/20 p-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Layers className="size-3.5 text-blue-500" />
                Fields
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => setFieldRows((rows) => [...rows, { field: '', value: '' }])}
              >
                <Plus className="size-3" /> Add Field
              </Button>
            </div>
            <Hint className="text-[11px]">Currently, Where, Appearance, Condition, Wants, or any field of your own.</Hint>
            <div className="space-y-1.5">
              {fieldRows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={row.field}
                    list={valueFieldListId}
                    onChange={(event) => {
                      const field = event.target.value
                      setFieldRows((rows) => rows.map((candidate, i) => (i === index ? { ...candidate, field } : candidate)))
                    }}
                    placeholder="Field"
                    aria-label="Field"
                    className="h-7 w-1/3 text-xs"
                  />
                  <Input
                    value={row.value}
                    onChange={(event) => {
                      const value = event.target.value
                      setFieldRows((rows) => rows.map((candidate, i) => (i === index ? { ...candidate, value } : candidate)))
                    }}
                    placeholder="driving to the harbour"
                    aria-label="Value"
                    className="h-7 flex-1 text-xs"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    aria-label="Remove field"
                    onClick={() => setFieldRows((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <BookOpen className="size-3.5 text-emerald-500" />
                Entries
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => setItemRows((rows) => [...rows, { field: 'Knows', text: '' }])}
              >
                <Plus className="size-3" /> Add Entry
              </Button>
            </div>
            <Hint className="text-[11px]">Lasting lists such as Knows and Secrets.</Hint>
            <div className="space-y-1.5">
              {itemRows.map((row, index) => (
                <div key={row.id ?? `new-${index}`} className="flex items-center gap-2">
                  <Input
                    value={row.field}
                    list={listFieldListId}
                    onChange={(event) => {
                      const field = event.target.value
                      setItemRows((rows) => rows.map((candidate, i) => (i === index ? { ...candidate, field } : candidate)))
                    }}
                    placeholder="List"
                    aria-label="List"
                    className="h-7 w-1/3 text-xs"
                  />
                  <Input
                    value={row.text}
                    onChange={(event) => {
                      const text = event.target.value
                      setItemRows((rows) => rows.map((candidate, i) => (i === index ? { ...candidate, text } : candidate)))
                    }}
                    placeholder="the harbour gate is unguarded at night"
                    aria-label="Entry"
                    className="h-7 flex-1 text-xs"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    aria-label="Remove entry"
                    onClick={() => setItemRows((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/50 pt-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setIsEditing(false)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending
                ? <><Loader2 className="size-3 animate-spin" /> Saving…</>
                : <><Check className="size-3" /> Save State</>}
            </Button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-3 px-6 py-5">
      {editButton}
      {hasContent && (
        <div className="space-y-3.5 rounded-lg border border-border/50 bg-card/40 p-4 text-xs">
          {liveState && !liveState.present && (
            <div className="text-[11px] text-muted-foreground">Not in the current scene</div>
          )}

          {momentField && (
            <div className="flex items-start gap-2.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-foreground">
              <Activity className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <div>
                <span className="mr-1.5 font-medium text-amber-600 dark:text-amber-400">{momentField.field}:</span>
                <span>{momentField.value}</span>
              </div>
            </div>
          )}

          {otherFields.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {otherFields.map((field) => {
                const age = field.holds === 'lastKnown' ? describeAge(field.scenesAgo) : null
                return (
                  <Badge key={field.field} variant="secondary" className="border border-border/40 px-2 py-0.5 text-xs font-normal">
                    <span className="mr-1.5 font-medium text-muted-foreground">{field.field}:</span>
                    <span>{field.value}</span>
                    {age && <span className="ml-1.5 text-muted-foreground/70">· {age}</span>}
                  </Badge>
                )
              })}
            </div>
          )}

          {itemGroups.map(([field, items]) => {
            const style = listStyle(field)
            const Icon = style.icon
            return (
              <div key={field}>
                <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
                  <Icon className={`size-3 ${style.iconClass}`} />
                  <span className="text-[11px] font-medium uppercase tracking-wider">{field}</span>
                </div>
                <ul className="list-inside list-disc space-y-1 pl-1 text-muted-foreground">
                  {items.map((item) => (
                    <li key={item.id} className={`leading-relaxed text-foreground/90 ${style.itemClass}`}>
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}

          {ended.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
                <History className="size-3 text-muted-foreground" />
                <span className="text-[11px] font-medium uppercase tracking-wider">No longer</span>
              </div>
              <ul className="space-y-1 pl-1 text-muted-foreground">
                {ended.map((item) => (
                  <li key={`${item.id}-${item.endedAt.analysisId}`} className="leading-relaxed">
                    <span className="line-through decoration-muted-foreground/40">{item.text}</span>
                    <span> — {describeEnding(item, names)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
