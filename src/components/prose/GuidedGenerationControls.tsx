import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Compass, Loader2, Pause, PenSquare, RefreshCw } from 'lucide-react'
import type { SuggestionDirection } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface GuidedGenerationControlsProps {
  suggestions: SuggestionDirection[]
  isGenerating: boolean
  isFetchingSuggestions: boolean
  onContinue: () => void
  onSceneSetting: () => void
  onRefresh: () => void
  onChoose: (suggestion: SuggestionDirection) => void
  onEdit: (suggestion: SuggestionDirection) => void
}

export function GuidedGenerationControls({
  suggestions,
  isGenerating,
  isFetchingSuggestions,
  onContinue,
  onSceneSetting,
  onRefresh,
  onChoose,
  onEdit,
}: GuidedGenerationControlsProps) {
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<number | null>(null)
  const pressStartedExpandedRef = useRef<boolean | null>(null)

  useEffect(() => {
    if (activeSuggestionIndex !== null && activeSuggestionIndex >= suggestions.length) {
      setActiveSuggestionIndex(null)
    }
  }, [activeSuggestionIndex, suggestions.length])

  return (
    <div className="px-2.5 pb-1.5 pt-1">
      <div className="mb-1.5 flex gap-1.5">
        <GuidedAction
          icon={ArrowRight}
          label="Continue"
          description="Advance plot"
          disabled={isGenerating}
          onClick={onContinue}
        />
        <GuidedAction
          icon={Pause}
          label="Scene-setting"
          description="Atmosphere"
          disabled={isGenerating}
          onClick={onSceneSetting}
        />
      </div>

      {suggestions.length === 0 && !isFetchingSuggestions && (
        <button
          type="button"
          disabled={isGenerating}
          onClick={onRefresh}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border/40 py-1.5 text-ui-label text-muted-foreground transition-[color,background-color,border-color]',
            'hover:border-primary/25 hover:bg-primary/[0.02] hover:text-foreground/70 disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          <Compass className="size-3.5" />
          Suggest directions
        </button>
      )}

      {isFetchingSuggestions && (
        <div className="flex items-center justify-center gap-2 py-4" role="status">
          <Loader2 className="size-4 animate-spin text-primary/50" />
          <span className="text-ui-label italic text-muted-foreground">Imagining possibilities...</span>
        </div>
      )}

      {suggestions.length > 0 && !isFetchingSuggestions && (
        <div className="relative">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-ui-label uppercase tracking-wider text-muted-foreground">Directions</span>
            <button
              type="button"
              disabled={isGenerating}
              onClick={onRefresh}
              aria-label="Refresh directions"
              className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
            >
              <RefreshCw className="size-3" />
            </button>
          </div>
          <div
            className="flex flex-col gap-1"
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') setActiveSuggestionIndex(null)
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setActiveSuggestionIndex(null)
              }
            }}
          >
            {suggestions.map((suggestion, index) => {
              const isExpanded = activeSuggestionIndex === index
              const activateSuggestion = () => {
                const wasExpanded = pressStartedExpandedRef.current ?? isExpanded
                pressStartedExpandedRef.current = null
                if (wasExpanded) onChoose(suggestion)
                else setActiveSuggestionIndex(index)
              }
              const recordPressStart = () => {
                pressStartedExpandedRef.current = isExpanded
              }

              return (
                <div
                  key={`${suggestion.title}:${suggestion.instruction}`}
                  onPointerEnter={(event) => {
                    if (event.pointerType === 'mouse') setActiveSuggestionIndex(index)
                  }}
                  onFocus={() => setActiveSuggestionIndex(index)}
                  className={cn(
                    'group/card w-full overflow-hidden rounded-md border bg-card/90',
                    'border-border/25 transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/25 hover:bg-card hover:shadow-md',
                    'focus-within:border-primary/25 focus-within:bg-card focus-within:shadow-md',
                    isExpanded && 'border-primary/25 bg-card shadow-md',
                    isGenerating && 'opacity-40',
                  )}
                >
                  <div className="flex min-h-8 w-full items-stretch pointer-coarse:min-h-11">
                    <button
                      type="button"
                      disabled={isGenerating}
                      onPointerDown={recordPressStart}
                      onClick={activateSuggestion}
                      aria-expanded={isExpanded}
                      className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
                    >
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 text-ui-label font-medium leading-tight text-foreground/80 transition-colors group-hover/card:text-foreground/90">
                          {suggestion.title}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 truncate text-ui-caption leading-tight text-muted-foreground transition-[opacity,max-width] duration-300 ease-in-out',
                            isExpanded ? 'pointer-events-none max-w-0 opacity-0' : 'max-w-full opacity-100',
                          )}
                        >
                          {suggestion.description}
                        </span>
                      </div>
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          disabled={isGenerating}
                          onClick={() => onEdit(suggestion)}
                          aria-label={`Edit ${suggestion.title} before sending`}
                          className="flex w-8 shrink-0 items-center justify-center rounded-r-md border-l border-border/20 text-muted-foreground/40 transition-colors hover:bg-muted/30 hover:text-foreground/60 pointer-coarse:w-11"
                        >
                          <PenSquare className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">Edit before sending</TooltipContent>
                    </Tooltip>
                  </div>
                  <div
                    className={cn(
                      'grid overflow-hidden transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
                      isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                    )}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <button
                        type="button"
                        disabled={isGenerating}
                        onPointerDown={recordPressStart}
                        onClick={activateSuggestion}
                        className="block w-full whitespace-normal break-words px-2.5 pb-2 text-left text-ui-caption leading-normal text-muted-foreground disabled:cursor-default"
                      >
                        {suggestion.description}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function GuidedAction({
  icon: Icon,
  label,
  description,
  disabled,
  onClick,
}: {
  icon: typeof ArrowRight
  label: string
  description: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex flex-1 items-center gap-2 rounded-md border border-border/30 px-2.5 py-1.5 text-left transition-[background-color,border-color] hover:border-primary/30 hover:bg-primary/[0.04] disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded bg-primary/10 transition-colors group-hover:bg-primary/15">
        <Icon className="size-3.5 text-primary/70" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-ui-label font-medium leading-tight text-foreground/85">{label}</span>
        <span className="mt-0.5 hidden truncate text-ui-label leading-tight text-muted-foreground sm:block">{description}</span>
      </span>
    </button>
  )
}
