import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'

interface SamplingNumberInputProps {
  value?: number | null
  onCommit: (value: number | null) => void
  min: number
  max: number
  step: number
  integer?: boolean
  disabled?: boolean
  placeholder?: string
  title: string
  className?: string
}

function formatValue(value: number | null | undefined): string {
  return value == null ? '' : String(value)
}

export function SamplingNumberInput({
  value,
  onCommit,
  min,
  max,
  step,
  integer = false,
  disabled,
  placeholder,
  title,
  className,
}: SamplingNumberInputProps) {
  const [draft, setDraft] = useState(() => formatValue(value))
  const [invalid, setInvalid] = useState(false)
  const editingRef = useRef(false)
  const skipBlurCommitRef = useRef(false)

  useEffect(() => {
    if (editingRef.current) return
    setDraft(formatValue(value))
    setInvalid(false)
  }, [value])

  const commit = () => {
    const trimmed = draft.trim()
    const nextValue = trimmed === '' ? null : Number(trimmed)
    const isValid = nextValue === null || (
      Number.isFinite(nextValue)
      && nextValue >= min
      && nextValue <= max
      && (!integer || Number.isInteger(nextValue))
    )

    if (!isValid) {
      setInvalid(true)
      return
    }

    setInvalid(false)
    const currentValue = value == null ? null : value
    if (nextValue !== currentValue) onCommit(nextValue)
  }

  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => {
        editingRef.current = true
      }}
      onChange={(event) => {
        setDraft(event.target.value)
        setInvalid(false)
      }}
      onBlur={() => {
        editingRef.current = false
        if (skipBlurCommitRef.current) {
          skipBlurCommitRef.current = false
          return
        }
        commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          skipBlurCommitRef.current = true
          setDraft(formatValue(value))
          setInvalid(false)
          event.currentTarget.blur()
        }
      }}
      disabled={disabled}
      placeholder={placeholder}
      title={invalid ? `Enter a value from ${min} to ${max}${integer ? ' using a whole number' : ''}.` : title}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-7 bg-elevated px-1.5 text-center font-mono text-ui-caption placeholder:text-muted-foreground/50 md:text-ui-caption',
        invalid && 'border-destructive/70 focus:border-destructive/70',
        className,
      )}
    />
  )
}
