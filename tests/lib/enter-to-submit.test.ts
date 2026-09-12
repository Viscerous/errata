import { describe, expect, it } from 'vitest'
import { isEnterToSubmit } from '@/lib/enter-to-submit'

const key = (overrides: Record<string, unknown> = {}) => ({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  nativeEvent: { isComposing: false },
  ...overrides,
}) as Parameters<typeof isEnterToSubmit>[0]

describe('Enter-to-submit shortcut', () => {
  it('submits plain Enter', () => {
    expect(isEnterToSubmit(key())).toBe(true)
  })

  it('leaves modified Enter and IME confirmation to the editor', () => {
    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) {
      expect(isEnterToSubmit(key({ [modifier]: true }))).toBe(false)
    }
    expect(isEnterToSubmit(key({ nativeEvent: { isComposing: true } }))).toBe(false)
    expect(isEnterToSubmit(key({ key: 'Escape' }))).toBe(false)
  })
})
