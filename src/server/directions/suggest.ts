import { ToolLoopAgent, stepCountIs } from 'ai'
import { z } from 'zod/v4'
import { getModel, buildProviderOptions } from '../llm/client'
import { getStory, getFragment } from '../fragments/storage'
import { buildContextState } from '../llm/context-builder'
import { compileAgentContext } from '../agents/compile-agent-context'
import { getFragmentsByTag } from '../fragments/associations'
import { instructionRegistry } from '../instructions'
import { reportUsage } from '../llm/token-tracker'
import { normalizeTokenUsage } from '../llm/usage-normalizer'
import { createLogger } from '../logging'
import { type AgentBlockContext, baseBlockContext } from '../agents/agent-block-context'
import { loadSystemPromptFragments } from '../agents/block-helpers'

const logger = createLogger('directions-suggest')

export const DEFAULT_SUGGEST_PROMPT = `Based on everything in the story so far, suggest exactly {{count}} possible directions the story could go next. Return ONLY a JSON array with no other text. Each element must have:
- "title": a short evocative title (3-6 words)
- "description": 1-2 sentences describing this direction
- "instruction": a detailed writing prompt (2-3 sentences) that could be given to a writer to produce this continuation

Consider a mix of: advancing the main plot, exploring character relationships, introducing tension or conflict, quiet character moments, and unexpected developments. Make each suggestion meaningfully different from the others.

Respond with ONLY the JSON array, no markdown fences or other text.`

export interface SuggestDirectionsInput {
  count?: number
}

export interface SuggestionDirection {
  title: string
  description: string
  instruction: string
}

export interface SuggestDirectionsResult {
  suggestions: SuggestionDirection[]
  modelId: string
  durationMs: number
}

const suggestionDirectionSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
})

export function parseSuggestionDirectionsResponse(text: string, count: number): SuggestionDirection[] {
  const jsonStr = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch (error) {
    throw new Error(`Model response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const validation = z.array(suggestionDirectionSchema).length(count).safeParse(parsed)
  if (!validation.success) {
    throw new Error(`Model response must be a JSON array of exactly ${count} directions with title, description, and instruction`)
  }
  return validation.data
}

export async function suggestDirections(
  dataDir: string,
  storyId: string,
  input: SuggestDirectionsInput,
): Promise<SuggestDirectionsResult> {
  const requestLogger = logger.child({ storyId })
  const count = input.count ?? 4

  // Load story to get custom prompt if configured
  const story = await getStory(dataDir, storyId)

  const { model, modelId, temperature } = await getModel(dataDir, storyId, { role: 'directions.suggest' })

  const resolvedTemplate = instructionRegistry.resolve('directions.suggest-template', modelId)
  const promptTemplate = story?.settings.guidedSuggestPrompt || resolvedTemplate
  const prompt = promptTemplate.replace(/\{\{count\}\}/g, String(count))

  // Build context through the directions agent block system
  const ctxState = await buildContextState(dataDir, storyId, '')

  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)

  const blockContext: AgentBlockContext = {
    ...baseBlockContext(ctxState, ctxState.story),
    systemPromptFragments,
    modelId,
  }

  const compiled = await compileAgentContext(dataDir, storyId, 'directions.suggest', blockContext, {})
  const systemMsg = compiled.messages.find(m => m.role === 'system')
  const userMessages = compiled.messages.filter(m => m.role !== 'system')

  requestLogger.info('Generating suggestions', { modelId, count })

  const providerOptions = buildProviderOptions(story?.settings.disableThinking ?? false)
  const agent = new ToolLoopAgent({
    model,
    instructions: systemMsg?.content || instructionRegistry.resolve('directions.system', modelId),
    tools: {},
    toolChoice: 'none' as const,
    stopWhen: stepCountIs(1),
    temperature,
    providerOptions,
  })

  const startTime = Date.now()
  let fullText = ''

  const result = await agent.stream({
    messages: [
      ...userMessages,
      { role: 'user' as const, content: prompt },
    ],
  })

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      fullText += (part as Record<string, unknown>).text ?? ''
    }
  }

  // Track token usage
  try {
    const rawUsage = await result.totalUsage
    const usage = normalizeTokenUsage(rawUsage)
    if (usage) {
      reportUsage(dataDir, storyId, 'directions.suggest', usage, modelId)
    }
  } catch {
    // Some providers may not report usage
  }

  const durationMs = Date.now() - startTime

  // Parse the JSON array from the response
  const suggestions = parseSuggestionDirectionsResponse(fullText, count)

  requestLogger.info('Suggestions generated', { count: suggestions.length, durationMs })

  return { suggestions, modelId, durationMs }
}
