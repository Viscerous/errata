import { memo } from 'react'
import { GripVertical, Pin } from 'lucide-react'
import type { Fragment } from '@/lib/api'
import { fragmentComponentId } from '@/lib/dom-ids'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Caption } from '@/components/ui/prose-text'
import { FragmentArtwork, FragmentMetadata } from './FragmentIdentity'

interface FragmentListItemProps {
  fragment: Fragment
  index: number
  selected: boolean
  isDragging: boolean
  canDrag: boolean
  showType: boolean
  mediaById: Map<string, Fragment>
  onSelect: (fragment: Fragment) => void
  onPin: (fragment: Fragment) => void
  pinPending: boolean
  onDragStart: (index: number, event: React.DragEvent) => void
  onDragEnter: (index: number) => void
  onDragEnd: () => void
}

export const FragmentListItem = memo(function FragmentListItem({
  fragment,
  index,
  selected,
  isDragging,
  canDrag,
  showType,
  mediaById,
  onSelect,
  onPin,
  pinPending,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: FragmentListItemProps) {
  return (
    <div
      data-component-id={fragmentComponentId(fragment, 'list-item')}
      draggable={canDrag}
      onDragStart={(event) => onDragStart(index, event)}
      onDragEnter={() => onDragEnter(index)}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      className={cn(
        'group flex items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-sm transition-all duration-150 hover:bg-accent/50',
        selected && 'bg-accent',
        isDragging && 'scale-[0.97] opacity-40',
      )}
    >
      {canDrag && (
        <div
          role="presentation"
          className="shrink-0 cursor-grab pt-0.5 opacity-0 transition-opacity group-hover:opacity-50"
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical className="size-3.5 text-muted-foreground" data-component-id={fragmentComponentId(fragment, 'drag-handle')} />
        </div>
      )}

      <FragmentArtwork fragment={fragment} mediaById={mediaById} />

      <button
        type="button"
        onClick={() => onSelect(fragment)}
        className="w-0 flex-grow overflow-hidden text-left"
        data-component-id={fragmentComponentId(fragment, 'select')}
      >
        <p className="truncate text-sm font-medium leading-tight">{fragment.name}</p>
        <FragmentMetadata fragment={fragment} showType={showType} className="mt-1" />
        {fragment.description && <Caption className="mt-0.5 truncate">{fragment.description}</Caption>}
      </button>

      <Button
        size="icon"
        variant="ghost"
        data-component-id={fragmentComponentId(fragment, 'pin-toggle')}
        className={cn(
          'size-6 shrink-0 transition-opacity',
          fragment.sticky
            ? 'text-primary opacity-100'
            : 'opacity-0 group-hover:opacity-50 hover:text-foreground hover:opacity-100',
        )}
        onClick={(event) => {
          event.stopPropagation()
          onPin(fragment)
        }}
        disabled={pinPending}
        title={fragment.sticky ? 'Unpin' : 'Pin to context'}
      >
        <Pin className={cn('size-3.5', fragment.sticky && 'fill-current')} />
      </Button>
    </div>
  )
})
