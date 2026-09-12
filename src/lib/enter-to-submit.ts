import type { KeyboardEvent } from 'react'

/** Enter submits short instructions; Shift+Enter remains a newline. */
export function isEnterToSubmit(event: KeyboardEvent): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.nativeEvent.isComposing
}
