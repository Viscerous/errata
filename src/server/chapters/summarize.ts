import { getFragment, updateFragment } from '../fragments/storage'
import { getProseChain } from '../fragments/prose-chain'
import { createLogger } from '../logging'
import { createStreamingRunner, type StreamingRunOptions } from '../agents/create-streaming-runner'

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

interface ChapterSummarySource {
  proseContent: string[]
}

async function loadChapterSummarySource(
  dataDir: string,
  storyId: string,
  fragmentId: string,
): Promise<ChapterSummarySource> {
  const marker = await getFragment(dataDir, storyId, fragmentId)
  if (!marker || marker.type !== 'marker') throw new Error('Chapter marker not found')

  const chain = await getProseChain(dataDir, storyId)
  if (!chain) throw new Error('No prose chain found')

  const markerIndex = chain.entries.findIndex(entry => entry.active === fragmentId)
  if (markerIndex === -1) throw new Error('Marker not found in prose chain')

  const proseContent: string[] = []
  for (let index = markerIndex + 1; index < chain.entries.length; index++) {
    const fragment = await getFragment(dataDir, storyId, chain.entries[index].active)
    if (!fragment) continue
    if (fragment.type === 'marker') break
    proseContent.push(fragment.content)
  }

  if (proseContent.length === 0) {
    throw new Error('No prose content in this chapter to summarize')
  }
  return { proseContent }
}

const runChapterSummary = createStreamingRunner<ChapterSummarizeInput, ChapterSummarySource>({
  name: 'chapters.summarize',
  maxSteps: 1,
  toolChoice: 'none',
  buildContext: false,
  readOnly: 'none',
  validate: async ({ dataDir, storyId, opts }) => {
    return loadChapterSummarySource(dataDir, storyId, opts.fragmentId)
  },
  messages: ({ validated }) => [{
    role: 'user',
    content: `Summarize this chapter:\n\n${validated.proseContent.join('\n\n')}`,
  }],
})

export async function summarizeChapter(
  dataDir: string,
  storyId: string,
  input: ChapterSummarizeInput,
  execution?: StreamingRunOptions,
): Promise<ChapterSummarizeResult> {
  const requestLogger = logger.child({ storyId })
  const startTime = Date.now()
  const result = await runChapterSummary(dataDir, storyId, input, execution)
  const completion = await result.completion
  const durationMs = Date.now() - startTime
  const summary = completion.text.trim()
  const trace: StreamEvent[] = [
    ...(completion.reasoning ? [{ type: 'reasoning-delta', text: completion.reasoning }] : []),
    ...(completion.text ? [{ type: 'text-delta', text: completion.text }] : []),
    { type: 'finish', finishReason: completion.finishReason, stepCount: completion.stepCount },
  ]

  requestLogger.info('Summary generated', {
    summaryLength: summary.length,
    reasoningLength: completion.reasoning.length,
    modelId: completion.modelId,
    durationMs,
    stepCount: completion.stepCount,
    finishReason: completion.finishReason,
  })

  const old = await getFragment(dataDir, storyId, input.fragmentId)
  if (!old) {
    requestLogger.error('Marker fragment disappeared during summarization')
    return {
      summary,
      reasoning: completion.reasoning,
      modelId: completion.modelId,
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
    content: summary,
  })

  return {
    summary,
    reasoning: completion.reasoning,
    modelId: completion.modelId,
    durationMs,
    trace,
  }
}
