import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EmptyHint } from '@/components/ui/prose-text'
import { AssistantMessageView } from '@/components/chat/ChatMessageParts'
import { ChatSendButton } from '@/components/chat/ChatSendButton'
import { ComposerFrame, ComposerTextarea, ComposerToolbar } from '@/components/chat/ComposerSurface'
import { useChatTurn, type ChatTurnMessage } from '@/components/chat/use-chat-turn'

interface LibrarianChatProps {
  storyId: string
  conversationId: string
  initialInput?: string
}

export function LibrarianChat({ storyId, conversationId, initialInput }: LibrarianChatProps) {
  const queryClient = useQueryClient()
  const [loaded, setLoaded] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const initialInputAppliedRef = useRef<string | null>(null)
  const prevConversationIdRef = useRef<string | null | undefined>(undefined)

  const historyQueryKey = useMemo(
    () => ['librarian-conversation-history', storyId, conversationId],
    [conversationId, storyId],
  )

  const startTurn = useCallback((messages: ChatTurnMessage[], runId: string, signal: AbortSignal) => (
    api.librarian.conversationChat(storyId, conversationId, messages, runId, signal)
  ), [conversationId, storyId])

  const cancelTurn = useCallback(
    (runId: string) => api.agents.cancel(storyId, runId),
    [storyId],
  )

  const commitTurn = useCallback(async () => {
    // Independent refetches, and the composer only regains focus once they
    // settle — so they run together rather than one round trip after another.
    await Promise.all([
      // Fragment queries so sidebar lists update
      queryClient.invalidateQueries({ queryKey: ['fragments', storyId] }),
      queryClient.invalidateQueries({ queryKey: historyQueryKey }),
      // Conversation list so titles/timestamps refresh
      queryClient.invalidateQueries({ queryKey: ['librarian-conversations', storyId] }),
    ])
  }, [conversationId, historyQueryKey, queryClient, storyId])

  const {
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
  } = useChatTurn({ start: startTurn, cancel: cancelTurn, onCommit: commitTurn })

  // Reset state when conversationId changes
  useEffect(() => {
    if (prevConversationIdRef.current !== conversationId) {
      prevConversationIdRef.current = conversationId
      setMessages([])
      setLoaded(false)
      setError(null)
    }
  }, [conversationId])

  // Apply initial input when it changes or when component becomes visible
  useEffect(() => {
    if (initialInput && initialInput !== initialInputAppliedRef.current) {
      setInput(initialInput)
      initialInputAppliedRef.current = initialInput
      // Focus the textarea after setting input
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 0)
    }
  })

  // Load persisted chat history on mount
  const { data: chatHistory } = useQuery({
    queryKey: historyQueryKey,
    queryFn: () => api.librarian.getConversationHistory(storyId, conversationId),
    staleTime: Infinity,
  })

  useEffect(() => {
    if (chatHistory && !loaded && !isStreaming) {
      if (chatHistory.messages.length > 0) {
        setMessages(chatHistory.messages.map(m => {
          if (m.role === 'assistant') {
            return {
              role: 'assistant' as const,
              content: m.content,
              ...(m.reasoning ? { reasoning: m.reasoning } : {}),
            }
          }
          return m
        }))
      }
      setLoaded(true)
    }
  }, [chatHistory, loaded, isStreaming])

  const isNearBottomRef = useRef(true)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Track whether user is near the bottom of the scroll area
  useEffect(() => {
    const scrollArea = messagesEndRef.current?.closest('[data-radix-scroll-area-viewport]')
    if (!scrollArea) return
    const handleScroll = () => {
      const threshold = 80
      isNearBottomRef.current = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < threshold
    }
    scrollArea.addEventListener('scroll', handleScroll, { passive: true })
    return () => scrollArea.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-scroll only when already near the bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom()
    }
  }, [messages, scrollToBottom])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }, [send])

  return (
    <div className="flex flex-col h-full" data-component-id="librarian-chat-root">
      {/* Messages area */}
      <ScrollArea className="flex-1 min-h-0" data-component-id="librarian-chat-scroll">
        <div className="p-3 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center" data-component-id="librarian-chat-empty">
              <EmptyHint className="max-w-[240px]">
                Ask the librarian to make changes across your story — update characters, adjust guidelines, or reshape knowledge.
              </EmptyHint>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={`${msg.role}-${i}`}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
                  msg.role === 'user'
                    ? 'bg-primary/10 text-foreground'
                    : 'bg-card/50 border border-border/30 text-foreground/80'
                }`}
              >
                {msg.role === 'assistant' ? (
                  <AssistantMessageView
                    msg={msg}
                    streaming={isStreaming && i === messages.length - 1}
                    storyId={storyId}
                  />
                ) : (
                  <div className="break-words whitespace-pre-wrap">{msg.content}</div>
                )}
              </div>
            </div>
          ))}

          {error && (
            <div className="text-xs text-destructive bg-destructive/5 rounded-md p-2">
              {error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="p-3">
        <ComposerFrame>
          <ComposerTextarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Ask the librarian"
            placeholder="Ask the librarian..."
            disabled={isStreaming}
            className="min-h-11 max-h-[400px]"
            rows={1}
            data-component-id="librarian-chat-input"
          />
          <ComposerToolbar>
            <span className="text-ui-label text-muted-foreground">Enter to send · Shift+Enter for newline</span>
            <ChatSendButton
              isStreaming={isStreaming}
              canSend={!!input.trim()}
              onSend={send}
              onStop={stop}
              stopLabel="Stop the librarian"
              idPrefix="librarian-chat"
            />
          </ComposerToolbar>
        </ComposerFrame>
      </div>
    </div>
  )
}
