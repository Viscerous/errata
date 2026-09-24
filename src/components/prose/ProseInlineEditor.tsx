import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface ProseInlineEditorProps {
  content: string
  /** Caret position to open at (source offset). Defaults to the start. */
  initialCaret?: number
  saving?: boolean
  onSave: (content: string) => void
  onCancel: () => void
}

/**
 * In-place editor for a passage. Replaces the rendered markdown with a
 * textarea styled like the reading surface, so editing feels like writing on
 * the same page rather than opening a form.
 *
 * Ctrl/Cmd+Enter saves, Esc cancels. Saving with unchanged text just closes.
 */
export function ProseInlineEditor({ content, initialCaret, saving, onSave, onCancel }: ProseInlineEditorProps) {
  const [draft, setDraft] = useState(content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dirty = draft !== content

  // Grow with the text so the passage keeps its footprint on the page.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  // Focus without moving the page: the reader double-clicked a word and
  // expects the passage to stay put, with the caret landing on that word.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const scroller = findScrollParent(el)
    const scrollTop = scroller ? scroller.scrollTop : window.scrollY
    el.focus({ preventScroll: true })
    const caret = Math.max(0, Math.min(el.value.length, initialCaret ?? 0))
    el.setSelectionRange(caret, caret)
    if (scroller) scroller.scrollTop = scrollTop
    else window.scrollTo({ top: scrollTop })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = () => {
    if (saving) return
    if (!dirty) { onCancel(); return }
    onSave(draft)
  }

  // Clicking anywhere outside the passage commits the edit: the reader is
  // done with it, and losing the draft would be the surprising outcome.
  const rootRef = useRef<HTMLDivElement>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const root = rootRef.current
      if (root && !root.contains(e.target as Node)) commitRef.current()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div
      ref={rootRef}
      className="rounded-lg p-4 -mx-4 bg-card/50 ring-1 ring-primary/15"
      data-component-id="prose-inline-editor"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={saving}
        spellCheck
        aria-label="Edit passage"
        className="prose-content w-full resize-none overflow-hidden bg-transparent p-0 text-foreground outline-none border-none caret-primary disabled:opacity-60"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); return }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit() }
        }}
      />
      <div className="mt-3 flex items-center gap-2 border-t border-border/20 pt-2">
        <span className="text-[0.6rem] font-mono tracking-wide text-muted-foreground/50">
          {saving ? 'SAVING' : 'CTRL+ENTER · CLICK AWAY TO SAVE · ESC'}
        </span>
        <button
          type="button"
          className="ml-auto rounded px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-30"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium text-primary/70 transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-30"
          onClick={commit}
          disabled={saving || !dirty}
        >
          Save
        </button>
      </div>
    </div>
  )
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}
