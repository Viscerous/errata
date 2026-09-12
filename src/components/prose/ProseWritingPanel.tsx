import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { api, type Fragment } from '@/lib/api'
import { q, useActiveBranchId } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { FloatingElement } from '@/components/tiptap/FloatingElement'
import {
  Loader2,
  Sparkles,
  Wand2,
  Minimize2,
  X,
  Bookmark,
  Search,
  PanelRightClose,
  PanelRightOpen,
  ChevronUp,
  ChevronDown,
  Undo2,
  Check,
  Circle,
} from 'lucide-react'
import { useWritingTransforms, useTransformContext, TRANSFORM_CONTEXT_CHARS } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { Caption, Eyebrow, Metric } from '@/components/ui/prose-text'
import {
  WorkspaceDivider,
  WorkspaceFooter,
  WorkspaceHeader,
  WorkspaceRail,
  WorkspaceRailHeader,
  WorkspaceToolbar,
} from '@/components/ui/workspace'
import { PassageListItem } from '@/components/prose/PassageListItem'

type SelectionTransformMode = 'rewrite' | 'expand' | 'compress' | 'custom'

interface ProseWritingPanelProps {
  storyId: string
  fragmentId: string
  initialSelection?: string | null
  onClose: () => void
  onFragmentChange: (id: string) => void
}

/** Build ProseMirror JSON directly — avoids DOM parsing overhead of HTML path */
function plainTextToDoc(content: string): Record<string, unknown> {
  if (!content.trim()) return { type: 'doc', content: [{ type: 'paragraph' }] }
  return {
    type: 'doc',
    content: content.split('\n\n').map((para) => {
      if (!para) return { type: 'paragraph' }
      const lines = para.split('\n')
      if (lines.length === 1) {
        return { type: 'paragraph', content: [{ type: 'text', text: lines[0] }] }
      }
      const inline: Record<string, unknown>[] = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) inline.push({ type: 'text', text: lines[i] })
        if (i < lines.length - 1) inline.push({ type: 'hardBreak' })
      }
      return { type: 'paragraph', content: inline.length > 0 ? inline : [] }
    }),
  }
}

function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

function readingTime(words: number): string {
  const minutes = Math.ceil(words / 238)
  if (minutes < 1) return '<1m'
  return `${minutes}m`
}

const PassageItem = memo(function PassageItem({
  fragment,
  isActive,
  proseNumber,
  onSwitch,
}: {
  fragment: Fragment
  isActive: boolean
  proseNumber: number
  onSwitch: (id: string) => void
}) {
  const wc = wordCount(fragment.content)
  return (
    <PassageListItem
      data-passage-id={fragment.id}
      onClick={() => onSwitch(fragment.id)}
      className="mb-1"
      fragment={fragment}
      number={proseNumber}
      active={isActive}
      meta={`${wc}w`}
    />
  )
})

function SaveIndicator({ saveState, isDirty }: { saveState: 'idle' | 'saving' | 'saved'; isDirty: boolean }) {
  if (saveState === 'saving') {
    return (
      <Metric className="flex items-center gap-1.5 animate-in fade-in duration-150">
        <Loader2 className="size-2.5 animate-spin" />
        <span className="hidden sm:inline">Saving</span>
      </Metric>
    )
  }
  if (saveState === 'saved') {
    return (
      <Metric className="flex items-center gap-1.5 text-emerald-600/80 animate-in fade-in duration-150 dark:text-emerald-400/80">
        <Check className="size-2.5" />
        <span className="hidden sm:inline">Saved</span>
      </Metric>
    )
  }
  if (isDirty) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Metric className="flex items-center gap-1.5 text-amber-600/80 dark:text-amber-400/80">
            <Circle className="size-1.5 fill-current" />
            <span className="hidden sm:inline">Unsaved</span>
          </Metric>
        </TooltipTrigger>
        <TooltipContent side="bottom">Ctrl+S to save</TooltipContent>
      </Tooltip>
    )
  }
  return null
}

export function ProseWritingPanel({
  storyId,
  fragmentId,
  initialSelection,
  onClose,
  onFragmentChange,
}: ProseWritingPanelProps) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const [isTransformingSelection, setIsTransformingSelection] = useState(false)
  const [selectionTransformMode, setSelectionTransformMode] = useState<SelectionTransformMode | null>(null)
  const [selectionTransformReasoning, setSelectionTransformReasoning] = useState('')
  const [customTransformLabel, setCustomTransformLabel] = useState<string | null>(null)
  const [showTransformUndo, setShowTransformUndo] = useState(false)
  const [writingTransforms] = useWritingTransforms()
  const [transformContext] = useTransformContext()
  const enabledTransforms = writingTransforms.filter(t => t.enabled)
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
  const dirtyRef = useRef(false)
  const savingFragmentRef = useRef<string | null>(null)
  const [sidebarSearch, setSidebarSearch] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const transformUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Queries
  const { data: proseChain } = useQuery(q.proseChain(storyId, branchId))

  const { data: proseFragments = [] } = useQuery(q.fragments(storyId, branchId, 'prose'))

  const { data: markerFragments = [] } = useQuery(q.fragments(storyId, branchId, 'marker'))

  // Build combined fragment map
  const allFragmentsMap = useMemo(() => {
    const map = new Map<string, Fragment>()
    for (const f of proseFragments) map.set(f.id, f)
    for (const f of markerFragments) map.set(f.id, f)
    return map
  }, [proseFragments, markerFragments])

  // Build ordered items from chain
  const orderedItems = useMemo(() => {
    if (!proseChain?.entries.length) {
      return [...proseFragments].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    }
    const items: Fragment[] = []
    for (const entry of proseChain.entries) {
      const fragment = allFragmentsMap.get(entry.active)
      if (fragment) items.push(fragment)
    }
    return items
  }, [proseChain, allFragmentsMap, proseFragments])

  // Prose-only items (for navigation)
  const proseItems = useMemo(() => orderedItems.filter(f => f.type !== 'marker'), [orderedItems])

  // Current fragment + neighbors
  const currentFragment = allFragmentsMap.get(fragmentId)
  const currentProseIndex = proseItems.findIndex(f => f.id === fragmentId)
  const prevFragment = currentProseIndex > 0 ? proseItems[currentProseIndex - 1] : null
  const nextFragment = currentProseIndex < proseItems.length - 1 ? proseItems[currentProseIndex + 1] : null

  // Sidebar search filtering
  const filteredItems = useMemo(() => {
    if (!sidebarSearch.trim()) return orderedItems
    const q = sidebarSearch.toLowerCase()
    return orderedItems.filter(f => {
      if (f.type === 'marker') return f.name.toLowerCase().includes(q)
      return (
        f.content.toLowerCase().includes(q) ||
        (f.description ?? '').toLowerCase().includes(q)
      )
    })
  }, [orderedItems, sidebarSearch])

  // Save mutation
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateMutation = useMutation({
    mutationFn: async ({ fId, content }: { fId: string; content: string }) => {
      setSaveState('saving')
      const frag = allFragmentsMap.get(fId)
      const [result] = await Promise.all([
        api.fragments.update(storyId, fId, {
          name: frag?.name ?? '',
          description: frag?.description ?? '',
          content,
        }),
        new Promise(r => setTimeout(r, 125)),
      ])
      return result
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
      dirtyRef.current = false
      savingFragmentRef.current = null
      setSaveState('saved')
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaveState('idle'), 2000)
    },
    onError: () => {
      savingFragmentRef.current = null
      setSaveState('idle')
    },
  })

  // Tiptap editor
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
      }),
    ],
    content: plainTextToDoc(currentFragment?.content ?? ''),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'prose-content font-prose max-w-none min-h-[60vh] px-6 sm:px-10 md:px-16 py-6 sm:py-8 focus:outline-none',
      },
    },
    onUpdate: () => {
      dirtyRef.current = true
      setSaveState('idle')
    },
  })

  // Sync editor content when the active fragment changes
  useEffect(() => {
    if (!editor || !currentFragment) return
    if (savingFragmentRef.current === fragmentId) return
    editor.commands.setContent(plainTextToDoc(currentFragment.content), { emitUpdate: false })
    dirtyRef.current = false
    setSaveState('idle')
    setSelectionTransformReasoning('')
    setSelectionTransformMode(null)
    setIsTransformingSelection(false)
    setShowTransformUndo(false)
  }, [editor, fragmentId, currentFragment?.content])

  // Apply initial text selection from prose view
  const initialSelectionApplied = useRef(false)
  useEffect(() => {
    if (!editor || !initialSelection || initialSelectionApplied.current) return
    initialSelectionApplied.current = true

    // Search for the selected text in the ProseMirror document
    const doc = editor.state.doc
    const docText = doc.textBetween(0, doc.content.size, '\n\n')
    const idx = docText.indexOf(initialSelection)
    if (idx === -1) return

    // Map plain-text offset to ProseMirror position by walking the doc
    const endIdx = idx + initialSelection.length
    let charsSeen = 0
    let from = -1
    let to = -1
    doc.descendants((node, pos) => {
      if (to !== -1) return false
      if (node.isText) {
        const start = charsSeen
        const end = charsSeen + node.text!.length
        if (from === -1 && idx >= start && idx < end) {
          from = pos + (idx - start)
        }
        if (from !== -1 && endIdx >= start && endIdx <= end) {
          to = pos + (endIdx - start)
          return false
        }
        charsSeen = end
      } else if (node.isBlock && charsSeen > 0) {
        // Account for paragraph separators (\n\n) in textBetween output
        charsSeen += 2
      }
      return true
    })

    if (from !== -1 && to !== -1) {
      editor.commands.setTextSelection({ from, to })
      editor.commands.focus()
      // Scroll the selection into view
      requestAnimationFrame(() => {
        editor.commands.scrollIntoView()
      })
    }
  }, [editor, initialSelection])

  // Track selection reactively
  const [hasSelection, setHasSelection] = useState(false)
  useEffect(() => {
    if (!editor) return
    const update = () => setHasSelection(!editor.state.selection.empty)
    update()
    editor.on('selectionUpdate', update)
    editor.on('transaction', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('transaction', update)
    }
  }, [editor])

  // Get plain text from editor
  const getEditorText = useCallback(() => {
    if (!editor) return ''
    return editor.getText({ blockSeparator: '\n\n' })
  }, [editor])

  // Save current content
  const handleSave = useCallback(() => {
    if (!editor || isTransformingSelection || saveState === 'saving') return
    const content = getEditorText()
    if (!currentFragment || content === currentFragment.content) {
      dirtyRef.current = false
      return
    }
    savingFragmentRef.current = fragmentId
    updateMutation.mutate({ fId: fragmentId, content })
  }, [editor, isTransformingSelection, saveState, updateMutation, getEditorText, currentFragment, fragmentId])

  // Auto-save if dirty, then switch to a different passage
  const handlePassageSwitch = useCallback((targetId: string) => {
    if (targetId === fragmentId) return
    if (dirtyRef.current && editor && currentFragment) {
      const content = getEditorText()
      if (content !== currentFragment.content) {
        savingFragmentRef.current = fragmentId
        updateMutation.mutate({ fId: fragmentId, content })
      }
    }
    dirtyRef.current = false
    onFragmentChange(targetId)
  }, [fragmentId, editor, currentFragment, getEditorText, updateMutation, onFragmentChange])

  // Stable ref so memoized sidebar items don't re-render when the callback identity changes
  const passageSwitchRef = useRef(handlePassageSwitch)
  passageSwitchRef.current = handlePassageSwitch
  const stablePassageSwitch = useCallback((id: string) => passageSwitchRef.current(id), [])

  // Navigate to prev/next passage
  const navigatePrev = useCallback(() => {
    if (prevFragment) handlePassageSwitch(prevFragment.id)
  }, [prevFragment, handlePassageSwitch])

  const navigateNext = useCallback(() => {
    if (nextFragment) handlePassageSwitch(nextFragment.id)
  }, [nextFragment, handlePassageSwitch])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
      if (e.key === 'Escape' && !isTransformingSelection) {
        e.preventDefault()
        if (dirtyRef.current && editor && currentFragment) {
          const content = getEditorText()
          if (content !== currentFragment.content) {
            savingFragmentRef.current = fragmentId
            updateMutation.mutate({ fId: fragmentId, content })
          }
        }
        onClose()
      }
      // Alt+Up/Down for passage navigation
      if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault()
        navigatePrev()
      }
      if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault()
        navigateNext()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave, isTransformingSelection, onClose, editor, currentFragment, fragmentId, getEditorText, updateMutation, navigatePrev, navigateNext])

  // Scroll active sidebar item into view
  useEffect(() => {
    const el = sidebarScrollRef.current?.querySelector(`[data-passage-id="${fragmentId}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [fragmentId])

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      if (transformUndoTimerRef.current) clearTimeout(transformUndoTimerRef.current)
    }
  }, [])

  // Selection transform
  const applySelectionTransform = async (mode: SelectionTransformMode, instruction?: string, label?: string) => {
    if (!editor || isTransformingSelection) return
    const { from, to, empty } = editor.state.selection
    if (empty || to <= from) return

    const selectedText = editor.state.doc.textBetween(from, to, '\n')
    if (!selectedText.trim()) return

    setIsTransformingSelection(true)
    setSelectionTransformMode(mode)
    setSelectionTransformReasoning('')
    setCustomTransformLabel(label ?? null)
    setShowTransformUndo(false)

    try {
      const radius = TRANSFORM_CONTEXT_CHARS[transformContext]
      const contextBefore = editor.state.doc.textBetween(Math.max(0, from - radius), from, '\n')
      const contextAfter = editor.state.doc.textBetween(to, Math.min(editor.state.doc.content.size, to + radius), '\n')

      const stream = await api.librarian.transformProseSelection(
        storyId,
        fragmentId,
        mode,
        selectedText,
        {
          sourceContent: editor.getText({ blockSeparator: '\n\n' }),
          contextBefore,
          contextAfter,
          instruction,
        },
      )

      const reader = stream.getReader()
      let transformed = ''
      let reasoning = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === 'text') transformed += value.text
        if (value.type === 'reasoning') {
          reasoning += value.text
          setSelectionTransformReasoning(reasoning)
        }
      }

      const compact = transformed.trim()
      if (!compact) return

      const leadingWhitespace = selectedText.match(/^\s*/)?.[0] ?? ''
      const trailingWhitespace = selectedText.match(/\s*$/)?.[0] ?? ''
      const replacement = `${leadingWhitespace}${compact}${trailingWhitespace}`

      editor.chain().focus().insertContentAt({ from, to }, replacement).setTextSelection({ from, to: from + replacement.length }).run()
      dirtyRef.current = true
      setSaveState('idle')

      // Show undo hint after transform
      setShowTransformUndo(true)
      if (transformUndoTimerRef.current) clearTimeout(transformUndoTimerRef.current)
      transformUndoTimerRef.current = setTimeout(() => setShowTransformUndo(false), 6000)
    } finally {
      setIsTransformingSelection(false)
      setSelectionTransformMode(null)
      setCustomTransformLabel(null)
    }
  }

  // Editor stats
  const [editorStats, setEditorStats] = useState({ words: 0, tokens: 0 })
  useEffect(() => {
    if (!editor) return
    const update = () => {
      const text = editor.getText({ blockSeparator: '\n\n' })
      const chars = text.length
      const words = text.trim() ? text.trim().split(/\s+/).length : 0
      const tokens = Math.ceil(chars / 4)
      setEditorStats({ words, tokens })
    }
    update()
    editor.on('update', update)
    return () => { editor.off('update', update) }
  }, [editor, fragmentId])

  // Context strip helper — truncate to last ~120 chars of content
  const contextTail = (content: string) => {
    const clean = content.replace(/\n+/g, ' ').trim()
    if (clean.length <= 150) return clean
    return '\u2026' + clean.slice(-140)
  }
  const contextHead = (content: string) => {
    const clean = content.replace(/\n+/g, ' ').trim()
    if (clean.length <= 150) return clean
    return clean.slice(0, 140) + '\u2026'
  }

  // Pre-compute prose numbers so sidebar items can be memoized
  const proseNumberMap = useMemo(() => {
    const map = new Map<string, number>()
    let counter = 0
    for (const f of orderedItems) {
      if (f.type !== 'marker') {
        counter++
        map.set(f.id, counter)
      }
    }
    return map
  }, [orderedItems])

  const isDirty = dirtyRef.current

  return (
    <div className="flex h-full bg-workspace" data-component-id="prose-writing-panel">
      {/* Editor area */}
      <div className="flex min-w-0 flex-1 flex-col bg-panel">
        {/* Header */}
        <WorkspaceHeader>
          <div className="flex items-center gap-3 min-w-0">
            <Wand2 className="size-4 text-primary/60 shrink-0" />
            {currentFragment?.description ? (
              <Caption asChild size="sm" className="font-display italic truncate max-w-[40ch]">
                <span>{currentFragment.description}</span>
              </Caption>
            ) : (
              <span className="font-display text-sm text-muted-foreground">
                Writing Panel
              </span>
            )}
            <SaveIndicator saveState={saveState} isDirty={isDirty} />
          </div>
          <WorkspaceToolbar>
            {/* Passage navigation */}
            <div className="hidden sm:flex items-center gap-0.5 mr-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={navigatePrev}
                    disabled={!prevFragment}
                    aria-label={prevFragment ? 'Previous passage' : 'First passage'}
                  >
                    <ChevronUp className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {prevFragment ? 'Previous passage (Alt+\u2191)' : 'First passage'}
                </TooltipContent>
              </Tooltip>
              <Metric className="min-w-[2.5ch] text-center">
                {currentProseIndex + 1}
              </Metric>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={navigateNext}
                    disabled={!nextFragment}
                    aria-label={nextFragment ? 'Next passage' : 'Last passage'}
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {nextFragment ? 'Next passage (Alt+\u2193)' : 'Last passage'}
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Sidebar toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="hidden sm:flex"
                  onClick={() => setSidebarCollapsed(v => !v)}
                  aria-label={sidebarCollapsed ? 'Show passages' : 'Hide passages'}
                >
                  {sidebarCollapsed ? <PanelRightOpen className="size-3.5" /> : <PanelRightClose className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {sidebarCollapsed ? 'Show passages' : 'Hide passages'}
              </TooltipContent>
            </Tooltip>

            <WorkspaceDivider />

            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={handleSave}
              disabled={saveState === 'saving' || isTransformingSelection || !editor}
            >
              Ctrl+S
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close writing panel"
              onClick={() => {
                if (dirtyRef.current && editor && currentFragment) {
                  const content = getEditorText()
                  if (content !== currentFragment.content) {
                    savingFragmentRef.current = fragmentId
                    updateMutation.mutate({ fId: fragmentId, content })
                  }
                }
                onClose()
              }}
              disabled={isTransformingSelection}
            >
              <X className="size-4" />
            </Button>
          </WorkspaceToolbar>
        </WorkspaceHeader>

        {/* Editor with context strips */}
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          {/* Floating selection toolbar */}
          <FloatingElement
            editor={editor}
            shouldShow={hasSelection || isTransformingSelection}
            placement="bottom"
            offsetValue={8}
          >
            <div className="w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border/60 bg-elevated/95 shadow-xl backdrop-blur-md">
              {/* Primary transforms */}
              <div className="flex items-center gap-0.5 p-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 text-xs gap-1.5"
                  onClick={() => applySelectionTransform('rewrite')}
                  disabled={isTransformingSelection || !hasSelection}
                >
                  {isTransformingSelection && selectionTransformMode === 'rewrite' ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                  Rewrite
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 text-xs gap-1.5"
                  onClick={() => applySelectionTransform('expand')}
                  disabled={isTransformingSelection || !hasSelection}
                >
                  {isTransformingSelection && selectionTransformMode === 'expand' ? <Loader2 className="size-3 animate-spin" /> : <Wand2 className="size-3" />}
                  Expand
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 text-xs gap-1.5"
                  onClick={() => applySelectionTransform('compress')}
                  disabled={isTransformingSelection || !hasSelection}
                >
                  {isTransformingSelection && selectionTransformMode === 'compress' ? <Loader2 className="size-3 animate-spin" /> : <Minimize2 className="size-3" />}
                  Compress
                </Button>
                {showTransformUndo && !isTransformingSelection && (
                  <div className="flex items-center ml-auto pl-1 border-l border-border/30">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-ui-label gap-1 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        editor?.commands.undo()
                        setShowTransformUndo(false)
                      }}
                    >
                      <Undo2 className="size-2.5" />
                      Undo
                    </Button>
                  </div>
                )}
              </div>
              {/* Custom transforms */}
              {enabledTransforms.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5 border-t border-border/30 pt-1.5">
                  {enabledTransforms.map(t => (
                    <Button
                      key={t.id}
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-ui-label text-muted-foreground hover:text-foreground/80"
                      onClick={() => applySelectionTransform('custom', t.instruction, t.label)}
                      disabled={isTransformingSelection || !hasSelection}
                    >
                      {isTransformingSelection && selectionTransformMode === 'custom' && customTransformLabel === t.label
                        ? <Loader2 className="size-2.5 animate-spin mr-1" />
                        : null}
                      {t.label}
                    </Button>
                  ))}
                </div>
              )}
              {/* Reasoning stream */}
              {(isTransformingSelection || selectionTransformReasoning.trim()) && (
                <div className="border-t border-border/50 px-2.5 py-2">
                  <Eyebrow asChild><p className="mb-1">Reasoning</p></Eyebrow>
                  <div className="max-h-36 overflow-y-auto overscroll-contain pr-1">
                    <p className="text-ui-caption leading-relaxed text-muted-foreground whitespace-pre-wrap">
                      {selectionTransformReasoning.trim() || 'Thinking\u2026'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </FloatingElement>

          {/* Previous passage context strip */}
          {prevFragment && (
            <button type="button"
              className="group/ctx w-full text-left px-6 sm:px-10 md:px-16 pt-4 pb-2"
              onClick={navigatePrev}
            >
              <div className="flex items-center gap-2 mb-1">
                <ChevronUp className="size-3 text-muted-foreground group-hover/ctx:text-muted-foreground transition-colors" />
                <span className="text-ui-label text-muted-foreground group-hover/ctx:text-muted-foreground transition-colors">
                  Previous passage
                </span>
              </div>
              <p className="font-prose text-sm leading-relaxed text-muted-foreground group-hover/ctx:text-muted-foreground transition-colors line-clamp-2">
                {contextTail(prevFragment.content)}
              </p>
              <div className="mt-2 h-px bg-gradient-to-r from-transparent via-border/30 to-transparent" />
            </button>
          )}

          {/* Tiptap editor */}
          <EditorContent editor={editor} className="min-h-[60vh]" />

          {/* Next passage context strip */}
          {nextFragment && (
            <button type="button"
              className="group/ctx w-full text-left px-6 sm:px-10 md:px-16 pt-2 pb-4"
              onClick={navigateNext}
            >
              <div className="mb-1 h-px bg-gradient-to-r from-transparent via-border/30 to-transparent" />
              <p className="mt-2 font-prose text-sm leading-relaxed text-muted-foreground group-hover/ctx:text-muted-foreground transition-colors line-clamp-2">
                {contextHead(nextFragment.content)}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <ChevronDown className="size-3 text-muted-foreground group-hover/ctx:text-muted-foreground transition-colors" />
                <span className="text-ui-label text-muted-foreground group-hover/ctx:text-muted-foreground transition-colors">
                  Next passage
                </span>
              </div>
            </button>
          )}
        </div>

        {/* Footer */}
        <WorkspaceFooter>
          <Metric className="hidden sm:inline">
            Ctrl+S save &middot; Esc close &middot; Alt+&uarr;&darr; passages
          </Metric>
          <Metric className="sm:hidden">
            Ctrl+S &middot; Esc
          </Metric>
          <Metric className="ml-auto whitespace-nowrap">
            {editorStats.words.toLocaleString()} words
            &middot; ~{editorStats.tokens.toLocaleString()} tokens
            &middot; {readingTime(editorStats.words)} read
          </Metric>
        </WorkspaceFooter>
      </div>

      {/* Passage sidebar — right side */}
      <WorkspaceRail
        className={cn(
          'hidden overflow-hidden transition-[width] duration-200 ease-out sm:flex',
          sidebarCollapsed ? 'w-0 border-l-0' : 'w-60',
        )}
      >
        {/* Sidebar header with search */}
        <WorkspaceRailHeader>
          <div className="mb-2.5 flex items-center justify-between">
            <Eyebrow>Passages</Eyebrow>
            <Metric>
              {proseItems.length}
            </Metric>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              placeholder="Filter"
              className="h-8 bg-elevated/70 pl-7 pr-7 text-ui-caption shadow-none"
            />
            {sidebarSearch && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute right-1 top-1/2 size-6 -translate-y-1/2"
                onClick={() => setSidebarSearch('')}
                aria-label="Clear passage filter"
              >
                <X className="size-2.5" />
              </Button>
            )}
          </div>
        </WorkspaceRailHeader>

        <ScrollArea ref={sidebarScrollRef} className="flex-1 min-h-0">
          <div className="px-1.5 pb-2">
            {filteredItems.map((fragment) => {
              if (fragment.type === 'marker') {
                return (
                  <div
                    key={fragment.id}
                    className="w-full text-left px-2 py-1.5 mt-3 mb-0.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <div className="h-px flex-1 bg-amber-500/10" />
                      <Bookmark className="size-2.5 text-amber-500/40 shrink-0" />
                      <span className="text-ui-label font-medium tracking-wide text-amber-500/40 shrink-0">
                        {fragment.name}
                      </span>
                      <div className="h-px flex-1 bg-amber-500/10" />
                    </div>
                  </div>
                )
              }

              return (
                <PassageItem
                  key={fragment.id}
                  fragment={fragment}
                  isActive={fragment.id === fragmentId}
                  proseNumber={proseNumberMap.get(fragment.id) ?? 0}
                  onSwitch={stablePassageSwitch}
                />
              )
            })}

            {sidebarSearch && filteredItems.length === 0 && (
              <p className="py-6 text-center text-ui-caption italic text-muted-foreground">
                No matches
              </p>
            )}
          </div>
        </ScrollArea>
      </WorkspaceRail>
    </div>
  )
}
