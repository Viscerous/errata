import type { ChatEvent } from '@/lib/api'

interface EventStreamOptions {
  /**
   * What the stream does once its script runs out. `close` ends it cleanly —
   * which is also what a server does for a run it tore down on request, so it
   * is the shape that catches a client treating termination as success.
   * `hang` leaves the run in flight until `signal` aborts.
   */
  onExhausted?: 'close' | 'hang'
  /** Ends the stream with an AbortError, the way a cancelled fetch does. */
  signal?: AbortSignal
  /** Models either transport abort or the server's explicit stopped finish. */
  onAbort?: 'error' | 'finish'
}

/**
 * A `ReadableStream<ChatEvent>` that emits `events` in order. Pending reads
 * settle on abort rather than being left unresolved: the suite shares one fork,
 * so a promise that never settles outlives its test.
 */
export function eventStream(
  events: ChatEvent[],
  { onExhausted = 'close', signal, onAbort = 'error' }: EventStreamOptions = {},
): ReadableStream<ChatEvent> {
  const aborted = () => new DOMException('Aborted', 'AbortError')
  const stop = (controller: ReadableStreamDefaultController<ChatEvent>) => {
    if (onAbort === 'finish') {
      controller.enqueue({ type: 'finish', finishReason: 'stop', stepCount: 0, stopped: true })
      controller.close()
    } else {
      controller.error(aborted())
    }
  }
  let next = 0
  return new ReadableStream<ChatEvent>({
    pull(controller) {
      if (signal?.aborted) {
        stop(controller)
        return
      }
      if (next < events.length) {
        controller.enqueue(events[next++])
        return
      }
      if (onExhausted === 'close') {
        controller.close()
        return
      }
      return new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          if (onAbort === 'finish') {
            stop(controller)
            resolve()
          } else {
            reject(aborted())
          }
        }, { once: true })
      })
    },
  })
}
