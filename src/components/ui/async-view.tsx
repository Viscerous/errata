import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ErrataMark } from '@/components/ErrataLogo'

/**
 * Async-state primitives: a thin rotating Spinner and a bookish EmptyState.
 * Motion respects `prefers-reduced-motion` — see `.animate-spinner-rotate`
 * in styles.css.
 */

interface SpinnerProps {
  size?: 'sm' | 'md'
  className?: string
  label?: string
}

/**
 * A single thin rotating arc. With reduced motion, degrades to a static
 * errata mark at low opacity.
 */
export function Spinner({ size = 'md', className, label = 'Loading' }: SpinnerProps) {
  const px = size === 'sm' ? 14 : 20
  const stroke = size === 'sm' ? 1.25 : 1.5
  const r = (px - stroke) / 2
  const c = px / 2

  return (
    <span
      role="status"
      aria-label={label}
      className={cn('inline-flex items-center justify-center text-muted-foreground/60', className)}
      style={{ width: px, height: px }}
    >
      {/* Reduced-motion fallback: a still errata mark (not a frozen wheel) */}
      <ErrataMark
        size={px}
        className="motion-reduce:block hidden opacity-40"
      />
      <svg
        className="motion-reduce:hidden animate-spinner-rotate"
        width={px}
        height={px}
        viewBox={`0 0 ${px} ${px}`}
        fill="none"
        aria-hidden="true"
      >
        <circle cx={c} cy={c} r={r} stroke="currentColor" strokeOpacity="0.15" strokeWidth={stroke} />
        <path
          d={`M ${c} ${stroke / 2} A ${r} ${r} 0 0 1 ${c + r} ${c}`}
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

interface EmptyStateProps {
  title: string
  hint?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  className?: string
  hintClassName?: string
  /** "margin" = the default library-margin feel. "panel" = vertically centered inside a panel. */
  variant?: 'margin' | 'panel'
}

/**
 * A quiet, bookish empty state. Reads like an annotation in the margin of
 * an old book — never like a dashboard blank card. Title is a small serif
 * italic line; optional hint teaches what the space is for.
 */
export function EmptyState({
  title,
  hint,
  icon,
  action,
  className,
  hintClassName,
  variant = 'margin',
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center gap-2',
        variant === 'panel' ? 'justify-center py-16' : 'py-10',
        className,
      )}
      data-component-id="empty-state"
    >
      {icon
        ? <span className="text-muted-foreground/40 mb-1">{icon}</span>
        : <ErrataMark size={14} className="text-muted-foreground/30 mb-1" />
      }
      <p className="font-display italic text-ui-body text-muted-foreground leading-snug">
        {title}
      </p>
      {hint && (
        <p className={cn('text-ui-label text-muted-foreground/70 leading-relaxed max-w-[220px]', hintClassName)}>
          {hint}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

