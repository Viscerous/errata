import { z } from 'zod/v4'
import { instructionRegistry } from '../instructions'
import { createLogger } from '../logging'
import { createStreamingRunner, type StreamingRunOptions } from '../agents/create-streaming-runner'
import { suggestionDirectionSchema, type SuggestionDirection } from './schema'

export type { SuggestionDirection } from './schema'

const logger = createLogger('directions-suggest')

export const DEFAULT_SUGGEST_PROMPT = `Return exactly {{count}} meaningfully different directions as a raw JSON array. Each item must contain "title" (3-6 evocative words), "description" (1-2 sentences), and "instruction" (a concrete 2-3 sentence prompt for the prose writer). Vary the narrative purpose across plot, relationship, tension, quiet development, or surprise where the story supports it. Return no text outside the JSON array.`

export interface DirectionProposalInput {
  count?: number
}

export interface DirectionProposalResult {
  suggestions: SuggestionDirection[]
  modelId: string
  durationMs: number
  stepCount?: number
  finishReason?: string
}

export function parseSuggestionDirectionsResponse(text: string, count: number): SuggestionDirection[] {
  const jsonStr = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch (error) {
    throw new Error(`Model response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Small models miss "exactly N" by one; extra directions are sliced off
  // rather than failing the whole run. Too few is still an error.
  const validation = z.array(suggestionDirectionSchema).min(count).safeParse(parsed)
  if (!validation.success) {
    throw new Error(`Model response must be a JSON array of at least ${count} directions with title, description, and instruction`)
  }
  return validation.data.slice(0, count)
}

const runDirectionProposal = createStreamingRunner<DirectionProposalInput>({
  name: 'directions.suggest',
  maxSteps: 1,
  toolChoice: 'none',
  readOnly: 'none',
  messages: ({ compiled, opts, story }) => {
    const count = opts.count ?? 4
    const resolvedTemplate = instructionRegistry.resolve('directions.suggest-template')
    const promptTemplate = story.settings.guidedSuggestPrompt || resolvedTemplate
    const prompt = promptTemplate.replace(/\{\{count\}\}/g, String(count))
    const contextMessage = compiled.messages.find(message => message.role === 'user')
    return [
      ...(contextMessage ? [{ role: 'user' as const, content: contextMessage.content }] : []),
      { role: 'user' as const, content: prompt },
    ]
  },
})

export async function proposeDirections(
  dataDir: string,
  storyId: string,
  input: DirectionProposalInput,
  execution?: StreamingRunOptions,
): Promise<DirectionProposalResult> {
  const requestLogger = logger.child({ storyId })
  const count = input.count ?? 4
  const startTime = Date.now()
  const result = await runDirectionProposal(dataDir, storyId, input, execution)
  const completion = await result.completion
  const durationMs = Date.now() - startTime
  const suggestions = parseSuggestionDirectionsResponse(completion.text, count)

  requestLogger.info('Suggestions generated', { count: suggestions.length, durationMs })

  return {
    suggestions,
    modelId: completion.modelId,
    durationMs,
    stepCount: completion.stepCount,
    finishReason: completion.finishReason,
  }
}
