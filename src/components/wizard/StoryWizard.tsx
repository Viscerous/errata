import { useEffect, useRef } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot } from 'lucide-react'
import {
  type StorySetupChecklistItem,
  type StorySetupDraftFragment,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { StreamMarkdown } from '@/components/ui/stream-markdown'
import { ErrataMark } from '@/components/ErrataLogo'
import { ChatSendButton } from '@/components/chat/ChatSendButton'
import { Eyebrow, MetaLabel } from '@/components/ui/prose-text'
import { Spinner } from '@/components/ui/async-view'
import { WorkspaceHeader, WorkspaceRail, WorkspaceTitle, WorkspaceToolbar } from '@/components/ui/workspace'
import { cn } from '@/lib/utils'
import {
  STORY_SETUP_CHECKLIST,
  type StorySetupController,
} from './use-story-setup-controller'

interface StoryWizardProps {
  controller: StorySetupController
  onClose: () => void
}

const STARTING_POINTS = [
  { label: 'A premise', message: 'I have a premise, but it is still rough.' },
  { label: 'A character', message: 'I want to begin with a character.' },
  { label: 'A scene', message: 'I have a scene I can picture.' },
  { label: 'Only a mood', message: 'I only have a mood or feeling so far.' },
] as const

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
}: {
  checklist: StorySetupChecklistItem[]
  draftFragments: StorySetupDraftFragment[]
  updating: boolean
  className?: string
  idPrefix: string
}) {
  const covered = checklist.filter(item => item.status === 'covered').length
  const explored = checklist.filter(item => item.status !== 'missing').length
  const checklistByKey = new Map(checklist.map(item => [item.key, item]))

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

export function StoryWizard({ controller, onClose }: StoryWizardProps) {
  const {
    messages,
    input,
    setInput,
    streamingText,
    isStreaming,
    error,
    checklist,
    draftFragments,
    contextReady,
    send,
    stop,
    retry,
  } = controller
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  const userTurnCount = messages.filter(message => message.role === 'user').length
  const exploredCount = checklist.filter(item => item.status !== 'missing').length

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
    if (event.key === 'Enter' && !event.shiftKey) {
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
            <StorySetupRail idPrefix="mobile" checklist={checklist} draftFragments={draftFragments} updating={isStreaming} className="max-h-[45vh] border-l-0 border-t border-border/30" />
          </details>

          <div className="min-h-0 flex-1 overflow-y-auto" data-component-id="story-setup-transcript">
            <div className="mx-auto w-full max-w-2xl space-y-7 px-4 py-8 sm:px-6 sm:py-10" aria-live="polite">
              {messages.map((message, index) => message.role === 'assistant' ? (
                <AssistantTurn key={`assistant-${index}`} content={message.content} />
              ) : (
                <WriterTurn key={`user-${index}`} content={message.content} />
              ))}

              {isStreaming && <AssistantTurn content={streamingText} streaming={Boolean(streamingText)} />}

              {userTurnCount === 0 && !isStreaming && messages.some(message => message.role === 'assistant') && (
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

          <div className="shrink-0 border-t border-border/40 bg-panel-muted/45" data-component-id="story-setup-composer-column">
            <div className="mx-auto w-full max-w-2xl px-4 py-3 sm:px-6">
              <div className="flex items-end gap-2">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={event => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isStreaming || !contextReady}
                  rows={1}
                  autoFocus
                  aria-label="Your story idea"
                  placeholder="Tell Errata whatever you have..."
                  className="max-h-44 min-h-11 flex-1 resize-none border-border/40 bg-elevated/60 text-ui-body leading-6 shadow-none placeholder:italic focus-visible:ring-primary/20"
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
              </div>
              <p className="mt-2 text-center text-ui-label text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
            </div>
          </div>
        </div>
        <StorySetupRail idPrefix="desktop" checklist={checklist} draftFragments={draftFragments} updating={isStreaming} className="hidden w-72 xl:flex" />
      </main>
    </div>
  )
}
