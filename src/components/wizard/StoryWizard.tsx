import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Check, LoaderCircle, Square, X } from 'lucide-react'
import { api, type StorySetupMessage, type StorySetupResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { StreamMarkdown } from '@/components/ui/stream-markdown'
import { ErrataMark } from '@/components/ErrataLogo'

interface StoryWizardProps {
  storyId: string
  onComplete: () => void
}

const STARTING_POINTS = [
  { label: 'A premise', message: 'I have a premise, but it is still rough.' },
  { label: 'A character', message: 'I want to begin with a character.' },
  { label: 'A scene', message: 'I have a scene I can picture.' },
  { label: 'Only a mood', message: 'I only have a mood or feeling so far.' },
] as const

function AssistantTurn({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <article className="flex items-start gap-3 sm:gap-4" data-component-id="story-setup-assistant-turn">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center text-primary/75" aria-hidden>
        <ErrataMark size={18} />
      </div>
      <div className="min-w-0 max-w-[70ch] flex-1 font-prose text-[0.975rem] leading-7 text-foreground/90 sm:text-base">
        <span className="sr-only">Errata: </span>
        {content ? (
          <StreamMarkdown content={content} streaming={streaming} variant="prose" />
        ) : (
          <div className="flex h-7 items-center gap-1.5 text-muted-foreground" aria-label="Errata is thinking">
            <span className="size-1 rounded-full bg-current motion-safe:animate-wisp-breathe" />
            <span className="size-1 rounded-full bg-current motion-safe:animate-wisp-breathe [animation-delay:180ms]" />
            <span className="size-1 rounded-full bg-current motion-safe:animate-wisp-breathe [animation-delay:360ms]" />
          </div>
        )}
      </div>
    </article>
  )
}

function WriterTurn({ content }: { content: string }) {
  return (
    <article className="ml-10 sm:ml-11" data-component-id="story-setup-writer-turn">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">You</p>
      <p className="max-w-[68ch] whitespace-pre-wrap rounded-lg bg-muted/45 px-4 py-3 font-prose text-[0.95rem] leading-6 text-foreground sm:text-base">
        {content}
      </p>
    </article>
  )
}

function SetupComplete({ result, onOpen }: { result: StorySetupResult; onOpen: () => void }) {
  const grouped = useMemo(() => {
    const counts = new Map<string, number>()
    for (const fragment of result.created) {
      counts.set(fragment.type, (counts.get(fragment.type) ?? 0) + 1)
    }
    return [...counts.entries()]
  }, [result.created])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-6 py-16 text-center" data-component-id="story-setup-complete">
      <div className="mb-6 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Check className="size-5" aria-hidden />
      </div>
      <h2 className="font-display text-3xl italic text-balance sm:text-4xl">{result.plan.name}</h2>
      {result.plan.description && (
        <p className="mt-4 max-w-[60ch] font-prose text-base leading-7 text-foreground/70">
          {result.plan.description}
        </p>
      )}
      <div className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        {grouped.map(([type, count]) => (
          <span key={type}>{count} {type}{count === 1 ? '' : 's'}</span>
        ))}
        {grouped.length === 0 && <span>Story details saved</span>}
      </div>
      <Button className="mt-10" onClick={onOpen}>
        Open story
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">Everything created here remains editable.</p>
    </div>
  )
}

export function StoryWizard({ storyId, onComplete }: StoryWizardProps) {
  const queryClient = useQueryClient()
  const [messages, setMessages] = useState<StorySetupMessage[]>([])
  const [input, setInput] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StorySetupResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const initialRequestRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  const hasUserAnswer = messages.some(message => message.role === 'user' && message.content.trim())
  const userTurnCount = messages.filter(message => message.role === 'user').length

  const requestAssistant = useCallback(async (history: StorySetupMessage[]) => {
    const controller = new AbortController()
    abortRef.current = controller
    setIsStreaming(true)
    setStreamingText('')
    setError(null)
    let accumulated = ''

    try {
      const stream = await api.storySetup.chat(storyId, history, controller.signal)
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === 'text') {
          accumulated += value.text
          setStreamingText(accumulated)
        }
      }
    } catch (caught) {
      if ((caught as Error).name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : 'Errata could not continue the conversation.')
      }
    } finally {
      if (accumulated.trim()) {
        setMessages([...history, { role: 'assistant', content: accumulated.trim() }])
      }
      setStreamingText('')
      setIsStreaming(false)
      abortRef.current = null
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }, [storyId])

  useEffect(() => {
    if (initialRequestRef.current) return
    initialRequestRef.current = true
    requestAssistant([])
    return () => abortRef.current?.abort()
  }, [requestAssistant])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth', block: 'end' })
  }, [messages, streamingText, isStreaming])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`
  }, [input])

  const send = useCallback((content: string) => {
    const trimmed = content.trim()
    if (!trimmed || isStreaming || isCreating) return
    const history: StorySetupMessage[] = [...messages, { role: 'user', content: trimmed }]
    setMessages(history)
    setInput('')
    requestAssistant(history)
  }, [isCreating, isStreaming, messages, requestAssistant])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    send(input)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send(input)
    }
  }

  const handleCreate = async () => {
    if (!hasUserAnswer || isStreaming || isCreating) return
    setIsCreating(true)
    setError(null)
    try {
      const setup = await api.storySetup.complete(storyId, messages)
      setResult(setup)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['story', storyId] }),
        queryClient.invalidateQueries({ queryKey: ['fragments', storyId] }),
        queryClient.invalidateQueries({ queryKey: ['wizard-fragments', storyId] }),
        queryClient.invalidateQueries({ queryKey: ['fragment-count', storyId] }),
        queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] }),
      ])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Errata could not create the story setup.')
    } finally {
      setIsCreating(false)
    }
  }

  const handleClose = () => {
    abortRef.current?.abort()
    onComplete()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-component-id="story-setup-root">
      <header className="shrink-0 border-b border-border/25 bg-background/95 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <ErrataMark size={22} className="shrink-0 text-primary" />
            <div className="min-w-0">
              <h1 className="truncate font-display text-xl italic leading-tight sm:text-2xl">Shape your story</h1>
              <p className="hidden text-xs text-muted-foreground sm:block">Talk it through, then create only what feels useful.</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!result && (
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={!hasUserAnswer || isStreaming || isCreating}
              >
                {isCreating && <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />}
                {isCreating ? 'Creating story' : 'Create story'}
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={handleClose} aria-label="Skip setup and close">
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </header>

      {result ? (
        <SetupComplete result={result} onOpen={onComplete} />
      ) : (
        <>
          <main className="min-h-0 flex-1 overflow-y-auto" data-component-id="story-setup-transcript">
            <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-8 sm:px-8 sm:py-12" aria-live="polite">
              {messages.map((message, index) => message.role === 'assistant' ? (
                <AssistantTurn key={`assistant-${index}`} content={message.content} />
              ) : (
                <WriterTurn key={`user-${index}`} content={message.content} />
              ))}

              {isStreaming && <AssistantTurn content={streamingText} streaming={Boolean(streamingText)} />}

              {userTurnCount === 0 && !isStreaming && messages.some(message => message.role === 'assistant') && (
                <div className="ml-10 space-y-3 sm:ml-11">
                  <p className="text-xs text-muted-foreground">You can start anywhere</p>
                  <div className="flex flex-wrap gap-2">
                    {STARTING_POINTS.map(point => (
                      <button
                        key={point.label}
                        type="button"
                        onClick={() => send(point.message)}
                        className="rounded-md border border-border/50 px-3 py-2 text-sm text-foreground/75 transition-colors hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        {point.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="ml-10 rounded-lg bg-destructive/8 px-4 py-3 text-sm text-destructive sm:ml-11" role="alert">
                  <p>{error}</p>
                  <button
                    type="button"
                    onClick={() => requestAssistant(messages)}
                    className="mt-2 font-medium underline underline-offset-4 hover:no-underline"
                  >
                    Try the conversation again
                  </button>
                </div>
              )}
              <div ref={endRef} />
            </div>
          </main>

          <footer className="shrink-0 border-t border-border/25 bg-background px-4 py-3 sm:px-6 sm:py-4">
            <form onSubmit={handleSubmit} className="mx-auto max-w-3xl">
              <div className="flex items-end gap-2 rounded-xl border border-border/55 bg-card/25 p-2 focus-within:border-foreground/35">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={event => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isStreaming || isCreating}
                  rows={1}
                  autoFocus
                  aria-label="Your story idea"
                  placeholder="Tell Errata whatever you have..."
                  className="max-h-44 min-h-10 flex-1 resize-none border-0 bg-transparent px-2 py-2 font-prose text-base leading-6 shadow-none focus-visible:ring-0 placeholder:text-muted-foreground"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => abortRef.current?.abort()}
                    aria-label="Stop Errata"
                  >
                    <Square className="size-3 fill-current" aria-hidden />
                  </Button>
                ) : (
                  <Button type="submit" size="icon-sm" disabled={!input.trim() || isCreating} aria-label="Send message">
                    <ArrowUp className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between gap-4 px-1 text-[0.6875rem] text-muted-foreground">
                <p>Nothing is saved until you create the story.</p>
                <p className="hidden sm:block">Enter to send, Shift+Enter for a new line</p>
              </div>
            </form>
          </footer>
        </>
      )}
    </div>
  )
}
