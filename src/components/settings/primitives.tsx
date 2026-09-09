import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHelp } from '@/hooks/use-help'
import { Button } from '@/components/ui/button'
import { Eyebrow, MetaLabel, Metric } from '@/components/ui/prose-text'

/**
 * SettingsSection: content-sized section wrapper for the settings layout.
 *
 * The root is a <section> that carries the caller's id plus data-toc and
 * data-toc-group attributes so the SettingsView table-of-contents scroll-spy
 * (which queries [data-toc]) can find and label it. Sections reserve a small
 * scroll margin for accurate jumps but otherwise occupy only their content.
 */
export function SettingsSection({
  id,
  label,
  group,
  children,
  className,
}: {
  id: string
  label: string
  group: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      id={id}
      data-toc={label}
      data-toc-group={group}
      className={cn('scroll-mt-6 space-y-3', className)}
    >
      {children}
    </section>
  )
}

export function SectionHeading({
  label,
  helpTopic,
  action,
  className,
}: {
  label: string
  helpTopic?: string
  action?: ReactNode
  className?: string
}) {
  const { openHelp } = useHelp()
  return (
    <div className={cn('mb-2 flex items-center justify-between gap-2', className)}>
      <div className="flex items-center gap-1.5">
        <Eyebrow>{label}</Eyebrow>
        {helpTopic && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => openHelp(helpTopic)}
            aria-label={`Learn more about ${label}`}
          >
            <CircleHelp className="size-3" />
          </Button>
        )}
      </div>
      {action}
    </div>
  )
}

export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('divide-y divide-border/20 overflow-hidden rounded-lg border border-border/40 bg-panel-muted/25', className)}>
      {children}
    </div>
  )
}

export function SettingsGroup({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <SettingsCard className={className}>
      <div className="bg-panel-muted/60 px-3 py-2">
        <Eyebrow asChild><p>{title}</p></Eyebrow>
        {description && <MetaLabel asChild><p className="mt-0.5 leading-snug">{description}</p></MetaLabel>}
      </div>
      {children}
    </SettingsCard>
  )
}

/**
 * SettingRow: a single labelled setting. Left side is the label plus optional
 * description and help icon; right side is the control passed as children. When
 * `disabled`, the whole row is greyed and pointer events are blocked so the
 * control inside cannot be reached.
 */
export function SettingRow({
  label,
  description,
  helpTopic,
  children,
  disabled,
  className,
}: {
  label: string
  description?: string
  helpTopic?: string
  children: ReactNode
  disabled?: boolean
  className?: string
}) {
  const { openHelp } = useHelp()
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-3 py-2',
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
      aria-disabled={disabled || undefined}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <p className="text-ui-body font-medium text-foreground/85">{label}</p>
          {helpTopic && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={(e) => { e.stopPropagation(); openHelp(helpTopic) }}
              aria-label={`Learn more about ${label}`}
            >
              <CircleHelp className="size-3" />
            </Button>
          )}
        </div>
        {description && <MetaLabel asChild><p className="mt-0.5 leading-snug">{description}</p></MetaLabel>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/**
 * Toggle: the pill switch. `label` is the accessible name for the control.
 * Greys and blocks interaction when `disabled`.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-label={label}
      aria-pressed={checked}
      data-cuelume-toggle=""
      className={cn(
        'relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-foreground' : 'bg-muted-foreground/20',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-background transition-[left] duration-150',
          checked ? 'left-[16px]' : 'left-[2px]',
        )}
      />
    </button>
  )
}

/**
 * SegmentedControl: a row of mutually exclusive pill-segment buttons. The active
 * segment inverts to foreground-on-background. Greys and blocks interaction when
 * `disabled`.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div
      className={cn(
        'flex h-[26px] overflow-hidden rounded-md border border-border/40',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          data-cuelume-toggle=""
          className={cn(
            'px-2.5 text-ui-caption font-medium transition-colors',
            value === opt.value
              ? 'bg-foreground text-background'
              : 'bg-transparent text-muted-foreground hover:text-foreground/70',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Slider: a labelled range input with the formatted value shown to the right of
 * the label. `format` turns the numeric value into the display string (for
 * example "1.25x" or "80%"). Greys and blocks interaction when `disabled`.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format: (v: number) => string
  disabled?: boolean
}) {
  return (
    <div className={cn('px-3 py-2.5', disabled && 'opacity-40')}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="text-ui-body font-medium text-foreground/85">{label}</p>
        <Metric>{format(value)}</Metric>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-border/60 accent-foreground disabled:cursor-not-allowed"
        aria-label={label}
      />
    </div>
  )
}

/**
 * Shared class for a compact styled <select>. Exported so panels with bespoke
 * select markup (option lists they build inline) can stay visually identical
 * without re-deriving the class string.
 */
export const selectClass =
  'h-7 rounded-md border border-border/50 bg-elevated px-2 text-ui-caption text-foreground shadow-xs outline-none transition-[color,box-shadow] focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-40'

/**
 * SettingsSelect: a styled <select> wrapper. Pass <option> elements as children.
 * Greys and disables when `disabled`. `className` is merged onto selectClass for
 * per-use width constraints such as max-w-[11rem].
 */
export function SettingsSelect({
  value,
  onChange,
  disabled,
  className,
  children,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={cn(selectClass, className)}
    >
      {children}
    </select>
  )
}

/**
 * NumberField: a compact, centered numeric input for values like Max steps or
 * Context limit. Mirrors the monospace stepper styling used today. Holds a
 * local string draft while focused so intermediate keystrokes (partial or
 * out-of-range values, an emptied field) are never snapped back mid-typing.
 * The draft is parsed, clamped to min/max, and committed on blur or Enter;
 * Escape reverts to the last committed value. When the external `value` prop
 * changes while the field is not focused, the draft resyncs to it. `step`
 * controls the spinner increment (defaults to the browser's 1). Greys and
 * disables when `disabled`.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  className,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState(String(value))
  const focusedRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value))
  }, [value])

  const commit = () => {
    const parsed = parseInt(draft, 10)
    if (Number.isNaN(parsed)) {
      setDraft(String(value))
      return
    }
    let next = parsed
    if (min !== undefined && next < min) next = min
    if (max !== undefined && next > max) next = max
    setDraft(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => {
        focusedRef.current = true
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focusedRef.current = false
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(String(value))
      }}
      disabled={disabled}
      className={cn(
        'h-7 w-14 rounded-md border border-border/50 bg-elevated px-2 text-center font-mono text-ui-caption shadow-xs outline-none transition-[color,box-shadow] focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-40',
        className,
      )}
    />
  )
}
