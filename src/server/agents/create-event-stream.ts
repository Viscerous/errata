import type { AgentStreamEvent, AgentStreamCompletion, AgentStreamResult } from './stream-types'

/**
 * Converts an AI SDK v6 fullStream into an NDJSON event stream + completion promise.
 * Handles: text-delta, reasoning-delta, tool-call, tool-result, finish.
 */
export function createEventStream(fullStream: AsyncIterable<unknown>): AgentStreamResult {
  let completionResolve: (val: AgentStreamCompletion) => void
  let completionReject: (err: unknown) => void
  const completion = new Promise<AgentStreamCompletion>((resolve, reject) => {
    completionResolve = resolve
    completionReject = reject
  })

  let fullText = ''
  let fullReasoning = ''
  const toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }> = []
  // Args arrive on tool-call, the result later on tool-result; stash by id to
  // keep args in the persisted record.
  const pendingArgs = new Map<string, Record<string, unknown>>()
  let lastFinishReason = 'unknown'
  let stepCount = 0

  const eventStream = new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const part of fullStream) {
          let event: AgentStreamEvent | null = null
          const p = part as Record<string, unknown>
          const type = (p as { type?: string }).type

          switch (type) {
            case 'text-delta': {
              const text = (p.text ?? '') as string
              fullText += text
              event = { type: 'text', text }
              break
            }
            case 'reasoning-delta': {
              const text = (p.text ?? '') as string
              fullReasoning += text
              event = { type: 'reasoning', text }
              break
            }
            case 'tool-call': {
              const input = (p.input ?? {}) as Record<string, unknown>
              pendingArgs.set(p.toolCallId as string, input)
              event = {
                type: 'tool-call',
                id: p.toolCallId as string,
                toolName: p.toolName as string,
                args: input,
              }
              break
            }
            case 'tool-result': {
              const toolCallId = p.toolCallId as string
              const toolName = (p.toolName as string) ?? ''
              toolCalls.push({ toolName, args: pendingArgs.get(toolCallId) ?? {}, result: p.output })
              event = {
                type: 'tool-result',
                id: toolCallId,
                toolName,
                result: p.output,
              }
              break
            }
            case 'finish':
              lastFinishReason = (p.finishReason as string) ?? 'unknown'
              stepCount++
              break
          }

          if (event) {
            controller.enqueue(JSON.stringify(event) + '\n')
          }
        }

        // Emit final finish event
        const finishEvent: AgentStreamEvent = {
          type: 'finish',
          finishReason: lastFinishReason,
          stepCount,
        }
        controller.enqueue(JSON.stringify(finishEvent) + '\n')
        controller.close()

        completionResolve!({
          text: fullText,
          reasoning: fullReasoning,
          toolCalls,
          stepCount,
          finishReason: lastFinishReason,
        })
      } catch (err) {
        controller.error(err)
        completionReject!(err)
      }
    },
  })

  return { eventStream, completion }
}
