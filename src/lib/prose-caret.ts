/**
 * Map a double-click on rendered prose back to a caret offset in the raw
 * markdown source. Rendered text and source differ (markdown syntax, dialogue
 * formatting), so we anchor on the clicked word and pick the occurrence whose
 * source position best matches the click's proportional position.
 */
export interface ClickAnchor {
  /** The word under the double-click. */
  word: string
  /** Character offset of that word inside the rendered surface's text. */
  renderedOffset: number
  /** Total length of the rendered surface's text. */
  renderedLength: number
}

export function resolveCaretOffset(source: string, anchor: ClickAnchor | null | undefined): number {
  if (!anchor) return 0
  const word = anchor.word.trim()
  if (!word) return 0
  const ratio = anchor.renderedLength > 0 ? anchor.renderedOffset / anchor.renderedLength : 0
  const target = Math.round(ratio * source.length)

  let best = -1
  let bestDistance = Infinity
  let from = 0
  while (from <= source.length) {
    const idx = source.indexOf(word, from)
    if (idx === -1) break
    const distance = Math.abs(idx - target)
    if (distance < bestDistance) { best = idx; bestDistance = distance }
    from = idx + 1
  }
  if (best !== -1) return best
  return Math.max(0, Math.min(source.length, target))
}

/**
 * Build a ClickAnchor from a text node + offset inside the rendered surface:
 * the word around that offset, and where it sits in the surface's text.
 */
export function anchorFromTextPosition(surface: HTMLElement, node: Node, offset: number): ClickAnchor | null {
  if (!surface.contains(node)) return null
  const text = node.textContent ?? ''
  if (!text.trim()) return null
  const clamped = Math.max(0, Math.min(text.length, offset))
  // Expand to the word (run of non-whitespace) around the offset.
  let start = clamped
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--
  let end = clamped
  while (end < text.length && !/\s/.test(text[end]!)) end++
  const word = text.slice(start, end)
  if (!word) return null

  const before = document.createRange()
  before.selectNodeContents(surface)
  before.setEnd(node, node.nodeType === Node.TEXT_NODE ? start : Math.min(offset, node.childNodes.length))
  return {
    word,
    renderedOffset: before.toString().length,
    renderedLength: surface.textContent?.length ?? 0,
  }
}

/** Anchor on the text under a viewport point (the double-click position). */
export function anchorFromPoint(surface: HTMLElement, x: number, y: number): ClickAnchor | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    if (pos) return anchorFromTextPosition(surface, pos.offsetNode, pos.offset)
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y)
    if (range) return anchorFromTextPosition(surface, range.startContainer, range.startOffset)
  }
  // Last resort: whatever the double-click selected.
  const selection = window.getSelection()
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    return anchorFromTextPosition(surface, range.startContainer, range.startOffset)
  }
  return null
}
