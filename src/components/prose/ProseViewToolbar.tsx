import type { ReactNode } from 'react'
import { List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StoryChatSwitcher, type StoryChatView } from '@/components/shared/StoryChatSwitcher'
import { cn } from '@/lib/utils'

interface ProseViewToolbarProps {
  mobileMenuTrigger: ReactNode
  hasOutline: boolean
  outlineOpen: boolean
  onOutlineOpenChange: (open: boolean) => void
  onMobileOutlineOpen: () => void
  onMainViewChange: (view: StoryChatView) => void
}

export function ProseViewToolbar({
  mobileMenuTrigger,
  hasOutline,
  outlineOpen,
  onOutlineOpenChange,
  onMobileOutlineOpen,
  onMainViewChange,
}: ProseViewToolbarProps) {
  const expanded = hasOutline && outlineOpen

  return (
    <div className={cn(
      'absolute inset-x-3 top-3 z-20 flex items-center justify-between gap-2 md:left-auto md:right-0',
      expanded && 'md:w-56 md:px-3',
    )} data-component-id="prose-view-toolbar">
      <div className="shrink-0 md:hidden">{mobileMenuTrigger}</div>
      <div className={cn('flex items-center gap-1.5', expanded && 'md:flex-1')}>
        <div className="md:hidden">
          <StoryChatSwitcher value="prose" onChange={onMainViewChange} compact />
        </div>
        <div className={cn('hidden md:block', expanded && 'md:flex-1')}>
          <StoryChatSwitcher value="prose" onChange={onMainViewChange} compact={!expanded} fill={expanded} />
        </div>
        {hasOutline && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onMobileOutlineOpen}
              title="Passages"
              aria-label="Open passages outline"
              data-component-id="prose-mobile-toc-trigger"
              className="size-8 border border-border/50 bg-elevated/90 shadow-sm backdrop-blur-md md:hidden"
            >
              <List className="size-4" />
            </Button>
            <div className="hidden w-7 justify-center md:flex">
              <Button
                type="button"
                variant={expanded ? 'secondary' : 'ghost'}
                size="icon-xs"
                onClick={() => onOutlineOpenChange(!expanded)}
                title={expanded ? 'Collapse outline' : 'Expand outline'}
                aria-label={expanded ? 'Collapse outline' : 'Expand outline'}
                data-component-id="prose-outline-toggle"
              >
                <List className="size-3.5" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
