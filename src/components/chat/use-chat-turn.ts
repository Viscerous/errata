import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatEvent } from '@/lib/api'
import { generateRunId } from '@/lib/client-ids'
import type { AssistantMessage, ChatMessage } from './ChatMessageParts'

/** How tall the composer grows before it scrolls instead. */
const MAX_COMPOSER_HEIGHT = 400

/** The wire shape both chat endpoints accept — text only, no tool records. */
export interface ChatTurnMessage {
  role: 'user' | 'assistant'
  content: string
}

interface UseChatTurnOptions {
  /**
   * Opens the event stream for one turn against the history it is built from.
   * A caller that has to create its conversation first does that here, so the
   * conversation only comes into being on a turn that was actually sent.
   */
  start: (
    messages: ChatTurnMessage[],
    runId: string,
    signal: AbortSignal,
  ) => Promise<ReadableStream<ChatEvent>>
  /** Requests server-side cancellation for the active run. */
  cancel: (runId: string) => Promise<unknown>
  /** Runs after a turn commits, for cache invalidation. */
  onCommit?: () => Promise<void> | void
}

/** Folds one streamed event into the assistant message being built. */
function applyEvent(message: AssistantMessage, event: ChatEvent): AssistantMessage {
  switch (event.type) {
    case 'text':
      return { ...message, content: message.content + (event.text ?? '') }
    case 'reasoning':
      return { ...message, reasoning: (message.reasoning ?? '') + (event.text ?? '') }
    case 'tool-call':
      return {
        ...message,
        toolCalls: [
          ...(message.toolCalls ?? []),
          { id: event.id, toolName: event.toolName, args: event.args ?? {} },
        ],
      }
    case 'tool-result':
      return {
        ...message,
        toolCalls: (message.toolCalls ?? []).map(tc =>
          tc.id === event.id ? { ...tc, result: event.result } : tc,
        ),
      }
    default:
      return message
  }
}

/**
 * One chat turn as a transaction over the composer and the transcript.
 *
 * Sending moves the text into the transcript optimistically. A stopped or
 * failed turn is rewound as a whole because the server persists chat only on
 * successful completion. A normal finish commits the rendered reply.
 */
export function useChatTurn({ start, cancel, onCommit }: UseChatTurnOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeRef = useRef<{ controller: AbortController; runId: string } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => () => {
    const active = activeRef.current
    if (!active) return
    void cancel(active.runId).catch(() => active.controller.abort())
  }, [cancel])

  // The composer grows with its text. Lives here because the hook already owns
  // both halves — the text and the element it is typed into.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT) + 'px'
  }, [input])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || activeRef.current) return

    const previous = messages
    const history: ChatMessage[] = [...previous, { role: 'user', content: text }]
    setInput('')
    setError(null)
    // Placeholder assistant message so the reply has somewhere to stream into.
    setMessages([...history, { role: 'assistant', content: '' }])
    setIsStreaming(true)

    const controller = new AbortController()
    const runId = generateRunId()
    activeRef.current = { controller, runId }

    let assistant: AssistantMessage = { role: 'assistant', content: '' }
    let failure: string | null = null
    let finished = false
    let stopped = false

    try {
      const stream = await start(
        history.map(({ role, content }) => ({ role, content })),
        runId,
        controller.signal,
      )
      const reader = stream.getReader()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === 'finish') {
          finished = true
          stopped = value.stopped === true
        } else {
          assistant = applyEvent(assistant, value)
        }
        setMessages([...history, assistant])
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        failure = err instanceof Error ? err.message : 'Chat failed'
      }
    } finally {
      if (activeRef.current?.runId === runId) activeRef.current = null
      setIsStreaming(false)
    }

    if (!finished && !failure && !controller.signal.aborted) {
      failure = 'Chat stream ended before reporting completion'
    }
    setError(failure)
    if (finished && !stopped && !failure) {
      // The read loop already rendered this exact message; only the commit is left.
      await onCommit?.()
    } else {
      setMessages(previous)
      setInput(text)
    }
    textareaRef.current?.focus()
  }, [input, messages, onCommit, start])

  const stop = useCallback(() => {
    const active = activeRef.current
    if (!active) return
    void cancel(active.runId).catch(() => active.controller.abort())
  }, [cancel])

  return {
    messages,
    setMessages,
    input,
    setInput,
    isStreaming,
    error,
    setError,
    send,
    stop,
    textareaRef,
  }
}
