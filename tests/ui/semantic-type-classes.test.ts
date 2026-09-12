import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/utils'

describe('semantic UI type classes', () => {
  it('keeps font size alongside a text color', () => {
    expect(cn('text-ui-caption text-foreground/70')).toBe('text-ui-caption text-foreground/70')
    expect(cn('text-ui-body', true && 'text-muted-foreground')).toBe('text-ui-body text-muted-foreground')
  })

  it('still merges competing font sizes', () => {
    expect(cn('text-ui-label text-ui-caption text-foreground')).toBe('text-ui-caption text-foreground')
  })
})
