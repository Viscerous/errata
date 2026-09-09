import type { ComponentType } from 'react'
import { FileDown, FolderPlus, ListFilter, Pin, Plus, UserPlus } from 'lucide-react'
import { componentId } from '@/lib/dom-ids'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Hint } from '@/components/ui/prose-text'

export type FragmentSortMode = 'name' | 'newest' | 'oldest' | 'order'

interface TypeOption {
  value: string
  count: number
}

interface FragmentListToolbarProps {
  baseId: string
  search: string
  sort: FragmentSortMode
  typeFilter: string
  typeOptions: TypeOption[]
  showTypeFilter: boolean
  creatingFolder: boolean
  onSearchChange: (value: string) => void
  onSortChange: (sort: FragmentSortMode) => void
  onTypeFilterChange: (type: string) => void
  onCreateFolder: () => void
  onCreate: () => void
  onImport?: () => void
  onImportCard?: () => void
}

const SORT_OPTIONS: Array<{ mode: FragmentSortMode; label: string }> = [
  { mode: 'order', label: 'Sort by manual order' },
  { mode: 'name', label: 'Sort alphabetically' },
  { mode: 'newest', label: 'Sort by newest first' },
  { mode: 'oldest', label: 'Sort by oldest first' },
]

export function FragmentListToolbar({
  baseId,
  search,
  sort,
  typeFilter,
  typeOptions,
  showTypeFilter,
  creatingFolder,
  onSearchChange,
  onSortChange,
  onTypeFilterChange,
  onCreateFolder,
  onCreate,
  onImport,
  onImportCard,
}: FragmentListToolbarProps) {
  return (
    <>
      <div className="space-y-2 border-b border-border/50 px-3 pb-2 pt-3" data-component-id={componentId(baseId, 'list-controls')}>
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search fragments…"
          className="h-7 bg-transparent text-xs"
          data-component-id={componentId(baseId, 'list-search')}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {showTypeFilter && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-6 min-w-0 max-w-[8.5rem] gap-1 px-1.5 text-ui-label text-muted-foreground hover:text-foreground" data-component-id={componentId(baseId, 'type-filter')}>
                    <ListFilter className="size-3.5 shrink-0" />
                    <span className="truncate">{typeFilter === 'all' ? 'all types' : typeFilter}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuRadioGroup value={typeFilter} onValueChange={onTypeFilterChange}>
                    <DropdownMenuRadioItem value="all" className="text-xs">
                      <span className="min-w-0 flex-1 truncate">all types</span>
                      <span className="ml-auto text-ui-label text-muted-foreground">{typeOptions.reduce((sum, option) => sum + option.count, 0)}</span>
                    </DropdownMenuRadioItem>
                    {typeOptions.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value} className="text-xs">
                        <span className="min-w-0 flex-1 truncate">{option.value}</span>
                        <span className="ml-auto text-ui-label text-muted-foreground">{option.count}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <div className="flex gap-0.5">
              {SORT_OPTIONS.map((option) => (
                <Tooltip key={option.mode}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onSortChange(option.mode)}
                      data-component-id={componentId(baseId, 'sort', option.mode)}
                      className={`rounded px-1.5 py-0.5 text-ui-label transition-colors ${sort === option.mode ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {option.mode}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{option.label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
          <div className="flex gap-0.5">
            <ToolbarAction icon={FolderPlus} label="New folder" onClick={onCreateFolder} disabled={creatingFolder} />
            {onImportCard && <ToolbarAction icon={UserPlus} label="Import character card" onClick={onImportCard} componentId={componentId(baseId, 'import-card-button')} />}
            {onImport && <ToolbarAction icon={FileDown} label="Import from clipboard or file" onClick={onImport} componentId={componentId(baseId, 'import-button')} />}
            <ToolbarAction icon={Plus} label="Create new fragment" onClick={onCreate} componentId={componentId(baseId, 'create-button')} />
          </div>
        </div>
      </div>
      <div className="border-b border-border/30 px-3 py-2.5">
        <Hint className="leading-relaxed"><Pin className="mr-0.5 inline size-2.5 -mt-0.5" />Pinned fragments are sent in full. Unpinned ones appear as catalog rows.</Hint>
      </div>
    </>
  )
}

function ToolbarAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  componentId: id,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  disabled?: boolean
  componentId?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-foreground" onClick={onClick} disabled={disabled} data-component-id={id} aria-label={label}>
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
