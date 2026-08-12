import type { AgentStreamEvent, AgentStreamCompletion, AgentStreamResult } from './stream-types'
import { drainAgentStream } from './drain-agent-stream'

/**
 * Converts an AI SDK v6 fullStream into an NDJSON event stream + completion promise.
 * Handles: text-delta, reasoning-delta, tool-call, tool-result, finish-step, finish.
 *
 * @param onCancel - invoked when the returned stream is cancelled (client
 *   disconnect). Wire this to an AbortController so the underlying LLM call
 *   stops instead of running to completion against a dead consumer.
 * @param abortSignal - identifies an explicit server-side stop. Unlike a
 *   disconnected consumer, an attached client can receive a final stopped
 *   event and distinguish cancellation from successful completion.
 */
export function createEventStream(
  fullStream: AsyncIterable<unknown>,
  onCancel?: () => void,
  abortSignal?: AbortSignal,
): AgentStreamResult {
  let completionResolve: (val: AgentStreamCompletion) => void
  let completionReject: (err: unknown) => void
  const completion = new Promise<AgentStreamCompletion>((resolve, reject) => {
    completionResolve = resolve
    completionReject = reject
  })
  let consumerCancelled = false

  const eventStream = new ReadableStream<string>({
    start(controller) {
      // Do not return the drain promise from start(): the Streams API waits for
      // it before invoking cancel(), which can deadlock a provider stalled in
      // iterator.next(). Cancellation must be able to abort that pending read.
      void (async () => {
        try {
          const drained = await drainAgentStream(fullStream, (event) => {
            controller.enqueue(JSON.stringify(event) + '\n')
          }, { abortSignal })

          // Emit final finish event
          const finishEvent: AgentStreamEvent = {
            type: 'finish',
            finishReason: drained.finishReason,
            stepCount: drained.stepCount,
          }
          controller.enqueue(JSON.stringify(finishEvent) + '\n')
          controller.close()

          completionResolve!({
            text: drained.fullText,
            reasoning: drained.fullReasoning,
            toolCalls: drained.toolCalls,
            toolErrors: drained.toolErrors,
            stepCount: drained.stepCount,
            finishReason: drained.finishReason,
            servedModelId: drained.servedModelId,
          })
        } catch (err) {
          if (abortSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
            if (!consumerCancelled) {
              const finishEvent: AgentStreamEvent = {
                type: 'finish',
                finishReason: 'stop',
                stepCount: 0,
                stopped: true,
              }
              controller.enqueue(JSON.stringify(finishEvent) + '\n')
              controller.close()
            }
          } else if (!consumerCancelled) {
            controller.error(err)
          }
          completionReject!(err)
        }
      })()
    },
    cancel() {
      // Consumer (HTTP client) went away — stop the underlying LLM call.
      consumerCancelled = true
      onCancel?.()
    },
  })

  return { eventStream, completion }
}
