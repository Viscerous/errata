import { useState, useEffect, useRef, useMemo, memo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Fragment, type ProseChainResponseEntry } from '@/lib/api'
import type { AuthorInputMode } from '@/contracts/generation'
import { copyText } from '@/lib/clipboard'
import { invalidateStoryContent } from '@/lib/branch-cache'
import { Button } from '@/components/ui/button'
import { StreamMarkdown } from '@/components/ui/stream-markdown'
import { ChevronRail } from './ChevronRail'
import { ProseImageHeader } from './ProseImageHeader'
import { resolveHeaderImage } from '@/lib/fragment-visuals'
import { GenerationThoughts } from './GenerationThoughts'
import { consumeGenerationStream, type ThoughtStep } from './generation-stream'
import { buildAnnotationHighlighter, filterMentionAnnotations, formatDialogue, composeTextTransforms, stripEmphasisInDialogue, type Annotation } from '@/lib/fragment-mentions'
import { RefreshCw, Undo2, PenLine, Bug, Trash2, GitBranch, MessageSquare, ChevronLeft, ChevronRight, Info, BookOpen, Volume2, Square, AlertTriangle } from 'lucide-react'
import { Caption } from '@/components/ui/prose-text'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useTtsSettings, useIsReadingFragment, playFragment, stopTts } from '@/lib/tts'
import { GenerationProviderSelect } from './GenerationProviderSelect'
import { isEnterToSubmit } from '@/lib/enter-to-submit'

interface ProseBlockProps {
  storyId: string
  fragment: Fragment
  displayIndex: number
  sectionIndex: number
  chainEntry: ProseChainResponseEntry | null
  isLast: boolean
  isFirst?: boolean
  onSelect: (fragment: Fragment) => void
  onDebugLog?: (logId: string) => void
  onBranchFrom?: (sectionIndex: number) => void
  onEdit?: (fragmentId: string, selectedText?: string) => void
  onAskLibrarian?: (fragmentId: string, prefill?: string) => void
  onAnalyze?: (fragmentId: string) => void
  hasAnalysis?: boolean
  analysisWarning?: string
  quickSwitch: boolean
  enabledMentionTypes?: ReadonlySet<string>
  mentionFragmentTypesById?: ReadonlyMap<string, string>
  mentionAnnotations?: Annotation[]
  mentionColors?: Map<string, string>
  onClickMention?: (fragmentId: string) => void
  mediaById?: Map<string, Fragment>
  scrollAnchorId?: string
  expandThoughtsByDefault?: boolean
}

export const ProseBlock = memo(function ProseBlock({
  storyId,
  fragment,
  displayIndex,
  sectionIndex,
  chainEntry,
  isLast,
  isFirst,
  onSelect,
  onEdit,
  onDebugLog,
  onBranchFrom,
  onAskLibrarian,
  onAnalyze,
  hasAnalysis,
  analysisWarning,
  quickSwitch,
  enabledMentionTypes,
  mentionFragmentTypesById,
  mentionAnnotations,
  mentionColors,
  onClickMention,
  mediaById,
  scrollAnchorId,
  expandThoughtsByDefault = true,
}: ProseBlockProps) {
  // isFirst/isLast are part of the interface for future use
  void isFirst
  void isLast
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [actionMode, setActionMode] = useState<'regenerate' | null>(null)
  const [showUndo, setShowUndo] = useState(false)
  const [isStreamingAction, setIsStreamingAction] = useState(false)
  const [streamedActionText, setStreamedActionText] = useState('')
  const [actionThoughtSteps, setActionThoughtSteps] = useState<ThoughtStep[]>([])
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showActions, setShowActions] = useState(false)
  const [actionInput, setActionInput] = useState('')
  const [ttsSettings] = useTtsSettings()
  const isReadingThis = useIsReadingFragment(fragment.id)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [toolbarTop, setToolbarTop] = useState(0)
  const [selectedText, setSelectedText] = useState('')
  const blockRef = useRef<HTMLDivElement>(null)
  const actionPanelRef = useRef<HTMLDivElement>(null)
  const actionInputRef = useRef<HTMLTextAreaElement>(null)
  const promptInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    }
  }, [])

  // Dismiss action panel / prompt editor on outside click
  useEffect(() => {
    if (!showActions && !actionMode && !editingPrompt) return
    const handler = (e: MouseEvent) => {
      if (blockRef.current && !blockRef.current.contains(e.target as Node)) {
        setShowActions(false)
        setActionMode(null)
        setActionInput('')
        setEditingPrompt(false)
        setSelectedText('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showActions, actionMode, editingPrompt])

  const revertMutation = useMutation({
    mutationFn: () => api.fragments.revert(storyId, fragment.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
      setShowUndo(false)
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    },
  })

  const switchMutation = useMutation({
    mutationFn: (fragmentId: string) =>
      api.proseChain.switchVariation(storyId, sectionIndex, fragmentId),
    onSuccess: () => invalidateStoryContent(queryClient, storyId),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.proseChain.removeSection(storyId, sectionIndex),
    onSuccess: () => invalidateStoryContent(queryClient, storyId),
  })

  const variationCount = chainEntry?.proseFragments.length ?? 0
  const variationIndex = chainEntry?.proseFragments.findIndex(f => f.id === chainEntry.active) ?? -1
  const hasMultiple = variationCount > 1
  const canPrev = hasMultiple && variationIndex > 0
  const canNext = hasMultiple && variationIndex < variationCount - 1
  const generatedFrom = typeof fragment.meta?.generatedFrom === 'string'
    ? fragment.meta.generatedFrom.trim()
    : ''
  const quickRegenerateInput = generatedFrom || fragment.description?.trim() || ''
  const canQuickRegenerate = !!quickRegenerateInput
  const isPlayReroll = fragment.meta?.generatedFromMode === 'play'
  const rerollPlaceholder = isPlayReroll ? 'Edit protagonist move...' : 'New direction...'

  const switchVariation = (dir: -1 | 1) => {
    if (!chainEntry) return
    const nextIdx = variationIndex + dir
    if (nextIdx < 0 || nextIdx >= variationCount) return
    switchMutation.mutate(chainEntry.proseFragments[nextIdx].id)
  }

  const handleActionComplete = () => {
    setActionMode(null)
    setEditingPrompt(false)
    setIsStreamingAction(false)
    setStreamedActionText('')
    setActionThoughtSteps([])
    setShowUndo(true)
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => setShowUndo(false), 10000)
  }

  const runRegeneration = async (instruction: string) => {
    if (!instruction.trim() || isStreamingAction) return

    setIsStreamingAction(true)
    setStreamedActionText('')
    setActionThoughtSteps([])

    try {
      const inputMode = (fragment.meta?.generatedFromMode as AuthorInputMode) || undefined
      const stream = await api.generation.regenerate(storyId, fragment.id, instruction, undefined, { inputMode })
      await consumeGenerationStream(stream, ({ text, thoughts }) => {
        setStreamedActionText(text)
        if (thoughts.length > 0) setActionThoughtSteps(thoughts)
      })
      await invalidateStoryContent(queryClient, storyId)
      handleActionComplete()
    } catch {
      setIsStreamingAction(false)
      setStreamedActionText('')
      setActionThoughtSteps([])
    }
  }

  const handleQuickRegenerate = async () => {
    if (!canQuickRegenerate || isStreamingAction) return
    setActionMode(null)
    await runRegeneration(quickRegenerateInput)
  }

  const handleActionSubmit = async () => {
    if (!actionInput.trim() || isStreamingAction) return
    setActionMode(null)
    setShowActions(false)
    await runRegeneration(actionInput)
  }

  const handlePromptSubmit = async () => {
    if (!actionInput.trim() || isStreamingAction) return
    setEditingPrompt(false)
    setShowActions(false)
    await runRegeneration(actionInput)
  }

  // Pre-strip markdown emphasis from inside dialogue so markdown parsing
  // doesn't split quoted text across element boundaries.
  const processedContent = useMemo(() => stripEmphasisInDialogue(fragment.content), [fragment.content])

  // Build text transform: dialogue italics + optional mention highlighting
  const annotations = mentionAnnotations ?? fragment.meta?.annotations as Annotation[] | undefined
  const textTransform = useMemo(() => {
    const filteredAnnotations = filterMentionAnnotations(
      annotations,
      enabledMentionTypes ?? new Set<string>(),
      mentionFragmentTypesById,
    )
    const hasAnyMentions = (enabledMentionTypes?.size ?? 0) > 0
    const mentionHighlighter = hasAnyMentions && filteredAnnotations && filteredAnnotations.length > 0 && onClickMention
      ? buildAnnotationHighlighter(filteredAnnotations, onClickMention, mentionColors, fragment.id)
      : null
    if (mentionHighlighter) return composeTextTransforms(formatDialogue, mentionHighlighter)
    return formatDialogue
  }, [enabledMentionTypes, mentionFragmentTypesById, annotations, onClickMention, mentionColors, fragment.id])

  const textTransformKey = useMemo(() => {
    const types = enabledMentionTypes ? Array.from(enabledMentionTypes).sort().join(',') : ''
    const anns = annotations ? annotations.map(a => `${a.fragmentId}:${a.type}:${a.text}`).join(',') : ''
    return `${types}::${anns}`
  }, [enabledMentionTypes, annotations])

  // Resolve a linked image for the passage header (first image visual ref).
  const headerImage = useMemo(
    () => (mediaById ? resolveHeaderImage(fragment, mediaById) : null),
    [fragment, mediaById],
  )

  return (
    <div ref={blockRef} className="group relative mb-6" data-prose-index={displayIndex} data-component-id={`prose-${fragment.id}-block`}>
      {/* Linked image — framed plate at the top of the passage */}
      {headerImage && (
        <ProseImageHeader storyId={storyId} fragment={fragment} header={headerImage} />
      )}

      {analysisWarning && onAnalyze && (
        <div className="relative z-30">
          <button
            type="button"
            className="absolute -top-1 right-0 flex size-6 items-center justify-center rounded-md border border-amber-500/20 bg-card text-amber-600 shadow-sm transition-colors hover:bg-amber-500/10 dark:text-amber-400"
            onClick={() => onAnalyze(fragment.id)}
            aria-label="Retry incomplete analysis"
            title={`Analysis incomplete: ${analysisWarning}. Click to retry.`}
            data-component-id={`prose-${fragment.id}-analysis-status`}
          >
            <AlertTriangle className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {/* User prompt header — left-aligned accent bar, display font, inline editable */}
      {fragment.description && (
        <div className={`mb-3 -mt-2 ${analysisWarning ? 'pr-7' : ''}`}>
          {editingPrompt ? (
            /* Inline editing — input replaces the header text in place */
            <div className="flex items-start gap-2.5">
              <div className="w-0.5 self-stretch rounded-full bg-primary/50 shrink-0" />
              <div className="flex-1 min-w-0">
                <input
                  ref={promptInputRef}
                  type="text"
                  value={actionInput}
                  onChange={(e) => setActionInput(e.target.value)}
                  className="w-full bg-transparent font-display italic text-sm text-foreground/80 placeholder:text-muted-foreground outline-none border-none p-0 caret-primary"
                  placeholder={rerollPlaceholder}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setEditingPrompt(false)
                      setActionInput('')
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handlePromptSubmit()
                    }
                  }}
                />
                <div className="flex items-center gap-2 mt-1.5">
                  <GenerationProviderSelect storyId={storyId} disabled={isStreamingAction} className="max-w-[140px]" />
                  <span className="text-ui-label text-muted-foreground">
                    Enter &middot; Esc
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto text-primary/70 hover:bg-primary/10 hover:text-primary"
                    disabled={!actionInput.trim()}
                    onClick={handlePromptSubmit}
                  >
                    {isPlayReroll ? 'Reroll move' : 'Regenerate'}
                  </Button>
                </div>
              </div>
            </div>
          ) : canQuickRegenerate ? (
            <button type="button"
              className="group/prompt flex min-h-6 items-start gap-2.5 w-full text-left transition-all"
              onClick={(e) => {
                e.stopPropagation()
                setActionInput(generatedFrom || fragment.description || '')
                setEditingPrompt(true)
                requestAnimationFrame(() => {
                  promptInputRef.current?.focus()
                  promptInputRef.current?.select()
                })
              }}
              title={isPlayReroll ? 'Click to edit protagonist move and regenerate' : 'Click to edit direction and regenerate'}
            >
              <div className="w-0.5 min-h-[1.25rem] rounded-full bg-primary/20 group-hover/prompt:bg-primary/45 transition-colors shrink-0 mt-0.5" />
              <Caption asChild size="sm" className="font-display italic group-hover/prompt:text-muted-foreground truncate transition-colors">
                <span>{generatedFrom || fragment.description}</span>
              </Caption>
              <RefreshCw className="size-3 shrink-0 mt-1 opacity-0 group-hover/prompt:opacity-40 transition-opacity" />
              {hasMultiple && (
                <span className="ml-auto mt-0.5 shrink-0 font-mono text-ui-label text-muted-foreground">{variationIndex + 1}/{variationCount}</span>
              )}
            </button>
          ) : (
            <div className="flex items-start gap-2.5">
              <div className="w-0.5 min-h-[1.25rem] rounded-full bg-border/30 shrink-0 mt-0.5" />
              <Caption asChild size="sm" className="font-display italic truncate"><span>{fragment.description}</span></Caption>
              {hasMultiple && (
                <span className="ml-auto mt-0.5 shrink-0 font-mono text-ui-label text-muted-foreground">{variationIndex + 1}/{variationCount}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Hover chevron rails — full-height, cursor-following */}
      {quickSwitch && (hasMultiple || canQuickRegenerate) && (
        <>
          <ChevronRail
            direction="prev"
            disabled={!canPrev || switchMutation.isPending}
            onClick={() => switchVariation(-1)}
            fragmentId={fragment.id}
          />
          <ChevronRail
            direction="next"
            disabled={!canNext && !canQuickRegenerate}
            onClick={() => {
              if (canNext) { switchVariation(1); return }
              handleQuickRegenerate()
            }}
            fragmentId={fragment.id}
          />
        </>
      )}

      <div
        role="button"
        tabIndex={0}
        onClick={(e: React.MouseEvent) => {
          if (isStreamingAction) return
          if (actionPanelRef.current?.contains(e.target as Node)) return
          if (!showActions && blockRef.current) {
            const blockRect = blockRef.current.getBoundingClientRect()
            const sel = window.getSelection()
            let targetTop = e.clientY - blockRect.top
            let targetBottom = targetTop
            let text = ''
            if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0)
              if (blockRef.current.contains(range.commonAncestorContainer)) {
                const rangeRect = range.getBoundingClientRect()
                if (rangeRect.height > 0) {
                  targetTop = rangeRect.top - blockRect.top
                  targetBottom = rangeRect.bottom - blockRect.top
                }
                text = sel.toString()
              }
            }
            setSelectedText(text)
            setToolbarTop(targetBottom + 8)
          }
          setShowActions(v => !v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setShowActions(false); return }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (!isStreamingAction) setShowActions(v => !v)
          }
        }}
        className={`text-left rounded-lg p-4 -mx-4 transition-all duration-150 cursor-default ${analysisWarning && !fragment.description ? 'pr-7' : ''} ${
          showActions ? 'bg-card/50 ring-1 ring-primary/10' : 'hover:bg-card/40'
        }`}
        data-component-id={`prose-${fragment.id}-select`}
      >
        {(isStreamingAction || streamedActionText) && actionThoughtSteps.length > 0 && (
          <GenerationThoughts
            steps={actionThoughtSteps}
            streaming={isStreamingAction}
            hasText={!!streamedActionText}
            defaultExpanded={expandThoughtsByDefault}
          />
        )}
        <StreamMarkdown
          content={(isStreamingAction || streamedActionText)
            ? streamedActionText || ''
            : processedContent
          }
          streaming={isStreamingAction}
          variant="prose"
          textTransform={textTransform}
          textTransformKey={textTransformKey}
          anchorId={scrollAnchorId}
        />

      </div>

      {/* Action toolbar — compact pill near click point */}
      {(showActions || actionMode) && !isStreamingAction && (
        <div
          ref={actionPanelRef}
          className="absolute left-0 right-0 z-10 flex justify-center animate-in fade-in zoom-in-95 duration-150"
          style={{ top: toolbarTop }}
          data-component-id="prose-block-actions"
        >
          {actionMode ? (
            /* Regenerate input — inline textarea */
            <div className="w-full max-w-md rounded-xl border border-border/40 bg-popover/95 backdrop-blur-md shadow-lg shadow-black/[0.06] overflow-hidden">
              <textarea
                ref={actionInputRef}
                value={actionInput}
                onChange={(e) => setActionInput(e.target.value)}
                placeholder={rerollPlaceholder}
                className="w-full resize-none bg-transparent px-3.5 py-2.5 text-sm placeholder:italic placeholder:text-muted-foreground/60 focus:outline-none"
                rows={2}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setActionMode(null); setActionInput('') }
                  if (isEnterToSubmit(e)) { e.preventDefault(); handleActionSubmit() }
                }}
              />
              <div className="flex items-center justify-end px-3 py-1.5 border-t border-border/20">
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    onClick={() => { setActionMode(null); setActionInput('') }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    disabled={!actionInput.trim()}
                    onClick={handleActionSubmit}
                  >
                    {isPlayReroll ? 'Reroll move' : 'Regenerate'}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            /* Two-tier action toolbar */
            <div className="flex flex-col rounded-xl border border-border/30 bg-popover/95 backdrop-blur-md shadow-lg shadow-black/[0.06] overflow-hidden min-w-0">
              {/* Top tier — ID, variation, secondary icon actions */}
              <div className="flex items-center gap-1.5 px-2.5 py-1 min-w-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 shrink-0 select-all px-1 font-mono text-ui-label text-muted-foreground/60"
                  onClick={(e) => { e.stopPropagation(); void copyText(fragment.id) }}
                  title="Copy ID"
                >
                  {fragment.id}
                </Button>
                {hasMultiple && (
                  <>
                    <div className="w-px h-3 bg-border/20" />
                    <div className="inline-flex items-center gap-0 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground/50"
                        disabled={!canPrev || switchMutation.isPending}
                        onClick={() => switchVariation(-1)}
                        title="Previous variation"
                      >
                        <ChevronLeft className="size-3" />
                      </Button>
                      <span className="min-w-[1.75rem] text-center font-mono text-ui-label tabular-nums text-muted-foreground/50">{variationIndex + 1}/{variationCount}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground/50"
                        disabled={!canNext || switchMutation.isPending}
                        onClick={() => switchVariation(1)}
                        title="Next variation"
                      >
                        <ChevronRight className="size-3" />
                      </Button>
                    </div>
                  </>
                )}
                <div className="ml-auto flex items-center gap-0.5 shrink-0">
                  {onBranchFrom && sectionIndex >= 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground/50"
                      onClick={() => { onBranchFrom(sectionIndex); setShowActions(false) }}
                      title="Split from here"
                      data-component-id={`prose-${fragment.id}-branch`}
                    >
                      <GitBranch className="size-3" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground/50"
                    onClick={() => { onSelect(fragment); setShowActions(false) }}
                    title="Details"
                  >
                    <Info className="size-3" />
                  </Button>
                  {!!fragment.meta?.generatedFrom && onDebugLog && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground/50"
                      onClick={() => { onDebugLog(fragment.id); setShowActions(false) }}
                      title="Debug log"
                    >
                      <Bug className="size-3" />
                    </Button>
                  )}
                  {sectionIndex >= 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"
                      disabled={deleteMutation.isPending}
                      onClick={async () => {
                        if (await confirm({ title: 'Remove this passage?', description: 'It will be archived.', confirmText: 'Remove', destructive: true })) {
                          deleteMutation.mutate()
                          setShowActions(false)
                        }
                      }}
                      title="Remove passage"
                      data-component-id={`prose-${fragment.id}-remove`}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </div>
              </div>
              {/* Divider */}
              <div className="h-px bg-border/15" />
              {/* Bottom tier — primary actions. Wraps so the last action
                  (Read aloud) isn't clipped on narrow / mobile widths. */}
              <div className="flex flex-wrap items-center gap-px px-1 py-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-ui-label text-muted-foreground"
                  onClick={() => { if (onEdit) { onEdit(fragment.id, selectedText || window.getSelection()?.toString() || undefined); setShowActions(false) } }}
                  disabled={!onEdit}
                  data-component-id={`prose-${fragment.id}-edit`}
                >
                  <PenLine className="size-3.5" />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-ui-label text-muted-foreground"
                  onClick={() => {
                    setShowActions(false)
                    handleQuickRegenerate()
                  }}
                  disabled={!canQuickRegenerate}
                  data-component-id={`prose-${fragment.id}-regenerate`}
                >
                  <RefreshCw className="size-3.5" />
                  Redo
                </Button>
                {onAskLibrarian && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2.5 text-ui-label text-muted-foreground"
                      onClick={() => { onAskLibrarian(fragment.id, `refine ${fragment.id}: `); setShowActions(false) }}
                      data-component-id={`prose-${fragment.id}-refine`}
                    >
                      <MessageSquare className="size-3.5" />
                      Refine
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2.5 text-ui-label text-muted-foreground"
                      onClick={() => { onAskLibrarian(fragment.id); setShowActions(false) }}
                      data-component-id={`prose-${fragment.id}-ask`}
                    >
                      <MessageSquare className="size-3.5" />
                      Ask
                    </Button>
                  </>
                )}
                {onAnalyze && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2.5 text-ui-label text-muted-foreground"
                    onClick={() => { onAnalyze(fragment.id); setShowActions(false) }}
                    data-component-id={`prose-${fragment.id}-analyze`}
                  >
                    <BookOpen className="size-3.5" />
                    {analysisWarning ? 'Retry analysis' : hasAnalysis ? 'Re-analyze' : 'Analyze'}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!ttsSettings.enabled}
                  title={ttsSettings.enabled ? undefined : 'Enable Read aloud in Settings to use this'}
                  className={isReadingThis
                    ? 'h-7 px-2.5 text-ui-label text-primary'
                    : 'h-7 px-2.5 text-ui-label text-muted-foreground'}
                  onClick={() => {
                    if (!ttsSettings.enabled) return
                    if (isReadingThis) stopTts()
                    else playFragment(fragment.id, fragment.content, fragment.name, ttsSettings)
                    setShowActions(false)
                  }}
                  data-component-id={`prose-${fragment.id}-read-aloud`}
                >
                  {isReadingThis ? <Square className="size-3.5" /> : <Volume2 className="size-3.5" />}
                  {isReadingThis ? 'Stop' : 'Read aloud'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {showUndo && (
        <div className="flex items-center gap-2 mt-1 px-4">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs gap-1"
            onClick={() => revertMutation.mutate()}
            disabled={revertMutation.isPending}
            data-component-id={`prose-${fragment.id}-undo`}
          >
            <Undo2 className="size-3" />
            {revertMutation.isPending ? 'Reverting...' : 'Undo'}
          </Button>
        </div>
      )}

      {(switchMutation.error || deleteMutation.error) && (
        <p role="alert" className="mt-2 px-4 text-ui-caption text-destructive">
          {switchMutation.error?.message ?? deleteMutation.error?.message}
        </p>
      )}

    </div>
  )
})
