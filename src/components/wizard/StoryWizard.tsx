import { useEffect, useRef } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, PenLine } from 'lucide-react'
import {
  type StorySetupChecklistItem,
  type StorySetupDraftFragment,
  type StorySetupOption,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { StreamMarkdown } from '@/components/ui/stream-markdown'
import { ErrataMark } from '@/components/ErrataLogo'
import { ChatSendButton } from '@/components/chat/ChatSendButton'
import { ChatComposerRow, ChatComposerTextarea, ComposerFrame } from '@/components/chat/ComposerSurface'
import { Eyebrow, MetaLabel } from '@/components/ui/prose-text'
import { Spinner } from '@/components/ui/async-view'
import { WorkspaceHeader, WorkspaceRail, WorkspaceTitle, WorkspaceToolbar } from '@/components/ui/workspace'
import { cn } from '@/lib/utils'
import { isEnterToSubmit } from '@/lib/enter-to-submit'
import {
  STORY_SETUP_CHECKLIST,
  type StorySetupController,
} from './use-story-setup-controller'

export interface StorySetupHandoff {
  mode: 'generate' | 'write'
  prompt?: string
}

interface StoryWizardProps {
  controller: StorySetupController
  onClose: () => void
  onStartWriting?: (handoff?: StorySetupHandoff) => void
}

const STARTING_POINTS = [
  { label: 'A premise', message: 'I have a premise, but it is still rough.' },
  { label: 'A character', message: 'I want to begin with a character.' },
  { label: 'A scene', message: 'I have a scene I can picture.' },
  { label: 'Only a mood', message: 'I only have a mood or feeling so far.' },
] as const

const CHECKLIST_CATEGORY_TITLES = new Set([
  'starting point',
  'premise',
  'what it is about',
  'characters',
  'central characters',
  'protagonist',
  'goal',
  'goal and stakes',
  'stakes',
  'setting',
  'world rules',
  'voice',
  'voice and tone',
  'tone',
  'opening',
  'opening direction',
  'summary',
  'note',
  'notes',
  'fragment',
  'fragments',
  'guideline',
  'knowledge',
  'character card',
])

const STEP_OR_SEQUENCE_PATTERN = /^(?:step|phase|part|stage)\s*\d+|^first\b|^second\b|^third\b|^fourth\b|^fifth\b|^then\b|^next\b|^finally\b|^lastly\b/i
const QUESTION_WORD_PATTERN = /^(?:why|how|what|when|who|where|which|is|are|can|could|would|should|do|does|did)\b/i
const CHOICE_PROMPT_PATTERN = /\b(?:which|choose|pick|prefer|resonate|possibilit|option|direction|approach|archetype|alternative|feel right|sound best|lean toward|either)\b/i

export function extractAssistantSuggestions(content: string): string[] {
  if (!content) return []
  // An option list must occur in a message that actually poses a choice or question
  if (!content.includes('?') && !CHOICE_PROMPT_PATTERN.test(content)) {
    return []
  }

  const suggestions: string[] = []
  const lines = content.split('\n')
  for (const line of lines) {
    const match = line.match(/^\s*(?:[*•-]|(?:\d+[.)]))\s+\*\*([^*]+)\*\*/)
    if (match) {
      const label = match[1].replace(/[:\s–—-]+$/, '').trim()
      if (
        label.length > 0 &&
        label.length <= 60 &&
        !label.endsWith('?') &&
        !QUESTION_WORD_PATTERN.test(label) &&
        !STEP_OR_SEQUENCE_PATTERN.test(label) &&
        !CHECKLIST_CATEGORY_TITLES.has(label.toLowerCase()) &&
        !suggestions.includes(label)
      ) {
        suggestions.push(label)
      }
    }
  }
  return suggestions.length >= 2 && suggestions.length <= 8 ? suggestions : []
}

function AssistantTurn({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <article className="flex items-start gap-3" data-component-id="story-setup-assistant-turn">
      <div className="mt-1 flex size-6 shrink-0 items-center justify-center text-primary/65" aria-hidden>
        <ErrataMark size={14} />
      </div>
      <div className="min-w-0 max-w-[70ch] flex-1 font-prose text-base leading-7 text-foreground/90">
        <span className="sr-only">Errata: </span>
        {content ? (
          <StreamMarkdown content={content} streaming={streaming} variant="prose" />
        ) : (
          <div className="flex h-7 items-center gap-2 text-ui-caption text-muted-foreground">
            <Spinner size="sm" label="Errata is thinking" />
            <span>Thinking…</span>
          </div>
        )}
      </div>
    </article>
  )
}

function WriterTurn({ content }: { content: string }) {
  return (
    <article className="flex justify-end" data-component-id="story-setup-writer-turn">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary/8 px-4 py-2.5 text-ui-body leading-relaxed text-foreground">
        {content}
      </p>
    </article>
  )
}

function ChecklistStatus({ status }: { status: StorySetupChecklistItem['status'] }) {
  if (status === 'covered') {
    return <CircleCheck className="size-4 shrink-0 text-foreground/75" aria-label="Covered" />
  }
  if (status === 'partial') {
    return <CircleDot className="size-4 shrink-0 text-muted-foreground" aria-label="Partly covered" />
  }
  return <Circle className="size-4 shrink-0 text-muted-foreground/35" aria-label="Not covered yet" />
}

function StorySetupRail({
  checklist,
  draftFragments,
  updating,
  className,
  idPrefix,
  onStartWriting,
}: {
  checklist: StorySetupChecklistItem[]
  draftFragments: StorySetupDraftFragment[]
  updating: boolean
  className?: string
  idPrefix: string
  onStartWriting?: (handoff?: StorySetupHandoff) => void
}) {
  const covered = checklist.filter(item => item.status === 'covered').length
  const explored = checklist.filter(item => item.status !== 'missing').length
  const checklistByKey = new Map(checklist.map(item => [item.key, item]))
  const openingItem = checklist.find(item => item.key === 'opening')
  const openingCovered = openingItem?.status === 'covered'
  const readyToWrite = openingCovered && checklist.length > 0 && checklist.every(item => item.status !== 'missing')
  const openingSummary = openingItem?.note || 'Write the opening passage according to the story foundation guidelines.'

  return (
    <WorkspaceRail className={cn('gap-7 overflow-y-auto px-5 py-6', className)} data-component-id="story-setup-progress">
      <section aria-labelledby={`${idPrefix}-checklist-heading`}>
        <div className="flex items-baseline justify-between gap-3">
          <Eyebrow asChild><h2 id={`${idPrefix}-checklist-heading`}>Story outline</h2></Eyebrow>
          <MetaLabel className="shrink-0 tabular-nums">{explored} / {STORY_SETUP_CHECKLIST.length}</MetaLabel>
        </div>
        <p className="mt-2 text-ui-caption leading-5 text-muted-foreground">
          {covered} complete · Suggestions, not requirements.
        </p>
        <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 xl:grid-cols-1">
          {STORY_SETUP_CHECKLIST.map(definition => {
            const item = checklistByKey.get(definition.key) ?? {
              key: definition.key,
              status: 'missing' as const,
              note: '',
            }
            return (
              <li key={definition.key} className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5"><ChecklistStatus status={item.status} /></span>
                <div className="min-w-0">
                  <p className={`text-ui-caption leading-5 ${item.status === 'missing' ? 'text-muted-foreground' : 'text-foreground/85'}`}>
                    {definition.label}
                  </p>
                  {item.note && <p className="line-clamp-2 text-ui-label leading-4 text-muted-foreground">{item.note}</p>}
                </div>
              </li>
            )
          })}
        </ul>
        {readyToWrite && onStartWriting && (
          <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-ui-caption" data-component-id={`${idPrefix}-foundation-ready`}>
            <p className="font-medium text-foreground">Foundation ready</p>
            <p className="mt-1 text-ui-label leading-relaxed text-muted-foreground">
              {openingItem?.note ? `Opening direction: ${openingItem.note}` : 'Your story outline and opening direction are set.'}
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              <Button
                type="button"
                size="sm"
                onClick={() => onStartWriting({ mode: 'generate', prompt: openingSummary })}
                className="w-full gap-1.5 text-ui-caption font-medium"
                data-component-id={`${idPrefix}-generate-opening-button`}
              >
                <PenLine className="size-3.5" aria-hidden />
                Generate opening scene
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onStartWriting({ mode: 'write', prompt: openingSummary })}
                className="w-full gap-1.5 text-ui-caption font-normal border-border/50 text-foreground/80 hover:text-foreground"
                data-component-id={`${idPrefix}-start-writing-button`}
              >
                Write in manuscript
              </Button>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby={`${idPrefix}-fragments-heading`}>
        <div className="flex items-center justify-between gap-3">
          <Eyebrow asChild><h2 id={`${idPrefix}-fragments-heading`}>Fragments</h2></Eyebrow>
          {updating && <span className="text-ui-label text-muted-foreground">Updating</span>}
        </div>
        <p className="mt-2 text-ui-caption leading-5 text-muted-foreground">Saved as the conversation develops.</p>

        {draftFragments.length === 0 ? (
          <p className="mt-4 text-ui-caption leading-5 text-muted-foreground">Fragments will appear here as the idea takes shape.</p>
        ) : (
          <div className="mt-3 divide-y divide-border/30 border-y border-border/30">
            {draftFragments.map(fragment => (
              <details key={fragment.id ?? fragment.key} className="group py-3">
                <summary className="cursor-pointer list-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground/90">{fragment.name}</p>
                      <p className="mt-0.5 text-ui-label text-muted-foreground">{fragment.type}</p>
                    </div>
                    <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
                  </div>
                  <p className="mt-1.5 text-ui-label leading-4 text-muted-foreground">{fragment.description}</p>
                </summary>
                <p className="mt-3 whitespace-pre-wrap font-prose text-xs leading-5 text-foreground/75">{fragment.content}</p>
              </details>
            ))}
          </div>
        )}
      </section>
    </WorkspaceRail>
  )
}

export function StoryWizard({ controller, onClose, onStartWriting }: StoryWizardProps) {
  const {
    messages,
    input,
    setInput,
    streamingText,
    isStreaming,
    error,
    checklist,
    draftFragments,
    options = [],
    contextReady,
    send,
    stop,
    retry,
  } = controller
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  const userTurnCount = messages.filter(message => message.role === 'user').length
  const exploredCount = checklist.filter(item => item.status !== 'missing').length
  const openingItem = checklist.find(item => item.key === 'opening')
  const openingCovered = openingItem?.status === 'covered'
  const readyToWrite = openingCovered && checklist.length > 0 && checklist.every(item => item.status !== 'missing')
  const openingSummary = openingItem?.note || 'Write the opening passage according to the story foundation guidelines.'

  const handleStartWriting = (handoff?: StorySetupHandoff) => {
    if (onStartWriting) {
      onStartWriting(handoff ?? { mode: 'generate', prompt: openingSummary })
    } else {
      onClose()
    }
  }

  const latestAssistantMessage = messages.length > 0 && messages[messages.length - 1].role === 'assistant'
    ? messages[messages.length - 1]
    : null

  // Conscious model options from the tool call take precedence; fallback to guarded markdown extraction
  const activeOptions: StorySetupOption[] = !isStreaming
    ? options.length > 0
      ? options
      : latestAssistantMessage
        ? extractAssistantSuggestions(latestAssistantMessage.content).map(label => ({ label }))
        : []
    : []

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth', block: 'end' })
  }, [messages, streamingText, isStreaming])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`
  }, [input])

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus()
  }, [isStreaming])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isEnterToSubmit(event)) {
      event.preventDefault()
      send(input)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-component-id="story-setup-root">
      <WorkspaceHeader>
        <div className="flex min-w-0 items-center gap-2.5">
          <ErrataMark size={16} className="shrink-0 text-primary/70" />
          <WorkspaceTitle>Story setup</WorkspaceTitle>
        </div>
        <WorkspaceToolbar>
          {readyToWrite && (
            <Button
              variant="default"
              size="sm"
              onClick={() => handleStartWriting({ mode: 'generate', prompt: openingSummary })}
              className="gap-1.5 text-ui-caption font-medium"
              data-component-id="story-setup-start-writing"
            >
              <PenLine className="size-3.5" aria-hidden />
              Start writing
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 text-ui-caption text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to story
          </Button>
        </WorkspaceToolbar>
      </WorkspaceHeader>

      <main className="flex min-h-0 flex-1" data-component-id="story-setup-main">
        <div className="flex min-w-0 flex-1 flex-col">
          <details className="shrink-0 border-b border-border/40 bg-panel-muted/50 xl:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-ui-caption text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              Story outline
              <span className="flex items-center gap-2 tabular-nums">
                {exploredCount} / {STORY_SETUP_CHECKLIST.length}
                <ChevronDown className="size-3.5" aria-hidden />
              </span>
            </summary>
            <StorySetupRail idPrefix="mobile" checklist={checklist} draftFragments={draftFragments} updating={isStreaming} onStartWriting={handleStartWriting} className="max-h-[45vh] border-l-0 border-t border-border/30" />
          </details>

          <div className="min-h-0 flex-1 overflow-y-auto" data-component-id="story-setup-transcript">
            <div className="mx-auto w-full max-w-2xl space-y-7 px-4 py-8 sm:px-6 sm:py-10" aria-live="polite">
              {messages.map((message, index) => message.role === 'assistant' ? (
                <AssistantTurn key={`assistant-${index}`} content={message.content} />
              ) : (
                <WriterTurn key={`user-${index}`} content={message.content} />
              ))}

              {isStreaming && <AssistantTurn content={streamingText} streaming={Boolean(streamingText)} />}

              {userTurnCount === 0 && !isStreaming && activeOptions.length === 0 && messages.some(message => message.role === 'assistant') && (
                <div className="space-y-2.5 pl-9">
                  <MetaLabel asChild><p>You can start anywhere</p></MetaLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {STARTING_POINTS.map(point => (
                      <Button
                        key={point.label}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => send(point.message)}
                        className="h-7 border-border/50 bg-transparent text-ui-caption font-normal text-foreground/75"
                      >
                        {point.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {activeOptions.length > 0 && (
                <div className="space-y-2.5 pl-9" data-component-id="story-setup-suggestions">
                  <MetaLabel asChild><p>Suggestions</p></MetaLabel>
                  <div className="flex flex-wrap gap-2">
                    {activeOptions.map(option => (
                      <Button
                        key={option.label}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!contextReady}
                        onClick={() => send(option.value ?? option.label)}
                        className={cn(
                          'h-auto py-1.5 px-3 border-border/50 bg-transparent text-left text-ui-caption font-normal text-foreground/80 hover:border-primary/40 hover:bg-primary/5 hover:text-foreground',
                          option.description && 'flex-col items-start gap-0.5 min-w-[140px]',
                        )}
                        data-component-id="story-setup-suggestion-button"
                      >
                        <span className="font-medium text-foreground">{option.label}</span>
                        {option.description && (
                          <span className="text-ui-label text-muted-foreground line-clamp-2 leading-relaxed">
                            {option.description}
                          </span>
                        )}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-ui-body text-destructive" role="alert">
                  <p>{error}</p>
                  <button
                    type="button"
                    onClick={retry}
                    className="mt-2 font-medium underline underline-offset-4 hover:no-underline"
                  >
                    Retry story setup
                  </button>
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>

          <div className="shrink-0" data-component-id="story-setup-composer-column">
            <div className="mx-auto w-full max-w-2xl px-4 py-3 sm:px-6">
              <ComposerFrame>
                <ChatComposerRow>
                  <ChatComposerTextarea
                    ref={textareaRef}
                    value={input}
                    onChange={event => setInput(event.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={isStreaming || !contextReady}
                    rows={1}
                    autoFocus
                    aria-label="Your story idea"
                    placeholder="Tell Errata whatever you have..."
                    className="max-h-44"
                  />
                  <ChatSendButton
                    isStreaming={isStreaming}
                    canSend={contextReady && Boolean(input.trim())}
                    onSend={() => send(input)}
                    onStop={stop}
                    stopLabel="Stop Errata"
                    idPrefix="story-setup"
                    size="md"
                  />
                </ChatComposerRow>
              </ComposerFrame>
            </div>
          </div>
        </div>
        <StorySetupRail idPrefix="desktop" checklist={checklist} draftFragments={draftFragments} updating={isStreaming} onStartWriting={handleStartWriting} className="hidden w-72 xl:flex" />
      </main>
    </div>
  )
}
