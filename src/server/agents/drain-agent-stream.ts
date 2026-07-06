import type { AgentStreamEvent } from './stream-types'

export interface DrainedAgentStream {
  fullText: string
  fullReasoning: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>
  stepCount: number
  finishReason: string
}

export interface DrainAgentStreamOptions {
  abortSignal?: AbortSignal
  /**
   * Maximum time to wait for the next SDK stream part. This catches provider
   * connections that have stopped producing data but have not closed cleanly.
   */
  idleTimeoutMs?: number
  onIdleTimeout?: () => void
}

function abortError(): Error {
  const error = new Error('Agent stream aborted')
  error.name = 'AbortError'
  return error
}

function idleTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Agent stream idle timeout after ${timeoutMs}ms`)
  error.name = 'TimeoutError'
  return error
}

function guardedNext(
  iterator: AsyncIterator<unknown>,
  options: DrainAgentStreamOptions,
): Promise<IteratorResult<unknown>> {
  if (options.abortSignal?.aborted) return Promise.reject(abortError())

  const idleTimeoutMs = options.idleTimeoutMs ?? 0
  if (!options.abortSignal && idleTimeoutMs <= 0) return iterator.next()

  return new Promise((resolve, reject) => {
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer)
      options.abortSignal?.removeEventListener('abort', onAbort)
    }
    const resolveOnce = (value: IteratorResult<unknown>) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => rejectOnce(abortError())

    options.abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        options.onIdleTimeout?.()
        rejectOnce(idleTimeoutError(idleTimeoutMs))
      }, idleTimeoutMs)
    }

    iterator.next().then(
      (next) => resolveOnce(next),
      (error) => rejectOnce(error),
    )
  })
}

/**
 * Drains an AI SDK v6 `fullStream`, translating each part into an
 * `AgentStreamEvent` and accumulating the text/reasoning/tool-calls/step-count/
 * finish-reason every agent needs — the one place that owns the fullStream ↔
 * AgentStreamEvent translation, so five call sites can't quietly drift from
 * each other on what a `tool-result` or `finish-step` means.
 *
 * Callers choose the sink via `onEvent`: enqueue to a `ReadableStream`
 * controller (HTTP streaming), push onto an activity trace, both at once, or
 * omit it entirely for a single-shot caller that only wants the final result
 * (directions, chapter summarize).
 *
 * Does not synthesize a trailing `finish` event itself — callers that want one
 * emit it from the returned result, since some attach extra fields (`stopped`,
 * etc.) this core has no business knowing about.
 */
export async function drainAgentStream(
  fullStream: AsyncIterable<unknown>,
  onEvent?: (event: AgentStreamEvent) => void,
  options: DrainAgentStreamOptions = {},
): Promise<DrainedAgentStream> {
  let fullText = ''
  let fullReasoning = ''
  const toolCalls: DrainedAgentStream['toolCalls'] = []
  // Correlate a tool-result back to the args from its tool-call event.
  const toolCallArgsById = new Map<string, Record<string, unknown>>()
  let stepCount = 0
  let finishReason = 'unknown'
  const iterator = fullStream[Symbol.asyncIterator]()
  let completed = false

  try {
    for (;;) {
      const next = await guardedNext(iterator, options)
      if (next.done) {
        completed = true
        break
      }
      const p = next.value as Record<string, unknown>
      let event: AgentStreamEvent | null = null

      switch (p.type) {
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
          const toolCallId = p.toolCallId as string
          toolCallArgsById.set(toolCallId, input)
          event = { type: 'tool-call', id: toolCallId, toolName: p.toolName as string, args: input }
          break
        }
        case 'tool-result': {
          const toolCallId = p.toolCallId as string
          const toolName = (p.toolName as string) ?? ''
          toolCalls.push({ toolName, args: toolCallArgsById.get(toolCallId) ?? {}, result: p.output })
          event = { type: 'tool-result', id: toolCallId, toolName, result: p.output }
          break
        }
        // `finish-step` fires once per LLM step; `finish` fires once for the
        // whole generation. Count steps, capture the final reason.
        case 'finish-step':
          stepCount++
          break
        case 'finish':
          finishReason = (p.finishReason as string) ?? 'unknown'
          break
      }

      if (event) onEvent?.(event)
    }
  } finally {
    if (!completed) {
      const cleanup = iterator.return?.()
      void cleanup?.catch(() => {})
    }
  }

  return { fullText, fullReasoning, toolCalls, stepCount, finishReason }
}
