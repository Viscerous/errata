import { Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** The two composer scales in use: the sidebar panel and the full-width view. */
const SIZES = {
  sm: { button: 'size-8', send: 'size-3.5', stop: 'size-3' },
  md: { button: 'size-9', send: 'size-4', stop: 'size-3.5' },
} as const

interface ChatSendButtonProps {
  isStreaming: boolean
  /** Whether there is something to send. Ignored while streaming. */
  canSend: boolean
  onSend: () => void
  onStop: () => void
  /** Names what is being stopped, e.g. "Stop the librarian". */
  stopLabel: string
  /** Prefix for the send/stop `data-component-id`s. */
  idPrefix: string
  size?: keyof typeof SIZES
}

/**
 * One control with two states, so a composer cannot offer Send and Stop at once
 * — or lose the Stop affordance on one surface when the other gains it.
 */
export function ChatSendButton({
  isStreaming,
  canSend,
  onSend,
  onStop,
  stopLabel,
  idPrefix,
  size = 'sm',
}: ChatSendButtonProps) {
  const scale = SIZES[size]

  if (isStreaming) {
    return (
      <Button
        size="icon"
        variant="outline"
        className={`${scale.button} shrink-0`}
        onClick={onStop}
        aria-label={stopLabel}
        data-component-id={`${idPrefix}-stop`}
      >
        <Square className={`${scale.stop} fill-current`} aria-hidden />
      </Button>
    )
  }

  return (
    <Button
      size="icon"
      className={`${scale.button} shrink-0`}
      disabled={!canSend}
      onClick={onSend}
      aria-label="Send message"
      data-component-id={`${idPrefix}-send`}
    >
      <Send className={scale.send} aria-hidden />
    </Button>
  )
}
