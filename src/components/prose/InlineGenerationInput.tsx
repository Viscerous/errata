import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { PenLine, Loader2, Type } from 'lucide-react'
import { cn } from '@/lib/utils'
import { invalidateStoryContent } from '@/lib/branch-cache'
import { qk, useActiveBranchId } from '@/lib/query-keys'
import type { SuggestionDirection, ClarifyQuestion, Clarification, LibrarianAnalysisProgress } from '@/lib/api/types'
import { QuestionCard } from '@/components/generation/QuestionCard'
import { generateRunId } from '@/lib/client-ids'
import { mergeDirectionSuggestions } from './direction-suggestions'
import { composeGeneratedProse, type AuthorInputMode } from '@/contracts/generation'
import { ContextPreviewDialog } from '@/components/generation/ContextPreviewDialog'
import { GUIDED_CONTINUE_PROMPT, GUIDED_SCENE_SETTING_PROMPT } from '@/lib/guided-prompts'
import { GenerationProviderSelect } from './GenerationProviderSelect'
import { GuidedGenerationControls } from './GuidedGenerationControls'
import { consumeGenerationStream, type ThoughtStep } from './generation-stream'
import { ComposerFrame, ComposerTextarea, ComposerToolbar } from '@/components/chat/ComposerSurface'
import { isEnterToSubmit } from '@/lib/enter-to-submit'

// A round high enough that the server withholds the ask tool and must write —
// used by "Skip & write" to proceed without answering.
const FORCE_PROCEED_ROUND = 99

type InputMode = 'play' | 'direct' | 'guided' | 'compose'

export interface InlineGenerationHandoff {
  mode: 'generate' | 'write'
  prompt?: string
}

interface InlineGenerationInputProps {
  storyId: string
  isGenerating: boolean
  /**
   * The active head passage of the current timeline (last section's active
   * fragment). Directions are anchored to the passage they were generated
   * against and only stay relevant while that passage is still the head — once
   * the timeline advances, they're hidden.
   */
  latestFragmentId?: string
  liveAnalysisProgress?: LibrarianAnalysisProgress | null
  handoff?: InlineGenerationHandoff | null
  onConsumeHandoff?: () => void
  onGenerationStart: (prompt: string, inputMode: AuthorInputMode) => void
  onGenerationStream: (text: string) => void
  onGenerationThoughts?: (steps: ThoughtStep[]) => void
  onGenerationComplete: () => void
  onGenerationError: () => void
}

const STORAGE_KEY = 'errata:generation-mode'

export function InlineGenerationInput({
  storyId,
  isGenerating,
  latestFragmentId,
  liveAnalysisProgress,
  handoff,
  onConsumeHandoff,
  onGenerationStart,
  onGenerationStream,
  onGenerationThoughts,
  onGenerationComplete,
  onGenerationError,
}: InlineGenerationInputProps) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const [input, setInput] = useState('')
  const [composeInput, setComposeInput] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingQuestions, setPendingQuestions] = useState<ClarifyQuestion[] | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composeTextareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef<string | null>(null)
  // In-flight generation context, preserved across the clarify round trip.
  const genCtxRef = useRef<{ input: string; inputMode: AuthorInputMode; clarifications: Clarification[]; round: number }>({ input: '', inputMode: 'direct', clarifications: [], round: 0 })

  useEffect(() => () => {
    const controller = abortRef.current
    const runId = runIdRef.current
    if (!controller) return
    if (runId) void api.agents.cancel(storyId, runId).catch(() => controller.abort())
    else controller.abort()
  }, [storyId])

  // Mode state with localStorage persistence
  const [mode, setMode] = useState<InputMode>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'play' || stored === 'direct' || stored === 'guided' || stored === 'compose') {
        return stored
      }
      return 'direct'
    } catch {
      return 'direct'
    }
  })

  // Suggestion state
  const [suggestions, setSuggestions] = useState<SuggestionDirection[]>([])
  const [manualSuggestions, setManualSuggestions] = useState<SuggestionDirection[] | null>(null)
  const [invalidatedAnalysisId, setInvalidatedAnalysisId] = useState<string | null>(null)
  // The head passage the manual/prewriter directions were produced for. They
  // stay live only while that passage is still the head (same rule as analysis
  // directions), so advancing the timeline retires them too.
  const [manualAnchor, setManualAnchor] = useState<string | undefined>(undefined)
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)

  // Query latest analysis for auto-populated directions
  const { data: analysesList } = useQuery({
    queryKey: qk.librarianAnalyses(storyId, branchId),
    queryFn: () => api.librarian.listAnalyses(storyId),
  })

  // Only surface the newest analysis's directions while the passage it was
  // generated against is still the timeline's head. Once a new passage is
  // written (or the tail is deleted / a variation switched), the analysis no
  // longer describes "what comes next" and its directions drop out — until the
  // librarian re-analyses the new head.
  const latestSummary = analysesList?.[0]
  const latestAnalysisId =
    latestSummary?.directionsCount && latestSummary.fragmentId === latestFragmentId
      ? latestSummary.id
      : null

  const { data: latestAnalysis } = useQuery({
    queryKey: ['librarian-analysis', storyId, latestAnalysisId],
    queryFn: () => api.librarian.getAnalysis(storyId, latestAnalysisId!),
    enabled: !!latestAnalysisId,
    staleTime: 60_000,
  })

  const liveDirectionsAreCurrent = !!liveAnalysisProgress
    && liveAnalysisProgress.fragmentId === latestFragmentId
  const analysisDirections = useMemo(() => {
    if (liveAnalysisProgress && liveAnalysisProgress.fragmentId === latestFragmentId) {
      return liveAnalysisProgress.directions
    }
    return latestAnalysis?.directions ?? []
  }, [latestAnalysis?.directions, latestFragmentId, liveAnalysisProgress])

  // Merge: prewriter/manual directions first, then append analysis directions
  // unless the user explicitly refreshed directions for this analysis. Manual
  // directions only count while their anchor is still the head; analysisDirections
  // is already head-gated via latestAnalysisId. Always replace (never just append)
  // so directions clear once the head moves on.
  useEffect(() => {
    setSuggestions(mergeDirectionSuggestions({
      manualSuggestions,
      manualAnchor,
      latestFragmentId,
      analysisDirections,
      latestAnalysisId: liveDirectionsAreCurrent ? null : latestAnalysisId,
      invalidatedAnalysisId,
    }))
  }, [manualSuggestions, manualAnchor, analysisDirections, latestFragmentId, liveDirectionsAreCurrent, latestAnalysisId, invalidatedAnalysisId])

  // Provider quick-switch queries
  const { data: story } = useQuery({
    queryKey: ['story', storyId],
    queryFn: () => api.stories.get(storyId),
  })

  const handleModeChange = (newMode: InputMode) => {
    setMode(newMode)
    try { localStorage.setItem(STORAGE_KEY, newMode) } catch {}
  }

  const effectiveInputMode: AuthorInputMode = mode === 'play' ? 'play' : 'direct'

  // Auto-resize textareas
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [input])

  useEffect(() => {
    const el = composeTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 400) + 'px'
  }, [composeInput])

  const handleGenerateWithInput = useCallback(async (generationInput: string, inputMode: AuthorInputMode = 'direct', clarifications: Clarification[] = [], round = 0) => {
    if (!generationInput.trim() || isGenerating) return

    onGenerationStart(generationInput, inputMode)
    setError(null)
    setPendingQuestions(null)
    genCtxRef.current = { input: generationInput, inputMode, clarifications, round }

    const ac = new AbortController()
    abortRef.current = ac
    const runId = generateRunId()
    runIdRef.current = runId
    /**
     * A run torn down on request. Refresh — a stop can land after tool writes —
     * but leave the prompt in the composer, since no passage was committed.
     * Reached two ways: the server says so on a cleanly closed stream, or the
     * client's own abort throws first. Same outcome either way.
     */
    const finishStopped = async () => {
      await invalidateStoryContent(queryClient, storyId)
      onGenerationComplete()
    }

    try {
      const opts = {
        ...(clarifications.length || round > 0 ? { clarifications, clarifyRound: round } : {}),
        runId,
        branchId,
        inputMode,
      }
      const stream = await api.generation.generateAndSave(storyId, generationInput, ac.signal, opts)

      const result = await consumeGenerationStream(stream, ({ text, thoughts }) => {
        onGenerationStream(text ? composeGeneratedProse(generationInput, text, inputMode) : '')
        if (thoughts.length > 0) onGenerationThoughts?.(thoughts)
      })

      // The prewriter asked clarifying questions instead of writing — surface
      // them and wait for answers (no prose was produced this round).
      if (result.questions) {
        setPendingQuestions(result.questions)
        onGenerationComplete()
        return
      }

      if (result.rejectionReason) {
        setError(result.rejectionReason)
        onGenerationError()
        return
      }

      // A stopped run closes its stream as cleanly as a finished one, so the
      // flag — not the end of the stream — is what says a run produced prose.
      if (result.stopped) {
        await finishStopped()
        return
      }

      await invalidateStoryContent(queryClient, storyId)

      if (result.directions?.length) {
        // Anchor to the passage that was just written (now the head) — read it
        // from the chain refreshed by invalidateStoryContent above, since the
        // latestFragmentId prop may not have propagated yet in this callback.
        const chain = queryClient.getQueryData<{ entries: Array<{ active: string }> }>(
          qk.proseChain(storyId, branchId),
        )
        setManualAnchor(chain?.entries.at(-1)?.active ?? latestFragmentId)
        setManualSuggestions(result.directions)
      }

      setInput('')
      onGenerationComplete()
    } catch (err) {
      // User-initiated abort — not an error
      if (ac.signal.aborted) {
        await finishStopped()
      } else {
        setError(err instanceof Error ? err.message : 'Generation failed')
        onGenerationError()
      }
    } finally {
      abortRef.current = null
      if (runIdRef.current === runId) runIdRef.current = null
    }
  }, [storyId, branchId, latestFragmentId, isGenerating, onGenerationStart, onGenerationStream, onGenerationThoughts, onGenerationComplete, onGenerationError, queryClient])

  const consumedHandoffRef = useRef<InlineGenerationHandoff | null>(null)
  useEffect(() => {
    if (!handoff || isGenerating || consumedHandoffRef.current === handoff) return
    consumedHandoffRef.current = handoff
    const prompt = handoff.prompt?.trim()
    if (!prompt) return
    onConsumeHandoff?.()
    if (handoff.mode === 'generate') {
      void handleGenerateWithInput(prompt, effectiveInputMode)
    } else {
      if (mode === 'guided') {
        handleModeChange('direct')
        setInput(prompt)
      } else if (mode === 'compose') {
        setComposeInput(prompt)
        composeTextareaRef.current?.focus()
      } else {
        setInput(prompt)
        textareaRef.current?.focus()
      }
    }
  }, [handoff, isGenerating, effectiveInputMode, mode, handleGenerateWithInput, handleModeChange, onConsumeHandoff])

  const handleGenerate = () => {
    handleGenerateWithInput(input, effectiveInputMode)
  }

  const handleAnswers = useCallback((answers: Clarification[]) => {
    const { input: gi, inputMode, clarifications, round } = genCtxRef.current
    setPendingQuestions(null)
    handleGenerateWithInput(gi, inputMode, [...clarifications, ...answers], round + 1)
  }, [handleGenerateWithInput])

  const handleSkipQuestions = useCallback(() => {
    const { input: gi, inputMode, clarifications } = genCtxRef.current
    setPendingQuestions(null)
    handleGenerateWithInput(gi, inputMode, clarifications, FORCE_PROCEED_ROUND)
  }, [handleGenerateWithInput])

  const handleStop = () => {
    const controller = abortRef.current
    const runId = runIdRef.current
    if (!controller) return
    if (!runId) {
      controller.abort()
      return
    }
    // The stream remains attached for the server's final `stopped` event.
    // Transport abort is only the fallback when the cancel request fails.
    void api.agents.cancel(storyId, runId).catch(() => controller.abort())
  }

  const handleCompose = async () => {
    const content = composeInput.trim()
    if (!content || isComposing) return
    setIsComposing(true)
    setError(null)
    try {
      const fragment = await api.fragments.create(storyId, {
        type: 'prose',
        name: '',
        description: '',
        content,
        meta: { generationMode: 'manual' },
      })
      await api.proseChain.addSection(storyId, fragment.id)
      await invalidateStoryContent(queryClient, storyId)
      setComposeInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add section')
    } finally {
      setIsComposing(false)
    }
  }

  const handleFetchSuggestions = async () => {
    setIsFetchingSuggestions(true)
    setSuggestionError(null)
    setInvalidatedAnalysisId(latestAnalysisId)
    setManualAnchor(undefined)
    setManualSuggestions(null)
    setSuggestions([])
    try {
      const result = await api.generation.proposeDirections(storyId)
      // proposeDirections is computed from the current story state, i.e. the
      // current head — anchor to it so these retire when the timeline advances.
      setManualAnchor(latestFragmentId)
      setManualSuggestions(result.suggestions)
    } catch (err) {
      setSuggestionError(err instanceof Error ? err.message : 'Failed to load suggestions')
    } finally {
      setIsFetchingSuggestions(false)
    }
  }

  const handleChooseSuggestion = (suggestion: SuggestionDirection) => {
    setManualSuggestions(null)
    setSuggestions([])
    void handleGenerateWithInput(suggestion.instruction, 'direct')
  }

  const handleEditSuggestion = (suggestion: SuggestionDirection) => {
    // iOS opens the keyboard only when focus remains in the click task, so mount
    // the textarea synchronously before focusing it.
    flushSync(() => {
      setInput(suggestion.instruction)
      setMode('direct')
      try { localStorage.setItem(STORAGE_KEY, 'direct') } catch {}
    })
    const textarea = textareaRef.current
    textarea?.focus()
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length)
  }

  return (
    <div className="relative" data-component-id="inline-generation-root">
      {/* Error */}
      {(error || suggestionError) && (
        <div className="text-sm text-destructive mb-3 font-sans">
          {error || suggestionError}
        </div>
      )}

      {/* Clarifying questions from the prewriter */}
      {pendingQuestions && (
        <div className="mb-3 overflow-hidden rounded-xl border border-border/40 bg-card shadow-md">
          <QuestionCard
            questions={pendingQuestions}
            onSubmit={handleAnswers}
            onCancel={handleSkipQuestions}
            disabled={isGenerating}
          />
        </div>
      )}

      {/* Unified input container */}
      <ComposerFrame>
        {/* Mode toggle */}
        <div className="flex items-center gap-0.5 px-3 pb-1 pt-2.5" role="tablist" aria-label="Writing mode">
          <button
            type="button"
            onClick={() => handleModeChange('direct')}
            role="tab"
            aria-selected={mode === 'direct'}
            aria-label="Direct the writing assistant"
            title="Direct mode: your input is an authorial scene brief that guides the whole passage and stays out of the manuscript"
            className={cn(
              'rounded-md px-2.5 py-1 text-ui-caption transition-colors duration-200',
              mode === 'direct'
                ? 'text-foreground/80 bg-muted/60 font-medium'
                : 'text-muted-foreground hover:text-foreground/60 hover:bg-muted/30',
            )}
          >
            Direct
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('play')}
            role="tab"
            aria-selected={mode === 'play'}
            aria-label="Play the protagonist"
            title="Play mode: your input is the protagonist's intended move, staged near the opening of the passage before the world answers"
            className={cn(
              'rounded-md px-2.5 py-1 text-ui-caption transition-colors duration-200',
              mode === 'play'
                ? 'text-foreground/80 bg-muted/60 font-medium'
                : 'text-muted-foreground hover:text-foreground/60 hover:bg-muted/30',
            )}
          >
            Play
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('guided')}
            role="tab"
            aria-selected={mode === 'guided'}
            className={cn(
              'rounded-md px-2.5 py-1 text-ui-caption transition-colors duration-200',
              mode === 'guided'
                ? 'text-foreground/80 bg-muted/60 font-medium'
                : 'text-muted-foreground hover:text-foreground/60 hover:bg-muted/30',
            )}
          >
            Guided
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('compose')}
            role="tab"
            aria-selected={mode === 'compose'}
            aria-label="Write prose directly"
            title="Add your prose to the story without generation"
            className={cn(
              'rounded-md px-2.5 py-1 text-ui-caption transition-colors duration-200',
              mode === 'compose'
                ? 'text-foreground/80 bg-muted/60 font-medium'
                : 'text-muted-foreground hover:text-foreground/60 hover:bg-muted/30',
            )}
          >
            Write
          </button>
        </div>

        {/* Play or Direct composer */}
        {(mode === 'play' || mode === 'direct') && (
          <ComposerTextarea
            ref={textareaRef}
            data-component-id="inline-generation-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'play' ? 'What do you do or say next?' : 'What should happen next?'}
            rows={1}
            style={{ minHeight: '44px', maxHeight: '200px', overflowY: 'auto', scrollbarWidth: 'none' }}
            disabled={isGenerating}
            onKeyDown={(e) => {
              if (isEnterToSubmit(e)) {
                e.preventDefault()
                handleGenerate()
              }
            }}
          />
        )}

        {/* Guided mode */}
        {mode === 'guided' && (
          <GuidedGenerationControls
            suggestions={suggestions}
            isGenerating={isGenerating}
            isFetchingSuggestions={isFetchingSuggestions}
            onContinue={() => void handleGenerateWithInput(story?.settings.guidedContinuePrompt || GUIDED_CONTINUE_PROMPT)}
            onSceneSetting={() => void handleGenerateWithInput(story?.settings.guidedSceneSettingPrompt || GUIDED_SCENE_SETTING_PROMPT)}
            onRefresh={() => void handleFetchSuggestions()}
            onChoose={handleChooseSuggestion}
            onEdit={handleEditSuggestion}
          />
        )}

        {/* Compose mode */}
        {mode === 'compose' && (
          <ComposerTextarea
            ref={composeTextareaRef}
            value={composeInput}
            onChange={(e) => setComposeInput(e.target.value)}
            placeholder="Write your prose directly..."
            rows={3}
            style={{ minHeight: '100px', maxHeight: '400px', overflowY: 'auto', scrollbarWidth: 'none' }}
            disabled={isComposing}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                handleCompose()
              }
            }}
          />
        )}

        {/* Bottom toolbar */}
        <ComposerToolbar>
          {/* Left: Model selector + Follow toggle (hidden in compose mode) */}
          <div className="flex items-center gap-2">
            {(mode === 'play' || mode === 'direct' || mode === 'guided') && (
              <ContextPreviewDialog
                storyId={storyId}
                input={mode === 'guided' ? (story?.settings.guidedContinuePrompt || GUIDED_CONTINUE_PROMPT) : input}
                inputMode={effectiveInputMode}
                disabled={isGenerating}
              />
            )}
            {mode !== 'compose' && (
              <GenerationProviderSelect
                storyId={storyId}
                disabled={isGenerating}
                componentId="inline-generation-provider-select"
              />
            )}
          </div>

          {/* Right: Write/Stop/Add button */}
          <div className="flex items-center gap-2.5">
            {mode === 'compose' && !isComposing && (
              <span className="text-ui-label text-muted-foreground font-sans select-none hidden sm:inline">
                Ctrl+Enter
              </span>
            )}
            {isGenerating ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5 rounded-lg border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={handleStop}
                data-component-id="inline-generation-stop"
              >
                <span className="size-1.5 bg-destructive rounded-[2px]" />
                Stop
              </Button>
            ) : (mode === 'play' || mode === 'direct') ? (
              <Button
                size="sm"
                className="h-7 text-xs gap-1.5 rounded-lg font-medium"
                onClick={handleGenerate}
                disabled={!input.trim()}
                data-component-id="inline-generation-submit"
              >
                <PenLine className="size-3" />
                Write
              </Button>
            ) : mode === 'compose' ? (
              <Button
                size="sm"
                className="h-7 text-xs gap-1.5 rounded-lg font-medium"
                onClick={handleCompose}
                disabled={!composeInput.trim() || isComposing}
                data-component-id="inline-generation-compose-submit"
              >
                {isComposing ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Type className="size-3" />
                )}
                Add Section
              </Button>
            ) : null}
          </div>
        </ComposerToolbar>
      </ComposerFrame>
    </div>
  )
}
