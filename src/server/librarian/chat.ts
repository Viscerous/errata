import { tool, ToolLoopAgent, stepCountIs, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { resolveAgentRuntime } from '../llm/client'
import { resolveAndReportUsage } from '../llm/usage-normalizer'
import { MISSING_SYSTEM_PROMPT_FALLBACK } from '../instructions'
import { getFragment, getStory } from '../fragments/storage'
import { buildContextState } from '../llm/context-builder'
import { createFragmentTools } from '../llm/tools'
import { pluginRegistry } from '../plugins/registry'
import { collectPluginTools } from '../plugins/tools'
import { createLogger } from '../logging'
import { createEventStream } from '../agents/create-event-stream'
import { holdLibrarianAnalysis } from './scheduler'
import { compileAgentContext } from '../agents/compile-agent-context'
import { createAgentInstance } from '../agents/agent-instance'
import { getFragmentsByTag } from '../fragments/associations'
import { inspectGenerationForFragment, type InspectAspect } from './inspect-generation'
import { runLibrarian } from './agent'
import { withBranch } from '../fragments/branches'
import type { ChatStreamEvent, ChatResult } from '../agents/stream-types'
import { type AgentBlockContext, baseBlockContext } from '../agents/agent-block-context'
import { loadSystemPromptFragments } from '../agents/block-helpers'

export type { ChatStreamEvent, ChatResult }

const logger = createLogger('librarian-chat')

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  maxSteps?: number
}

/**
 * Chat-only tools beyond the standard fragment tools. A factory so the chat
 * handler and the agent's `resolveTools` (for the preview) share one source —
 * no drift between what the model gets and what the preview shows.
 */
export function createLibrarianChatBespokeTools(dataDir: string, storyId: string): ToolSet {
  const log = logger.child({ storyId })

  const invokeAgent = tool({
    description: 'Invoke a specialized librarian agent for a focused task. Use this instead of hand-running a specialized workflow when analysis, refinement, or character optimization is requested.',
    inputSchema: z.object({
      agent: z.enum(['librarian.analyze', 'librarian.refine', 'librarian.optimize-character']),
      fragmentId: z.string().describe('The target fragment ID. analyze expects prose; optimize-character expects character; refine expects a non-prose fragment.'),
      instructions: z.string().optional().describe('Optional instructions for refine or optimize-character.'),
    }),
    execute: async (
      { agent, fragmentId, instructions }: { agent: 'librarian.analyze' | 'librarian.refine' | 'librarian.optimize-character'; fragmentId: string; instructions?: string },
      options?: { abortSignal?: AbortSignal },
    ) => {
      log.info('Invoking librarian agent via chat tool', { agent, fragmentId })
      try {
        if (agent === 'librarian.analyze') {
          const analysis = await runLibrarian(dataDir, storyId, fragmentId, { abortSignal: options?.abortSignal })
          return {
            ok: true,
            agent,
            analysisId: analysis.id,
            summary: analysis.summaryUpdate,
            mentionCount: analysis.mentions.length,
            contradictionCount: analysis.contradictions.length,
            suggestionCount: analysis.fragmentChangeProposals.length,
            timelineEventCount: analysis.timelineEvents.length,
          }
        }

        const instance = createAgentInstance(agent, { dataDir, storyId })
        const result = await instance.execute({ fragmentId, instructions })
        await result.completion
        return {
          ok: true,
          agent,
          fragmentId,
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  })

  const inspectRun = tool({
    description:
      "Inspect run/debug details behind a generated prose fragment: model, prompt/context, tools, token usage, reasoning, and prewriter brief. Use this to explain why a passage came out the way it did, or to trace a continuity issue.",
    inputSchema: z.object({
      fragmentId: z.string().describe('The generated prose fragment ID to inspect (e.g. pr-bakumo)'),
      aspect: z
        .enum(['summary', 'prompt', 'tools', 'prewriter', 'reasoning'])
        .optional()
        .describe(
          'Which detail to return. Default "summary" is an overview; "prompt" is the full assembled context, "tools" is what the model looked up, "prewriter" is the writing brief, "reasoning" is the model\'s thinking.',
        ),
    }),
    execute: async ({ fragmentId, aspect }: { fragmentId: string; aspect?: InspectAspect }) => {
      log.info('Inspecting run via chat tool', { fragmentId, aspect: aspect ?? 'summary' })
      return inspectGenerationForFragment(dataDir, storyId, fragmentId, aspect ?? 'summary')
    },
  })

  return { invokeAgent, inspectRun }
}

export async function librarianChat(
  dataDir: string,
  storyId: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  return withBranch(dataDir, storyId, () => librarianChatInner(dataDir, storyId, opts))
}

async function librarianChatInner(
  dataDir: string,
  storyId: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  const requestLogger = logger.child({ storyId })
  requestLogger.info('Starting librarian chat...', { messageCount: opts.messages.length })

  // Validate story exists
  const story = await getStory(dataDir, storyId)
  if (!story) {
    throw new Error(`Story ${storyId} not found`)
  }

  // Build context
  const ctxState = await buildContextState(dataDir, storyId, '')

  // Load system prompt fragments
  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)

  // Resolve model early so modelId is available for instruction resolution
  const { model, modelId, temperature, providerOptions, guards } = await resolveAgentRuntime(dataDir, storyId, 'librarian.chat', story)
  requestLogger.info('Resolved model', { modelId })

  // Create write-enabled fragment tools + enabled plugin tools
  const enabledPlugins = (story.settings.enabledPlugins ?? [])
    .map((name) => pluginRegistry.get(name))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
  const fragmentTools = createFragmentTools(dataDir, storyId, { readOnly: false })
  const pluginTools = collectPluginTools(enabledPlugins, dataDir, storyId)

  const allTools = { ...fragmentTools, ...pluginTools, ...createLibrarianChatBespokeTools(dataDir, storyId) }

  // Build plugin tool descriptions for the block context
  const pluginToolDescriptions = Object.entries(pluginTools).map(([name, def]) => ({
    name,
    description: (def as { description?: string }).description ?? '',
  }))

  // Build agent block context
  const blockContext: AgentBlockContext = {
    ...baseBlockContext(ctxState, ctxState.story),
    systemPromptFragments,
    pluginToolDescriptions,
    modelId,
  }

  // Compile context via block system
  const compiled = await compileAgentContext(dataDir, storyId, 'librarian.chat', blockContext, allTools)

  requestLogger.info('Prepared chat tools', {
    fragmentToolCount: Object.keys(fragmentTools).length,
    pluginToolCount: Object.keys(pluginTools).length,
    totalToolCount: Object.keys(compiled.tools).length,
  })

  // Extract system instructions from compiled messages
  const systemMessage = compiled.messages.find(m => m.role === 'system')
  const userMessage = compiled.messages.find(m => m.role === 'user')

  const chatAgent = new ToolLoopAgent({
    model,
    instructions: systemMessage?.content || MISSING_SYSTEM_PROMPT_FALLBACK,
    tools: compiled.tools,
    toolChoice: 'auto',
    stopWhen: stepCountIs(opts.maxSteps ?? 10),
    temperature,
    providerOptions,
    maxOutputTokens: guards.maxOutputTokens,
  })

  // Build messages: context as first user message, then conversation history
  const aiMessages = [
    { role: 'user' as const, content: `Here is the current story context for reference:\n\n${userMessage?.content ?? ''}\n\nI'm ready to chat about this story. Please acknowledge briefly.` },
    { role: 'assistant' as const, content: 'I have the story context. How can I help you with your fragments?' },
    ...opts.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ]

  // Stream with write tools. Hold analysis so multi-step prose edits analyze once on the
  // final state, not per edit (see holdLibrarianAnalysis).
  const result = await chatAgent.stream({
    messages: aiMessages,
  })
  const releaseAnalysis = holdLibrarianAnalysis(storyId)
  // Active-marker/activity-trace/history for this run come from createAgentInstance
  // (the only caller — routes/librarian.ts), which wraps this whole call in
  // beginAgentRun and tees the event stream into the trace. Not duplicated here.
  const stream = createEventStream(result.fullStream)
  void stream.completion.then(releaseAnalysis, releaseAnalysis)
  stream.completion
    .then(() => resolveAndReportUsage(dataDir, storyId, 'librarian.chat', result.totalUsage, modelId))
    .catch(() => {
      // Stream errored — skip usage tracking
    })
  return stream
}
