import { BookOpen, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type StoryChatView = 'prose' | 'character-chat'

export function StoryChatSwitcher({ value, onChange, compact = false, fill = false }: {
  value: StoryChatView
  onChange: (view: StoryChatView) => void
  compact?: boolean
  fill?: boolean
}) {
  return (
    <div
      role="group"
      aria-label="Main view"
      className={`flex shrink-0 items-center gap-0.5 rounded-lg border border-border/50 bg-elevated/90 p-0.5 shadow-sm backdrop-blur-md ${fill ? 'flex-1' : ''}`}
      data-component-id="story-chat-switcher"
    >
      <Button
        type="button"
        variant={value === 'prose' ? 'secondary' : 'ghost'}
        size={compact ? 'icon' : 'sm'}
        className={compact ? 'size-7' : `h-7 gap-1.5 px-2 text-xs ${fill ? 'flex-1' : ''}`}
        aria-label="Story view"
        aria-pressed={value === 'prose'}
        onClick={() => onChange('prose')}
      >
        <BookOpen className="size-3.5" />
        {!compact && <span className="hidden sm:inline">Story</span>}
      </Button>
      <Button
        type="button"
        variant={value === 'character-chat' ? 'secondary' : 'ghost'}
        size={compact ? 'icon' : 'sm'}
        className={compact ? 'size-7' : `h-7 gap-1.5 px-2 text-xs ${fill ? 'flex-1' : ''}`}
        aria-label="Character chat view"
        aria-pressed={value === 'character-chat'}
        onClick={() => onChange('character-chat')}
      >
        <MessageSquare className="size-3.5" />
        {!compact && <span className="hidden sm:inline">Chat</span>}
      </Button>
    </div>
  )
}
