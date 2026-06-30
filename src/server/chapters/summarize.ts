import { ToolLoopAgent, stepCountIs } from 'ai'
import { resolveAgentRuntime } from '../llm/client'
import { getStory, getFragment, updateFragment } from '../fragments/storage'
import { getProseChain } from '../fragments/prose-chain'
import { instructionRegistry } from '../instructions'
import { createLogger } from '../logging'
import { drainAgentStream } from '../agents/drain-agent-stream'
import { resolveAndReportUsage } from '../llm/usage-normalizer'

const logger = createLogger('chapter-summarize')

export const CHAPTER_SUMMARIZE_SYSTEM_PROMPT = `You summarize chapters of an ongoing story.
Write a concise two-paragraph summary of the chapter's prose, capturing the key events, character actions, and mood.
Respond with only the summary text.`

export interface ChapterSummarizeInput {
  fragmentId: string
}

export interface StreamEvent {
  type: string
  [key: string]: unknown
}

export interface ChapterSummarizeResult {
  summary: string
  reasoning: string
  modelId: string
  durationMs: number
  trace: StreamEvent[]
}

export async function summarizeChapter(
  dataDir: string,
  storyId: string,
  input: ChapterSummarizeInput,
): Promise<ChapterSummarizeResult> {
  const requestLogger = logger.child({ storyId })

  const marker = await getFragment(dataDir, storyId, input.fragmentId)
  if (!marker || marker.type !== 'marker') {
    throw new Error('Chapter marker not found')
  }

  const chain = await getProseChain(dataDir, storyId)
  if (!chain) {
    throw new Error('No prose chain found')
  }

  const markerIndex = chain.entries.findIndex(e => e.active === input.fragmentId)
  if (markerIndex === -1) {
    throw new Error('Marker not found in prose chain')
  }

  // Collect prose content from marker to next marker/end
  const proseContent: string[] = []
  for (let i = markerIndex + 1; i < chain.entries.length; i++) {
    const entry = chain.entries[i]
    const fragment = await getFragment(dataDir, storyId, entry.active)
    if (!fragment) continue
    if (fragment.type === 'marker') break
    proseContent.push(fragment.content)
  }

  if (proseContent.length === 0) {
    throw new Error('No prose content in this chapter to summarize')
  }

  requestLogger.info('Summarizing chapter...', {
    fragmentId: input.fragmentId,
    proseFragments: proseContent.length,
  })

  const story = await getStory(dataDir, storyId)
  if (!story) throw new Error(`Story ${storyId} not found`)

  const { model, modelId, temperature, providerOptions, guards } = await resolveAgentRuntime(dataDir, storyId, 'librarian', story)
  requestLogger.info('Resolved model', { modelId })

  const agent = new ToolLoopAgent({
    model,
    instructions: instructionRegistry.resolve('chapters.summarize.system', modelId),
    tools: {},
    toolChoice: 'none' as const,
    stopWhen: stepCountIs(1),
    temperature,
    providerOptions,
    maxOutputTokens: guards.maxOutputTokens,
  })

  const startTime = Date.now()
  const trace: StreamEvent[] = []

  const result = await agent.stream({
    prompt: `Summarize this chapter:\n\n${proseContent.join('\n\n')}`,
  })

  // Adapt the normalized text/reasoning events back to this agent's own trace
  // naming (text-delta/reasoning-delta) — an existing, unconsumed output shape
  // kept as-is rather than migrated in the same pass that unified the loop.
  const drained = await drainAgentStream(result.fullStream, (event) => {
    if (event.type === 'text') trace.push({ type: 'text-delta', text: event.text })
    else if (event.type === 'reasoning') trace.push({ type: 'reasoning-delta', text: event.text })
  })
  const { fullText, fullReasoning, stepCount, finishReason: lastFinishReason } = drained
  trace.push({ type: 'finish', finishReason: lastFinishReason, stepCount })

  // Source is the agent's own name for per-agent attribution; 'librarian' is
  // only its model-resolution role.
  await resolveAndReportUsage(dataDir, storyId, 'chapters.summarize', result.totalUsage, modelId)

  const durationMs = Date.now() - startTime
  const summary = fullText.trim()

  requestLogger.info('Summary generated', {
    summaryLength: summary.length,
    reasoningLength: fullReasoning.length,
    modelId,
    durationMs,
    stepCount,
    finishReason: lastFinishReason,
  })

  let old = await getFragment(dataDir, storyId, input.fragmentId)
  if (!old) {
    requestLogger.error('Marker fragment disappeared during summarization')
    return {
      summary,
      reasoning: fullReasoning,
      modelId,
      durationMs,
      trace,
    }
  }

  requestLogger.info('Saving summary to marker content', { fragmentId: input.fragmentId,
    dataDir, storyId,
    summaryLength: summary.length })
  // Save as marker content
  await updateFragment(dataDir, storyId, {
    ...old,
    name: marker.name,
    description: marker.description,
    content: summary,
  })

  return {
    summary,
    reasoning: fullReasoning,
    modelId,
    durationMs,
    trace,
  }
}
