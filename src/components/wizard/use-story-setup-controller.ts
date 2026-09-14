import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  api,
  type StorySetupChatMode,
  type StorySetupChecklistItem,
  type StorySetupChecklistKey,
  type StorySetupDraftFragment,
  type StorySetupMessage,
  type StorySetupOption,
} from '@/lib/api'
import { invalidateStoryContent } from '@/lib/branch-cache'
import {
  readStorySetupSession,
  writeStorySetupSession,
} from './story-setup-session'

export const STORY_SETUP_CHECKLIST: Array<{ key: StorySetupChecklistKey; label: string }> = [
  { key: 'starting-point', label: 'Starting point' },
  { key: 'premise', label: 'What it is about' },
  { key: 'characters', label: 'Characters' },
  { key: 'goal', label: 'Goal and stakes' },
  { key: 'setting', label: 'Setting' },
  { key: 'voice', label: 'Voice and tone' },
  { key: 'opening', label: 'Opening direction' },
]

const INITIAL_CHECKLIST: StorySetupChecklistItem[] = STORY_SETUP_CHECKLIST.map(item => ({
  key: item.key,
  status: 'missing',
  note: '',
}))

export interface StorySetupController {
  messages: StorySetupMessage[]
  input: string
  setInput: (value: string) => void
  streamingText: string
  isStreaming: boolean
  error: string | null
  checklist: StorySetupChecklistItem[]
  draftFragments: StorySetupDraftFragment[]
  options: StorySetupOption[]
  sessionLoaded: boolean
  contextReady: boolean
  send: (content: string) => void
  assess: () => void
  stop: () => void
  retry: () => void
}

interface UseStorySetupControllerOptions {
  storyId: string
  sessionScope: string
  contentRevision: string | undefined
  active: boolean
}

function normalizeChecklist(
  items: StorySetupChecklistItem[],
  previous?: StorySetupChecklistItem[],
): StorySetupChecklistItem[] {
  const byKey = new Map(items.map(item => [item.key, item]))
  const prevByKey = new Map(previous?.map(item => [item.key, item]))
  return STORY_SETUP_CHECKLIST.map(definition => {
    const incoming = byKey.get(definition.key)
    const prev = prevByKey.get(definition.key)
    if (!incoming) {
      return prev ?? {
        key: definition.key,
        status: 'missing',
        note: '',
      }
    }
    // Ratchet covered status so follow-up or refinement questions do not
    // cause covered concerns to flicker back to partial.
    const status = prev?.status === 'covered' && incoming.status === 'partial'
      ? 'covered'
      : incoming.status
    return {
      key: definition.key,
      status,
      note: incoming.note || prev?.note || '',
    }
  })
}

function storySetupErrorMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : 'Errata could not continue the conversation.'
  if (/socket hang up|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|failed to fetch/i.test(message)) {
    return 'Could not connect to the configured model. Start or reconnect its backend, then retry.'
  }
  return message
}

/**
 * Workspace-scoped owner for Story Setup conversation and agent-run state.
 * The panel may mount and unmount as navigation changes; this controller stays
 * alive for the story route, so leaving the panel does not cancel or duplicate
 * an in-flight turn.
 */
export function useStorySetupController({
  storyId,
  sessionScope,
  contentRevision,
  active,
}: UseStorySetupControllerOptions): StorySetupController {
  const queryClient = useQueryClient()
  const [messages, setMessages] = useState<StorySetupMessage[]>([])
  const [input, setInput] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checklist, setChecklist] = useState<StorySetupChecklistItem[]>(INITIAL_CHECKLIST)
  const [draftFragments, setDraftFragments] = useState<StorySetupDraftFragment[]>([])
  const [options, setOptions] = useState<StorySetupOption[]>([])
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null)
  const [contextReady, setContextReady] = useState(false)
  const [acceptedRevision, setAcceptedRevision] = useState<string | undefined>()
  const [paused, setPaused] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const loadedIdentityRef = useRef<string | null>(null)
  const lifecycleRef = useRef(0)
  const retryModeRef = useRef<StorySetupChatMode>('assess')
  const revisionRef = useRef(contentRevision)
  const checklistRef = useRef(checklist)
  const draftFragmentsRef = useRef(draftFragments)
  revisionRef.current = contentRevision
  checklistRef.current = checklist
  draftFragmentsRef.current = draftFragments

  const identity = `${storyId}:${sessionScope}`

  const requestAssistant = useCallback(async (
    history: StorySetupMessage[],
    mode: StorySetupChatMode,
  ) => {
    if (abortRef.current) return

    retryModeRef.current = mode
    const lifecycle = lifecycleRef.current
    const controller = new AbortController()
    abortRef.current = controller
    setPaused(false)
    setIsStreaming(true)
    setStreamingText('')
    setError(null)
    let accumulated = ''
    let completed = false
    let receivedSnapshot = false
    let latestToolError: string | null = null
    const previousChecklist = checklistRef.current
    const previousDraftFragments = draftFragmentsRef.current

    try {
      const stream = await api.storySetup.chat(storyId, history, mode, controller.signal)
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (lifecycle !== lifecycleRef.current) {
          await reader.cancel()
          return
        }
        if (value.type === 'text') {
          accumulated += value.text
          setStreamingText(accumulated)
        } else if (value.type === 'tool-call' && value.toolName === 'updateStorySetup') {
          const snapshot = value.args as {
            checklist?: StorySetupChecklistItem[]
            fragments?: StorySetupDraftFragment[]
            options?: Array<StorySetupOption | string>
          }
          if (Array.isArray(snapshot.checklist)) setChecklist(normalizeChecklist(snapshot.checklist, checklistRef.current))
          if (Array.isArray(snapshot.fragments)) setDraftFragments(snapshot.fragments)
          if (Array.isArray(snapshot.options)) {
            setOptions(snapshot.options.map(opt => typeof opt === 'string' ? { label: opt } : opt))
          }
        } else if (value.type === 'tool-result' && value.toolName === 'updateStorySetup') {
          receivedSnapshot = true
          const saved = value.result as {
            saved?: boolean
            checklist?: StorySetupChecklistItem[]
            fragments?: StorySetupDraftFragment[]
            options?: Array<StorySetupOption | string>
          }
          if (Array.isArray(saved.checklist)) setChecklist(normalizeChecklist(saved.checklist, checklistRef.current))
          if (Array.isArray(saved.fragments)) setDraftFragments(saved.fragments)
          if (Array.isArray(saved.options)) {
            setOptions(saved.options.map(opt => typeof opt === 'string' ? { label: opt } : opt))
          }
          if (saved.saved !== false) {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['story', storyId] }),
              queryClient.invalidateQueries({ queryKey: ['wizard-fragments', storyId] }),
              invalidateStoryContent(queryClient, storyId),
            ])
            if (lifecycle === lifecycleRef.current) setAcceptedRevision(revisionRef.current)
          }
        } else if (value.type === 'tool-error' && value.toolName === 'updateStorySetup') {
          latestToolError = value.error
        }
      }

      if (lifecycle !== lifecycleRef.current) return
      if (!receivedSnapshot) {
        setChecklist(previousChecklist)
        setDraftFragments(previousDraftFragments)
        setContextReady(false)
        throw new Error(latestToolError
          ? `Story setup could not validate its update: ${latestToolError}`
          : 'Story setup ended before it could validate the checklist. Please retry.')
      }
      if (!accumulated.trim()) {
        setContextReady(false)
        throw new Error('Story setup updated the checklist but ended before asking its next question. Please retry.')
      }
      completed = true
      if (accumulated.trim()) {
        setMessages([...history, { role: 'assistant', content: accumulated.trim() }])
      }
      setContextReady(true)
      setAcceptedRevision(revisionRef.current)
    } catch (caught) {
      if (lifecycle !== lifecycleRef.current) return
      setPaused(true)
      if ((caught as Error).name !== 'AbortError') {
        setError(storySetupErrorMessage(caught))
      }
    } finally {
      if (lifecycle !== lifecycleRef.current) return
      setStreamingText('')
      setIsStreaming(false)
      if (abortRef.current === controller) abortRef.current = null
      if (!completed && controller.signal.aborted) {
        setError(current => current ?? 'Story setup paused.')
      }
    }
  }, [queryClient, storyId])

  // Load once for each story/timeline identity. Content revisions are evaluated
  // when the surface activates, rather than resetting a live conversation every
  // time its own fragment writes advance the revision.
  useEffect(() => {
    if (!contentRevision || loadedIdentityRef.current === identity) return
    loadedIdentityRef.current = identity
    setSessionLoaded(false)
    setLoadedIdentity(null)
    setContextReady(true)
    setAcceptedRevision(undefined)
    setPaused(false)
    setError(null)
    setStreamingText('')
    setInput('')

    const saved = readStorySetupSession(window.localStorage, storyId, sessionScope)
    if (saved) {
      setMessages(saved.messages)
      setChecklist(normalizeChecklist(saved.checklist))
      setDraftFragments(saved.draftFragments)
      setOptions(saved.options ?? [])
      setAcceptedRevision(saved.contentRevision ?? contentRevision)
    } else {
      setMessages([])
      setChecklist(INITIAL_CHECKLIST)
      setDraftFragments([])
      setOptions([])
    }
    setLoadedIdentity(identity)
    setSessionLoaded(true)
  }, [contentRevision, identity, sessionScope, storyId])

  // A story/timeline change or full route unmount is a real lifecycle boundary.
  // Merely hiding the Story Setup surface is intentionally not one.
  useEffect(() => () => {
    lifecycleRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadedIdentityRef.current = null
  }, [identity])

  // Resume one turn when the surface becomes active only if a user message is pending.
  useEffect(() => {
    if (!active || !sessionLoaded || loadedIdentity !== identity || !contentRevision || isStreaming || paused || abortRef.current) return
    if (messages.at(-1)?.role === 'user') {
      void requestAssistant(messages, 'continue')
    }
  }, [active, contentRevision, identity, isStreaming, loadedIdentity, messages, paused, requestAssistant, sessionLoaded])

  useEffect(() => {
    if (!sessionLoaded || loadedIdentity !== identity || !contextReady || !acceptedRevision) return
    writeStorySetupSession(window.localStorage, storyId, sessionScope, {
      contentRevision: acceptedRevision,
      messages,
      checklist,
      draftFragments,
      options,
    })
  }, [acceptedRevision, checklist, contextReady, draftFragments, identity, loadedIdentity, messages, options, sessionLoaded, sessionScope, storyId])

  const send = useCallback((content: string) => {
    const trimmed = content.trim()
    if (!trimmed || isStreaming || !contextReady || abortRef.current) return
    setOptions([])
    const history: StorySetupMessage[] = [...messages, { role: 'user', content: trimmed }]
    setMessages(history)
    setInput('')
    void requestAssistant(history, 'continue')
  }, [contextReady, isStreaming, messages, requestAssistant])

  const assess = useCallback(() => {
    if (isStreaming || abortRef.current) return
    setOptions([])
    void requestAssistant(messages, 'assess')
  }, [isStreaming, messages, requestAssistant])

  const stop = useCallback(() => {
    if (!abortRef.current) return
    setPaused(true)
    abortRef.current.abort()
  }, [])

  const retry = useCallback(() => {
    if (abortRef.current) return
    setPaused(false)
    void requestAssistant(messages, retryModeRef.current)
  }, [messages, requestAssistant])

  return {
    messages,
    input,
    setInput,
    streamingText,
    isStreaming,
    error,
    checklist,
    draftFragments,
    options,
    sessionLoaded,
    contextReady,
    send,
    assess,
    stop,
    retry,
  }
}
