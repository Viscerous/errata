import { useMemo } from 'react'
import { MessageSquare, Plus, Trash2 } from 'lucide-react'
import type { ConversationMeta } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EmptyState } from '@/components/ui/async-view'

interface LibrarianConversationListProps {
  conversations: ConversationMeta[]
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export function LibrarianConversationList({ conversations, onSelect, onNew, onDelete }: LibrarianConversationListProps) {
  const sorted = useMemo(
    () => [...conversations].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [conversations],
  )

  return (
    <div className="flex h-full flex-col" data-component-id="librarian-conversations">
      <div className="shrink-0 px-3 py-2">
        <Button type="button" size="sm" variant="outline" className="h-8 w-full text-ui-label" onClick={onNew}>
          <Plus />
          New chat
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-3 pb-3">
          {sorted.length === 0 && (
            <EmptyState icon={<MessageSquare className="size-5" />} title="No conversations yet" hint="Start a new chat to ask the librarian about your story." />
          )}
          {sorted.map(conversation => (
            <div key={conversation.id} className="group flex w-full items-start gap-2 rounded-md px-2.5 py-2 transition-colors hover:bg-muted/50">
              <button type="button" onClick={() => onSelect(conversation.id)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                <MessageSquare className="mt-0.5 size-3 shrink-0 text-muted-foreground/50" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-label leading-tight text-foreground/80">{conversation.title}</span>
                  <span className="mt-0.5 block text-ui-label text-muted-foreground/60">{formatRelativeTime(new Date(conversation.updatedAt))}</span>
                </span>
              </button>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => onDelete(conversation.id)} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" title="Delete conversation">
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function formatRelativeTime(date: Date): string {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
