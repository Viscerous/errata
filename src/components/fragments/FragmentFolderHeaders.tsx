import { memo, useEffect, useRef } from 'react'
import { ChevronRight, FolderOpen, GripVertical, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { Folder } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface DropTargetProps {
  isDropTarget: boolean
  onDragOver: (event: React.DragEvent) => void
  onDragEnter: (event: React.DragEvent) => void
  onDragLeave: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
}

interface FragmentFolderHeaderProps extends DropTargetProps {
  folder: Folder
  count: number
  collapsed: boolean
  isDraggingFolder: boolean
  isFolderDragOver: boolean
  renamingId: string | null
  renameValue: string
  onToggle: () => void
  onRename: (folderId: string) => void
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onDelete: (folderId: string) => void
  onFolderDragStart: (folderId: string, event: React.DragEvent) => void
  onFolderDragEnter: (folderId: string) => void
  onFolderDragEnd: () => void
}

function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className="rounded p-0.5 transition-colors hover:bg-accent/50" aria-label={collapsed ? 'Expand group' : 'Collapse group'}>
      <ChevronRight className={cn('size-3 text-muted-foreground transition-transform duration-150', !collapsed && 'rotate-90')} />
    </button>
  )
}

export const FragmentFolderHeader = memo(function FragmentFolderHeader({
  folder,
  count,
  collapsed,
  isDropTarget,
  isDraggingFolder,
  isFolderDragOver,
  renamingId,
  renameValue,
  onToggle,
  onRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onFolderDragStart,
  onFolderDragEnter,
  onFolderDragEnd,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
}: FragmentFolderHeaderProps) {
  const isRenaming = renamingId === folder.id
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isRenaming) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [isRenaming])

  return (
    <div
      draggable={!isRenaming}
      onDragStart={(event) => onFolderDragStart(folder.id, event)}
      onDragEnd={onFolderDragEnd}
      onDragOver={(event) => {
        onDragOver(event)
        event.preventDefault()
      }}
      onDragEnter={(event) => {
        onDragEnter(event)
        onFolderDragEnter(folder.id)
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'group/folder flex select-none items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
        isDropTarget && 'bg-primary/15 ring-1 ring-primary/30',
        !isDropTarget && isFolderDragOver && 'bg-accent/40 ring-1 ring-accent/50',
        !isDropTarget && !isFolderDragOver && 'hover:bg-accent/30',
        isDraggingFolder && 'scale-[0.97] opacity-40',
      )}
    >
      <div className="flex shrink-0 items-center">
        <GripVertical className="-mr-0.5 size-2.5 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover/folder:opacity-40" />
        <CollapseButton collapsed={collapsed} onToggle={onToggle} />
      </div>
      <FolderOpen className="size-3.5 shrink-0" style={folder.color ? { color: folder.color } : undefined} />

      {isRenaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(event) => onRenameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onRenameCommit()
            if (event.key === 'Escape') onRenameCancel()
          }}
          onBlur={onRenameCommit}
          className="min-w-0 flex-1 border-b border-primary/40 bg-transparent px-0.5 py-0 text-xs font-medium outline-none"
          maxLength={50}
        />
      ) : (
        <button
          type="button"
          onClick={onToggle}
          onDoubleClick={(event) => {
            event.stopPropagation()
            onRename(folder.id)
          }}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-xs font-medium">{folder.name}</span>
        </button>
      )}

      <span className="shrink-0 text-ui-label tabular-nums text-muted-foreground">{count}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover/folder:opacity-60 hover:!opacity-100" aria-label={`Actions for ${folder.name}`}>
            <MoreHorizontal className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[120px]">
          <DropdownMenuItem onClick={() => onRename(folder.id)}>
            <Pencil className="mr-2 size-3" />Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onDelete(folder.id)} className="text-destructive focus:text-destructive">
            <Trash2 className="mr-2 size-3" />Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

interface UncategorizedHeaderProps extends DropTargetProps {
  count: number
  collapsed: boolean
  onToggle: () => void
}

export function UncategorizedFragmentHeader({
  count,
  collapsed,
  isDropTarget,
  onToggle,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
}: UncategorizedHeaderProps) {
  return (
    <div
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex select-none items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
        isDropTarget ? 'bg-primary/15 ring-1 ring-primary/30' : 'hover:bg-accent/30',
      )}
    >
      <CollapseButton collapsed={collapsed} onToggle={onToggle} />
      <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-xs italic text-muted-foreground">Uncategorized</span>
      </button>
      <span className="shrink-0 text-ui-label tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}
