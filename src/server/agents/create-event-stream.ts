import type { AgentStreamEvent, AgentStreamCompletion, AgentStreamResult } from './stream-types'
import { drainAgentStream } from './drain-agent-stream'

/**
 * Converts an AI SDK v6 fullStream into an NDJSON event stream + completion promise.
 * Handles: text-delta, reasoning-delta, tool-call, tool-result, finish-step, finish.
 *
 * @param onCancel - invoked when the returned stream is cancelled (client
 *   disconnect). Wire this to an AbortController so the underlying LLM call
 *   stops instead of running to completion against a dead consumer.
 */
export function createEventStream(
  fullStream: AsyncIterable<unknown>,
  onCancel?: () => void,
): AgentStreamResult {
  let completionResolve: (val: AgentStreamCompletion) => void
  let completionReject: (err: unknown) => void
  const completion = new Promise<AgentStreamCompletion>((resolve, reject) => {
    completionResolve = resolve
    completionReject = reject
  })

  const eventStream = new ReadableStream<string>({
    async start(controller) {
      try {
        const drained = await drainAgentStream(fullStream, (event) => {
          controller.enqueue(JSON.stringify(event) + '\n')
        })

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
        })
      } catch (err) {
        controller.error(err)
        completionReject!(err)
      }
    },
    cancel() {
      // Consumer (HTTP client) went away — stop the underlying LLM call.
      onCancel?.()
    },
  })

  return { eventStream, completion }
}
