import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import type { Fragment } from '@/lib/api'
import { q, useActiveBranchId } from '@/lib/query-keys'
import { describeAge, fieldOrder, groupItems, listStyle, liveStateFor } from '@/components/fragments/live-state-display'

const SHOWN_PER_LIST = 2

/**
 * Where a mentioned character or entity stood as of the passage the mention is
 * in, so reading back through the story shows what was true there rather than
 * what is true now. Mounted only while the card is open; renders nothing until
 * there is state to show.
 */
export function MentionLiveState({ storyId, passageId, fragment }: {
  storyId: string
  passageId: string
  fragment: Fragment
}) {
  const branchId = useActiveBranchId(storyId)
  const { data } = useQuery({
    ...q.librarianContinuityAt(storyId, branchId, passageId),
    retry: false,
  })
  const liveState = useMemo(
    () => liveStateFor(data?.ledger?.liveStates ?? [], fragment),
    [data, fragment],
  )
  if (!liveState) return null

  const fields = [...liveState.fields].sort((left, right) => fieldOrder(left.field, liveState.kind) - fieldOrder(right.field, liveState.kind))
  const moment = fields.find((field) => field.holds === 'moment')
  const otherFields = fields.filter((field) => field !== moment)
  const lists = groupItems(liveState.items, liveState.kind)
  if (fields.length === 0 && lists.length === 0) return null

  return (
    <div className="space-y-1.5 border-b border-border/40 pb-2.5 text-ui-label last:border-b-0 last:pb-0">
      {!liveState.present && (
        <div className="text-muted-foreground/70">Not in this scene</div>
      )}
      {moment && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-popover-foreground">
          <Activity className="mt-0.5 size-3 shrink-0 text-amber-500" />
          <span className="leading-snug">{moment.value}</span>
        </div>
      )}
      {otherFields.map((field) => {
        const age = field.holds === 'lastKnown' ? describeAge(field.scenesAgo) : null
        return (
          <div key={field.field} className="leading-snug">
            <span className="mr-1 font-medium text-muted-foreground">{field.field}:</span>
            <span className="text-popover-foreground/90">{field.value}</span>
            {age && <span className="text-muted-foreground/60"> · {age}</span>}
          </div>
        )
      })}
      {lists.map(([field, items]) => {
        const style = listStyle(field)
        const Icon = style.icon
        const hidden = items.length - SHOWN_PER_LIST
        return (
          <div key={field}>
            <div className="flex items-center gap-1 text-muted-foreground">
              <Icon className={`size-3 ${style.iconClass}`} />
              <span className="font-medium">{field}</span>
              <span className="text-muted-foreground/60">{items.length}</span>
            </div>
            <ul className="mt-0.5 space-y-0.5 pl-4">
              {items.slice(0, SHOWN_PER_LIST).map((item) => (
                <li key={item.id} className={`line-clamp-2 leading-snug text-popover-foreground/85 ${style.itemClass}`}>
                  {item.text}
                </li>
              ))}
              {hidden > 0 && <li className="text-muted-foreground/60">+{hidden} more</li>}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
