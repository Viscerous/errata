import { useEffect, useRef, useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Eyebrow } from '@/components/ui/prose-text'
import { WorkspaceFooter, WorkspaceRail, WorkspaceRailHeader, WorkspaceToolbar } from '@/components/ui/workspace'
import { Bookmark, ArrowUpDown, ArrowDown, GripVertical, X } from 'lucide-react'
import type { Fragment } from '@/lib/api'
import { invalidateStoryContent } from '@/lib/branch-cache'
import { PassageListItem } from '@/components/prose/PassageListItem'
import { cn } from '@/lib/utils'

interface ProseOutlinePanelProps {
  storyId: string
  fragments: Fragment[]
  activeIndex: number
  open: boolean
  onJump: (index: number) => void
  /** Mobile overlay variant: full-width, no side-rail chrome, always expanded. */
  mobile?: boolean
  /** When provided (mobile), renders a close control in the header. */
  onClose?: () => void
}

export function ProseOutlinePanel({
  storyId,
  fragments,
  activeIndex,
  open,
  onJump,
  mobile = false,
  onClose,
}: ProseOutlinePanelProps) {
  const activeRef = useRef<HTMLButtonElement>(null)
  const collapsedActiveRef = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()
  const [editMode, setEditMode] = useState(false)

  // Drag state — edits accumulate in editOrder, saved only on exit
  const dragItem = useRef<number | null>(null)
  const [editOrder, setEditOrder] = useState<Fragment[] | null>(null)
  const [dragDisplayOrder, setDragDisplayOrder] = useState<Fragment[] | null>(null)

  const reorderMutation = useMutation({
    mutationFn: (order: number[]) => api.proseChain.reorder(storyId, order),
    onSuccess: () => invalidateStoryContent(queryClient, storyId),
  })

  const fragmentsRef = useRef(fragments)
  fragmentsRef.current = fragments

  const editOrderRef = useRef(editOrder)
  editOrderRef.current = editOrder

  const toggleEditMode = useCallback(() => {
    const currentOrder = editOrderRef.current
    if (currentOrder) {
      // Exiting edit mode — save if order changed
      const original = fragmentsRef.current
      const order = currentOrder.map((f) => original.findIndex((o) => o.id === f.id))
      const changed = order.some((oldIdx, newIdx) => oldIdx !== newIdx)
      if (changed) {
        reorderMutation.mutate(order)
      }
      setEditOrder(null)
      setDragDisplayOrder(null)
      setEditMode(false)
    } else {
      // Entering edit mode — snapshot current order
      const snapshot = [...fragmentsRef.current]
      editOrderRef.current = snapshot
      setEditOrder(snapshot)
      setEditMode(true)
    }
  }, [reorderMutation])

  const handleDragStart = useCallback((index: number, e: React.DragEvent) => {
    dragItem.current = index
    setDragDisplayOrder(editOrderRef.current ? [...editOrderRef.current] : null)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragEnter = useCallback((index: number) => {
    if (dragItem.current === null || dragItem.current === index) return
    const fromIndex = dragItem.current
    dragItem.current = index
    const update = (prev: Fragment[] | null) => {
      if (!prev) return prev
      const reordered = [...prev]
      const [removed] = reordered.splice(fromIndex, 1)
      reordered.splice(index, 0, removed)
      return reordered
    }
    setDragDisplayOrder(update)
    setEditOrder(update)
    editOrderRef.current = update(editOrderRef.current)
  }, [])

  const handleDragEnd = useCallback(() => {
    dragItem.current = null
    setDragDisplayOrder(null)
  }, [])

  const addChapterMutation = useMutation({
    mutationFn: () =>
      api.chapters.create(storyId, {
        name: `Chapter`,
        position: fragments.length,
      }),
    onSuccess: () => invalidateStoryContent(queryClient, storyId),
  })

  // Scroll the active item into view when panel opens or active changes
  useEffect(() => {
    if (open && activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    if (!open && collapsedActiveRef.current) {
      collapsedActiveRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [open, activeIndex])

  // Track prose numbering (skip markers in the count)
  let proseCounter = 0

  return (
    <>
      {/* Outline panel */}
      <WorkspaceRail
        data-component-id="prose-outline-panel"
        className={cn(
          mobile
            ? 'h-full w-full overflow-hidden border-l-0 bg-panel'
            : `overflow-hidden backdrop-blur-sm transition-all duration-250 ease-out ${
                open ? 'w-56' : 'w-7'
              }`,
        )}
      >
        {(open || mobile) ? (
          /* --- Expanded view --- */
          <>
            {/* Header — on desktop top padding clears the floating toolbar;
                in the mobile overlay there is none. */}
            <WorkspaceRailHeader className={cn(
              'flex items-center justify-between border-b-0 px-4 pb-3',
              mobile ? 'pt-4' : 'pt-12',
            )}>
              <Eyebrow>Passages</Eyebrow>
              <WorkspaceToolbar>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={editMode ? 'secondary' : 'ghost'}
                      size="icon-xs"
                      onClick={toggleEditMode}
                      aria-label={editMode ? 'Exit reorder mode' : 'Reorder sections'}
                    >
                      <ArrowUpDown className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-[0.625rem]">
                    {editMode ? 'Exit reorder mode' : 'Reorder sections'}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => addChapterMutation.mutate()}
                      disabled={addChapterMutation.isPending}
                      aria-label="Add chapter"
                      className="text-amber-600/80 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400/80 dark:hover:text-amber-300"
                    >
                      <Bookmark className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-[0.625rem]">Add chapter</TooltipContent>
                </Tooltip>
                {onClose && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={onClose}
                    aria-label="Close passages"
                    data-component-id="prose-outline-close"
                    className="-mr-1.5 ml-0.5"
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </WorkspaceToolbar>
            </WorkspaceRailHeader>

            {/* First-chapter teaching hint — shown once, while no chapter markers
                exist in the story. Disappears the moment the first one is added. */}
            {!fragments.some(f => f.type === 'marker') && fragments.length > 1 && (
              <div className="shrink-0 px-4 pb-3">
                <p className="text-ui-caption font-display italic leading-relaxed text-muted-foreground">
                  No chapters yet. Add one to group your summaries and find your place.
                </p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => addChapterMutation.mutate()}
                  disabled={addChapterMutation.isPending}
                  className="mt-1 h-auto p-0 font-display text-ui-caption italic text-muted-foreground"
                >
                  <Bookmark className="size-2.5" aria-hidden />
                  <span>Add first chapter</span>
                </Button>
              </div>
            )}

            {/* Scrollable list */}
            <div className="flex-1 overflow-y-auto overscroll-contain min-h-0 px-2 pb-2">
              {(dragDisplayOrder ?? editOrder ?? fragments).map((fragment, idx) => {
                const isActive = idx === activeIndex
                const isMarker = fragment.type === 'marker'
                const isDragging = editMode && dragItem.current === idx

                if (isMarker) {
                  return (
                    <button
                      key={fragment.id}
                      ref={isActive ? activeRef : undefined}
                      data-component-id={`prose-outline-chapter-${idx}`}
                      draggable={editMode}
                      onDragStart={editMode ? (e) => handleDragStart(idx, e) : undefined}
                      onDragEnter={editMode ? () => handleDragEnter(idx) : undefined}
                      onDragEnd={editMode ? handleDragEnd : undefined}
                      onDragOver={editMode ? (e) => e.preventDefault() : undefined}
                      onClick={editMode ? undefined : () => onJump(idx)}
                      className={`w-full text-left rounded-md px-2.5 py-2 mt-2 mb-0.5 transition-colors duration-100 group/item ${
                        isActive
                          ? 'bg-amber-500/10'
                          : 'hover:bg-amber-500/5'
                      } ${isDragging ? 'opacity-40 scale-[0.97]' : ''} ${editMode ? 'cursor-grab' : ''}`}
                    >
                      <div className="flex items-center gap-1.5">
                        {editMode && (
                          <GripVertical className="size-2.5 text-muted-foreground/40 shrink-0" />
                        )}
                        <Bookmark className="size-2.5 text-amber-500/50 shrink-0" />
                        <span className={`text-[0.625rem] font-medium tracking-wide truncate ${
                          isActive ? 'text-amber-400/80' : 'text-amber-500/40 group-hover/item:text-amber-400/60'
                        }`}>
                          {fragment.name}
                        </span>
                      </div>
                    </button>
                  )
                }

                proseCounter++
                const currentProseNumber = proseCounter

                return (
                  <PassageListItem
                    key={fragment.id}
                    ref={isActive ? activeRef : undefined}
                    data-component-id={`prose-outline-item-${idx}`}
                    draggable={editMode}
                    onDragStart={editMode ? (e) => handleDragStart(idx, e) : undefined}
                    onDragEnter={editMode ? () => handleDragEnter(idx) : undefined}
                    onDragEnd={editMode ? handleDragEnd : undefined}
                    onDragOver={editMode ? (e) => e.preventDefault() : undefined}
                    onClick={editMode ? undefined : () => onJump(idx)}
                    fragment={fragment}
                    number={currentProseNumber}
                    active={isActive}
                    leading={editMode ? <GripVertical className="mt-1 size-3 shrink-0 text-muted-foreground/50" /> : undefined}
                    className={cn('mb-1', isDragging && 'scale-[0.97] opacity-40', editMode && 'cursor-grab')}
                  />
                )
              })}
            </div>

            {/* Jump-to-latest footer — hidden when the writer is already at the end */}
            {fragments.length > 1 && activeIndex < fragments.length - 1 && (
              <WorkspaceFooter className="justify-center px-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onJump(fragments.length - 1)}
                  className="h-7 w-full font-display text-ui-caption italic"
                >
                  <ArrowDown className="size-2.5" aria-hidden />
                  <span>Jump to latest passage</span>
                </Button>
              </WorkspaceFooter>
            )}

          </>
        ) : (
          /* --- Collapsed rail view --- */
          <>
            {/* Dot indicators — top padding clears the floating toolbar */}
            <div className="flex-1 overflow-y-auto overscroll-contain min-h-0 flex flex-col items-center pt-12 pb-1 scrollbar-none" style={{ scrollbarWidth: 'none' }}>
              {fragments.map((fragment, idx) => {
                const isActive = idx === activeIndex
                const isMarker = fragment.type === 'marker'

                if (isMarker) {
                  return (
                    <Tooltip key={fragment.id}>
                      <TooltipTrigger asChild>
                        <button
                          ref={isActive ? collapsedActiveRef : undefined}
                          onClick={() => onJump(idx)}
                          data-component-id={`prose-outline-dot-${idx}`}
                          className="shrink-0 flex items-center justify-center w-7 h-5 group/dot"
                        >
                          <span className={`block rounded-sm transition-all duration-150 ${
                            isActive
                              ? 'w-3.5 h-0.5 bg-amber-400/60'
                              : 'w-3 h-0.5 bg-amber-500/25 group-hover/dot:w-3.5 group-hover/dot:bg-amber-400/45'
                          }`} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="text-[0.625rem]">{fragment.name}</TooltipContent>
                    </Tooltip>
                  )
                }

                return (
                  <Tooltip key={fragment.id}>
                    <TooltipTrigger asChild>
                      <button
                        ref={isActive ? collapsedActiveRef : undefined}
                        onClick={() => onJump(idx)}
                        data-component-id={`prose-outline-dot-${idx}`}
                        className="shrink-0 flex items-center justify-center w-7 h-5 group/dot"
                      >
                        <span className={`block rounded-full transition-all duration-150 ${
                          isActive
                            ? 'w-3 h-3 bg-primary/60'
                            : 'w-2 h-2 bg-muted-foreground/15 group-hover/dot:w-3 group-hover/dot:h-3 group-hover/dot:bg-muted-foreground/35'
                        }`} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-[0.625rem]">{idx + 1}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>

            {/* Collapsed rail — jump-to-latest arrow when not already at the end */}
            {fragments.length > 1 && activeIndex < fragments.length - 1 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onJump(fragments.length - 1)}
                    className="shrink-0 flex items-center justify-center w-7 h-6 border-t border-border/30 text-muted-foreground/60 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:text-foreground"
                  >
                    <ArrowDown className="size-3" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-[0.625rem]">Jump to the latest</TooltipContent>
              </Tooltip>
            )}

          </>
        )}
      </WorkspaceRail>
    </>
  )
}
