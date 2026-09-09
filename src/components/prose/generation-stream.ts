import type { ChatEvent, ClarifyQuestion, SuggestionDirection } from '@/lib/api/types'

export type ThoughtStep =
  | { type: 'reasoning'; text: string }
  | { type: 'prewriter-text'; text: string }
  | { type: 'tool-call'; id: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; toolName: string; result: unknown }
  | { type: 'tool-error'; id: string; toolName: string; error: string }
  | { type: 'phase'; phase: string }

export interface GenerationStreamSnapshot {
  text: string
  thoughts: ThoughtStep[]
}

export interface GenerationStreamResult extends GenerationStreamSnapshot {
  directions: SuggestionDirection[] | null
  questions: ClarifyQuestion[] | null
  rejectionReason: string | null
  stopped: boolean
}

/**
 * Read the generation event protocol once for every prose surface. UI callers
 * decide how raw text is composed and rendered; this reader owns event folding
 * and frame-rate-limited progress delivery.
 */
export async function consumeGenerationStream(
  stream: ReadableStream<ChatEvent>,
  onProgress?: (snapshot: GenerationStreamSnapshot) => void,
): Promise<GenerationStreamResult> {
  const reader = stream.getReader()
  const thoughts: ThoughtStep[] = []
  let text = ''
  let reasoning = ''
  let directions: SuggestionDirection[] | null = null
  let questions: ClarifyQuestion[] | null = null
  let rejectionReason: string | null = null
  let stopped = false
  let framePending = false

  const snapshot = (): GenerationStreamSnapshot => ({ text, thoughts: [...thoughts] })
  const scheduleProgress = () => {
    if (!onProgress || framePending) return
    framePending = true
    const emit = () => {
      framePending = false
      onProgress(snapshot())
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(emit)
    else queueMicrotask(emit)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    switch (value.type) {
      case 'text':
        text += value.text
        scheduleProgress()
        break
      case 'reasoning': {
        reasoning += value.text
        const last = thoughts.at(-1)
        if (last?.type === 'reasoning') last.text = reasoning
        else thoughts.push({ type: 'reasoning', text: reasoning })
        scheduleProgress()
        break
      }
      case 'tool-call':
        reasoning = ''
        thoughts.push({ type: 'tool-call', id: value.id, toolName: value.toolName, args: value.args })
        scheduleProgress()
        break
      case 'tool-result':
        thoughts.push({ type: 'tool-result', id: value.id, toolName: value.toolName, result: value.result })
        scheduleProgress()
        break
      case 'tool-error':
        thoughts.push({ type: 'tool-error', id: value.id, toolName: value.toolName, error: value.error })
        scheduleProgress()
        break
      case 'prewriter-text': {
        const last = thoughts.at(-1)
        if (last?.type === 'prewriter-text') last.text += value.text
        else {
          reasoning = ''
          thoughts.push({ type: 'prewriter-text', text: value.text })
        }
        scheduleProgress()
        break
      }
      case 'prewriter-reset': {
        const last = thoughts.at(-1)
        if (last?.type === 'prewriter-text') last.text = ''
        scheduleProgress()
        break
      }
      case 'prewriter-directions':
        directions = value.directions
        break
      case 'clarify-questions':
        questions = value.questions
        break
      case 'generation-rejected':
        rejectionReason = value.reason
        break
      case 'finish':
        stopped = value.stopped === true
        break
      case 'phase':
        reasoning = ''
        thoughts.push({ type: 'phase', phase: value.phase })
        scheduleProgress()
        break
      case 'analysis-progress':
        break
    }
  }

  const finalSnapshot = snapshot()
  onProgress?.(finalSnapshot)
  return { ...finalSnapshot, directions, questions, rejectionReason, stopped }
}
