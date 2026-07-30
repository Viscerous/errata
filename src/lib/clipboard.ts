/**
 * Clipboard access that works outside a secure context.
 *
 * `navigator.clipboard` is `[SecureContext]`, so the property is *absent* — not
 * merely failing — over plain HTTP on a LAN address, which is how remote access
 * serves the app. An unguarded `navigator.clipboard.writeText(...)` therefore
 * throws a TypeError on the click, and an optional-chained one silently does
 * nothing while the button still flashes "copied".
 *
 * Every clipboard call goes through here; `scripts/lint-architecture.ts` keeps it
 * that way.
 */

/**
 * The pre-async-API copy path: put the text in an off-screen field, select it,
 * and let the browser copy the selection. Deprecated, and the only mechanism
 * available without a secure context. Requires a user gesture, so this must stay
 * synchronous — an `await` before it forfeits the gesture on Safari.
 */
function copyBySelection(text: string): boolean {
  const field = document.createElement('textarea')
  field.value = text
  // readOnly keeps the iOS keyboard shut; a hidden field cannot be selected, so
  // it has to be on-screen in the sense the browser cares about and merely
  // invisible to the reader.
  field.readOnly = true
  field.setAttribute('aria-hidden', 'true')
  field.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0'

  // Copying steals the selection; restore whatever the reader had highlighted.
  const selection = document.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  document.body.appendChild(field)
  try {
    field.select()
    // iOS needs the explicit range; select() alone leaves the field unselected.
    field.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    if (previous && selection) {
      selection.removeAllRanges()
      selection.addRange(previous)
    }
  }
}

/**
 * Copy `text`, resolving to whether it actually landed. Never throws, so callers
 * decide what to show — a button that reports success unconditionally is lying on
 * any device where the copy failed.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Present but refused: denied permission, or the document lost focus.
      // The selection path often still works, so fall through rather than fail.
    }
  }
  return copyBySelection(text)
}

/**
 * The clipboard's text, or `null` when it cannot be read.
 *
 * Reads have no fallback — every browser refuses `execCommand('paste')`, by
 * design, since a page that could read the clipboard unprompted would be a
 * privacy hole. `null` means "offer a manual paste", not "retry".
 */
export async function readClipboardText(): Promise<string | null> {
  if (!navigator.clipboard?.readText) return null
  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}
