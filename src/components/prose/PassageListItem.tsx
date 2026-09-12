import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { Fragment } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Metric } from '@/components/ui/prose-text'

function passagePreview(content: string): string {
  const line = content.replace(/\n+/g, ' ').trim()
  return line.length > 72 ? `${line.slice(0, 72)}\u2026` : line
}

interface PassageListItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  fragment: Fragment
  number: number
  active: boolean
  meta?: ReactNode
  leading?: ReactNode
}

/** One passage row shared by every workspace navigator. */
export const PassageListItem = forwardRef<HTMLButtonElement, PassageListItemProps>(
  function PassageListItem({ fragment, number, active, meta, leading, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-current={active ? 'location' : undefined}
        className={cn(
          'group/passage relative w-full rounded-md px-3 py-2.5 text-left outline-none transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-1 focus-visible:ring-offset-panel-muted',
          active
            ? 'bg-elevated text-foreground shadow-xs before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary/70'
            : 'text-muted-foreground hover:bg-elevated/70 hover:text-foreground',
          className,
        )}
        {...props}
      >
        <div className="flex min-w-0 items-start gap-2">
          {leading}
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-between gap-2">
              <Metric className={active ? 'text-primary/80' : undefined}>{number}</Metric>
              {meta && <Metric className="text-muted-foreground/70">{meta}</Metric>}
            </div>
            {fragment.description && (
              <span className="mb-1 block truncate text-ui-caption italic text-muted-foreground">
                {fragment.description}
              </span>
            )}
            <span className={cn(
              'block font-prose text-ui-body leading-snug',
              active ? 'text-foreground/85' : 'text-muted-foreground group-hover/passage:text-foreground/80',
            )}>
              {passagePreview(fragment.content)}
            </span>
          </div>
        </div>
      </button>
    )
  },
)
