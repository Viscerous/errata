// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { copyText, readClipboardText } from '@/lib/clipboard'

/**
 * Remote access serves the app over plain HTTP on a LAN address, which is not a
 * secure context. `navigator.clipboard` is `[SecureContext]`, so there the
 * property is absent entirely and `navigator.clipboard.writeText(...)` throws a
 * TypeError on the click rather than returning a rejected promise — which is why
 * a `.catch()` on the call never helped. jsdom has no clipboard by default, so
 * the un-stubbed tests below are the non-secure case.
 */
describe('clipboard', () => {
  let execCommand: ReturnType<typeof vi.fn>
  /** What sat in the DOM at the moment the browser was asked to copy. */
  let staged: string | null

  beforeEach(() => {
    staged = null
    execCommand = vi.fn(() => {
      staged = document.querySelector('textarea')?.value ?? null
      return true
    })
    // jsdom does not implement execCommand; assign rather than spy.
    ;(document as unknown as { execCommand: unknown }).execCommand = execCommand
  })

  afterEach(() => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard
    delete (document as unknown as { execCommand?: unknown }).execCommand
  })

  /** A secure context: the async clipboard API is present. */
  function withClipboard(clipboard: Partial<Clipboard>) {
    Object.defineProperty(navigator, 'clipboard', {
      value: clipboard,
      configurable: true,
      writable: true,
    })
  }

  describe('copyText', () => {
    it('copies without a clipboard API instead of throwing', async () => {
      expect(navigator.clipboard).toBeUndefined()

      await expect(copyText('over the LAN')).resolves.toBe(true)

      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(staged).toBe('over the LAN')
    })

    it('reports failure rather than claiming a copy that did not happen', async () => {
      execCommand.mockReturnValue(false)
      expect(await copyText('nope')).toBe(false)
    })

    it('survives a browser that refuses execCommand outright', async () => {
      execCommand.mockImplementation(() => {
        throw new Error('unsupported')
      })
      expect(await copyText('nope')).toBe(false)
    })

    it('prefers the async API when there is one', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      withClipboard({ writeText })

      expect(await copyText('secure')).toBe(true)
      expect(writeText).toHaveBeenCalledWith('secure')
      expect(execCommand).not.toHaveBeenCalled()
    })

    it('falls back when the async API is present but refuses', async () => {
      // A denied permission or an unfocused document; the selection path often
      // still works, so a rejection must not end the attempt.
      withClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })

      expect(await copyText('still copied')).toBe(true)
      expect(staged).toBe('still copied')
    })

    it('leaves nothing behind in the document', async () => {
      await copyText('tidy')
      expect(document.querySelector('textarea')).toBeNull()
    })

    it('restores the selection the reader had', async () => {
      const paragraph = document.createElement('p')
      paragraph.textContent = 'reader had this selected'
      document.body.appendChild(paragraph)
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)

      await copyText('something else')

      expect(selection.rangeCount).toBe(1)
      expect(selection.getRangeAt(0).toString()).toBe('reader had this selected')
      paragraph.remove()
    })
  })

  describe('readClipboardText', () => {
    it('returns null without a clipboard API instead of throwing', async () => {
      await expect(readClipboardText()).resolves.toBeNull()
    })

    it('returns null when the read is refused', async () => {
      withClipboard({ readText: vi.fn().mockRejectedValue(new Error('denied')) })
      expect(await readClipboardText()).toBeNull()
    })

    it('returns the text when the read is allowed', async () => {
      withClipboard({ readText: vi.fn().mockResolvedValue('pasted') })
      expect(await readClipboardText()).toBe('pasted')
    })

    it('does not fall back to a copy for a read', async () => {
      // There is no shim for reading: every browser refuses execCommand('paste').
      await readClipboardText()
      expect(execCommand).not.toHaveBeenCalled()
    })
  })
})
