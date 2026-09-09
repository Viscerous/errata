import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, BookOpen, Bookmark, MessageSquare, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { qk, useActiveBranchId } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LibrarianChat } from '@/components/librarian/LibrarianChat'
import { LibrarianConversationList } from '@/components/librarian/LibrarianConversationList'
import { LibrarianMemoryView } from '@/components/librarian/LibrarianMemoryView'
import { LibrarianStoryView } from '@/components/librarian/LibrarianStoryView'

export { threadContinuityRows } from '@/components/librarian/LibrarianAnalysisCard'

interface LibrarianPanelProps {
  storyId: string
  askFragmentId?: string | null
  askPrefill?: string | null
  onAskFragmentConsumed?: () => void
}

type LibrarianTab = 'chat' | 'story' | 'summaries'

function tabStorageKey(storyId: string): string {
  return `errata.librarian.activeTab.${storyId}`
}

function readSavedTab(storyId: string): LibrarianTab {
  if (typeof window === 'undefined') return 'chat'
  const saved = window.localStorage.getItem(tabStorageKey(storyId))
  return saved === 'story' || saved === 'summaries' ? saved : 'chat'
}

export function LibrarianPanel({ storyId, askFragmentId, askPrefill, onAskFragmentConsumed }: LibrarianPanelProps) {
  const [activeTab, setActiveTab] = useState<LibrarianTab>(() => readSavedTab(storyId))
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [chatInitialInput, setChatInitialInput] = useState('')
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const conversationQueryKey = qk.librarianConversations(storyId, branchId)

  const { data: conversations = [] } = useQuery({
    queryKey: conversationQueryKey,
    queryFn: () => api.librarian.listConversations(storyId),
  })
  const { data: status } = useQuery({
    queryKey: qk.librarianStatus(storyId, branchId),
    queryFn: () => api.librarian.getStatus(storyId),
    refetchInterval: 5000,
  })
  const createConversation = useMutation({
    mutationFn: (title?: string) => api.librarian.createConversation(storyId, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationQueryKey }),
  })
  const deleteConversation = useMutation({
    mutationFn: (conversationId: string) => api.librarian.deleteConversation(storyId, conversationId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationQueryKey }),
  })

  useEffect(() => {
    setActiveTab(readSavedTab(storyId))
    setActiveConversationId(null)
    setChatInitialInput('')
  }, [storyId])

  useEffect(() => {
    window.localStorage.setItem(tabStorageKey(storyId), activeTab)
  }, [activeTab, storyId])

  useEffect(() => {
    if (!askFragmentId) return
    setActiveTab('chat')
    createConversation.mutate(undefined, {
      onSuccess: conversation => {
        setActiveConversationId(conversation.id)
        setChatInitialInput(askPrefill ?? `@${askFragmentId} `)
      },
    })
    onAskFragmentConsumed?.()
  }, [askFragmentId, askPrefill, onAskFragmentConsumed])

  const openNewConversation = async (initialInput = '') => {
    const conversation = await createConversation.mutateAsync(undefined)
    setActiveConversationId(conversation.id)
    setChatInitialInput(initialInput)
    setActiveTab('chat')
  }

  return (
    <Tabs value={activeTab} onValueChange={value => setActiveTab(value as LibrarianTab)} className="flex h-full flex-col gap-0" data-component-id="librarian-panel-root">
      <div className="shrink-0 px-4 pt-3">
        <TabsList variant="line" className="relative z-20 h-8 w-full gap-0">
          <TabsTrigger value="chat" className="flex-1 gap-1.5 px-1 text-ui-label" data-component-id="librarian-tab-chat"><MessageSquare />Chat</TabsTrigger>
          <TabsTrigger value="story" className="flex-1 gap-1.5 px-1 text-ui-label" data-component-id="librarian-tab-story"><BookOpen />Story</TabsTrigger>
          <TabsTrigger value="summaries" className="flex-1 gap-1.5 px-1 text-ui-label" data-component-id="librarian-tab-summaries"><Bookmark />Memory</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="chat" className="mt-0 min-h-0 flex-1">
        {activeConversationId ? (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border/20 px-3 py-1.5">
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => { setActiveConversationId(null); setChatInitialInput('') }} title="Back to conversations"><ArrowLeft /></Button>
              <span className="min-w-0 flex-1 truncate text-ui-label text-muted-foreground">{conversations.find(conversation => conversation.id === activeConversationId)?.title ?? 'Chat'}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => deleteConversation.mutate(activeConversationId, { onSuccess: () => setActiveConversationId(null) })}
                title="Delete conversation"
              ><Trash2 /></Button>
            </div>
            <div className="min-h-0 flex-1"><LibrarianChat storyId={storyId} conversationId={activeConversationId} initialInput={chatInitialInput} /></div>
          </div>
        ) : (
          <LibrarianConversationList
            conversations={conversations}
            onSelect={id => { setActiveConversationId(id); setChatInitialInput('') }}
            onNew={() => void openNewConversation()}
            onDelete={id => deleteConversation.mutate(id)}
          />
        )}
      </TabsContent>

      <TabsContent value="story" className="mt-0 min-h-0 flex-1">
        <LibrarianStoryView storyId={storyId} status={status} onOpenChat={message => void openNewConversation(message)} />
      </TabsContent>
      <TabsContent value="summaries" className="mt-0 min-h-0 flex-1">
        <LibrarianMemoryView storyId={storyId} />
      </TabsContent>
    </Tabs>
  )
}
