import { tool, ToolLoopAgent, stepCountIs, hasToolCall, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { resolveAgentRuntime, samplingCallSettings, samplingDiagnostics } from './client'
import { addCacheBreakpoints, compileBlocks, expandMessagesFragmentTags, type ContextBlock } from './context-builder'
import { proseWindowBlock } from './fragment-context-blocks'
import { compileAgentContext } from '../agents/compile-agent-context'
import { instructionRegistry } from '../instructions'
import { buildContextState } from './context-builder'
import { type AgentBlockContext, baseBlockContext } from '../agents/agent-block-context'
import { renderContinuity } from '../librarian/continuity-view'
import { suggestionDirectionSchema } from '../directions/schema'
import type { Fragment, SamplingSettings, StoryMeta } from '@/contracts/story'
import type { TokenUsage, ToolCallLog } from './generation-logs'
import { resolveAndReportServedUsage } from './usage-normalizer'
import { servedModelIdFromResponse } from './served-models'
import { createLogger } from '../logging'
import type { AuthorInputMode } from '@/contracts/generation'
import { createGenerationInputBlocks, createPlanningRequest } from './generation-input-contract'

const logger = createLogger('prewriter')

export const PREWRITER_INSTRUCTIONS = `Plan the next passage for a separate fiction writer. Use the supplied story context and author request or protagonist move; do not write the passage yourself.

Produce a concise, self-contained writing brief covering:
- the immediate starting point and passage objective;
- active characters' current motives, emotions, and distinctive voices;
- pacing and the exact stopping point;
- only the continuity facts, style, and point-of-view constraints needed now;
- any boundary the passage must respect.

After the brief, call proposeDirections exactly once with three story-specific options for the following passage: LINGER in the current moment, CONTINUE the active thread, and END the current scene or section.`

export interface PrewriterDirection {
  pacing: 'linger' | 'continue' | 'end'
  title: string
  description: string
  instruction: string
}

/** Hard cap on how many question rounds the prewriter may run before it must finalize. */
export const MAX_CLARIFY_ROUNDS = 3

/** How much the prewriter deliberates — trades speed against depth. */
export type PrewriterReasoning = 'short' | 'normal' | 'extensive'

/**
 * Per-level guidance appended to the prewriter prompt. The prompt is the primary
 * lever (brief length + how much to deliberate); the route additionally scales
 * the prewriter's tool-step budget so 'short' is genuinely faster.
 */
export const PREWRITER_REASONING_DIRECTIVES: Record<PrewriterReasoning, string> = {
  short: 'Keep the brief near 200 words. Use only immediately relevant context and avoid optional lookups.',
  normal: 'Keep the brief near 500 words. Cover active character voices and continuity without exhaustive background.',
  extensive: 'Use up to 1,000 words when useful. Examine subtext, character interiority, alternative beats, and the stopping point in depth.',
}

/** Appended to the prewriter prompt when clarify-before-generate is enabled. */
export const CLARIFY_INSTRUCTIONS = `If the author request has an important ambiguity the story context cannot resolve, call askClarifyingQuestions with up to four focused questions and then stop. Offer concrete options when useful. Otherwise write the brief immediately, and never repeat an answered question.`

export interface ClarifyQuestionOption {
  label: string
  description?: string
}

export interface ClarifyQuestion {
  question: string
  header: string
  multiSelect: boolean
  options?: ClarifyQuestionOption[]
}

/** Schema for a single clarifying question the prewriter may ask the author. */
export const ClarifyQuestionSchema = z.object({
  question: z.string().describe('The question to ask the author'),
  header: z.string().max(12).describe('Short chip label, <= 12 chars'),
  multiSelect: z.boolean().default(false).describe('Allow selecting multiple options'),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .min(2)
    .max(4)
    .optional()
    .describe('2-4 suggested options, or omit for a free-text answer'),
})

/** Input schema for the askClarifyingQuestions tool: 1–4 clarifying questions. */
export const ClarifyQuestionsInputSchema = z.object({
  questions: z.array(ClarifyQuestionSchema).min(1).max(4),
})

export interface Clarification {
  question: string
  answer: string
}

export type PrewriterEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'reset' }
  | { type: 'tool-call'; id: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; toolName: string; result: unknown }
  | { type: 'directions'; directions: PrewriterDirection[] }
  | { type: 'questions'; questions: ClarifyQuestion[] }

export interface RunPrewriterArgs {
  dataDir: string
  storyId: string
  /** The story, already loaded by the caller — resolves the prewriter's own
   * runtime (model, thinking toggle, output cap) via `resolveAgentRuntime`. */
  story: StoryMeta
  /** Structured Writer-owned story blocks projected into the planning prompt. */
  contextBlocks: ContextBlock[]
  blockContext?: AgentBlockContext
  authorInput: string
  inputMode?: AuthorInputMode
  mode: 'generate' | 'regenerate' | 'refine'
  tools?: ToolSet
  maxSteps?: number
  abortSignal?: AbortSignal
  onEvent?: (event: PrewriterEvent) => void
  /** Allow the prewriter to ask clarifying questions via the askClarifyingQuestions tool. */
  clarifyEnabled?: boolean
  /** Prior question/answer pairs from earlier clarify rounds, rendered into the prompt. */
  clarifications?: Clarification[]
  /** Which clarify round this is (0-based). At MAX_CLARIFY_ROUNDS the ask tool is withheld. */
  round?: number
  /** How much the prewriter deliberates (brief length + depth). Defaults to 'normal'. */
  reasoning?: PrewriterReasoning
}

export interface PrewriterResult {
  brief: string
  reasoning: string
  messages: Array<{ role: string; content: string }>
  customBlocks: ContextBlock[]
  directions: PrewriterDirection[]
  toolCalls: ToolCallLog[]
  stepCount: number
  durationMs: number
  model: string
  sampling: SamplingSettings
  usage?: TokenUsage
  /** Structured story blocks actually presented through the full-context slot. */
  presentedContextBlocks: ContextBlock[]
  /** Set when the prewriter asked the author clarifying questions instead of finalizing a brief. */
  questions?: ClarifyQuestion[]
}

/**
 * Runs the prewriter agent to produce a focused writing brief.
 * The prewriter sees the full compiled context and produces a brief
 * that the writer will use instead of the full context.
 */
export async function runPrewriter(args: RunPrewriterArgs): Promise<PrewriterResult> {
  const { dataDir, storyId, story, contextBlocks, authorInput, inputMode = 'direct', mode, tools, maxSteps = 3, abortSignal, onEvent, clarifyEnabled = false, clarifications = [], round = 0, reasoning = 'normal' } = args
  const requestLogger = logger.child({ storyId })
  const canAskQuestions = clarifyEnabled && round < MAX_CLARIFY_ROUNDS

  const startTime = Date.now()
  const runtime = await resolveAgentRuntime(dataDir, storyId, 'generation.prewriter', story)
  const { model, modelId, providerId, providerOptions, guards } = runtime
  requestLogger.info('Prewriter model resolved', { modelId, sampling: samplingDiagnostics(runtime) })

  // Build the prewriter prompt from blocks (allows user customization via block editor).
  // Falls back to the real story's empty context state (never a fabricated
  // placeholder) so a caller that omits blockContext still gets a context shape
  // that can't drift from what every other agent's preview builds from.
  const blockContext: AgentBlockContext = {
    ...baseBlockContext(undefined, story),
    systemPromptFragments: [],
    ...(args.blockContext ?? {}),
    modelId,
  }

  let prewriterBlocks: ContextBlock[]
  let configuredTools: ToolSet = tools ?? {}
  try {
    const compiled = await compileAgentContext(dataDir, storyId, 'generation.prewriter', blockContext, tools ?? {})
    prewriterBlocks = compiled.blocks
    configuredTools = compiled.tools
  } catch {
    // If no agent block config exists, use default blocks
    prewriterBlocks = createPrewriterBlocks(blockContext)
  }

  // Replace the placeholder with real blocks rather than serializing a compiled
  // Writer prompt into a second prompt. This preserves fragment metadata for
  // receipts and keeps each context surface independently inspectable.
  prewriterBlocks = prewriterBlocks.flatMap((block) => {
    if (block.id !== 'full-context') return [block]
    const projected = contextBlocks.map((contextBlock, index) => ({
      ...contextBlock,
      id: `full-context:${contextBlock.id}`,
      order: block.order + ((index + 1) / 1000),
      source: 'builtin' as const,
    }))
    return [
      { ...block, content: '## Full Story Context' },
      ...projected,
    ]
  })

  // Update planning-request based on operation and the author's input contract.
  // A story turn stays verbatim here and is also sent verbatim to the writer;
  // the brief may interpret its consequences but cannot replace it.
  const modePrompts: Record<string, string> = {
    generate: createPlanningRequest(authorInput, inputMode, 'generate'),
    regenerate: createPlanningRequest(authorInput, inputMode, 'regenerate'),
    refine: createPlanningRequest(authorInput, inputMode, 'refine'),
  }

  prewriterBlocks = prewriterBlocks.map(b => {
    if (b.id !== 'planning-request') return b
    let content = modePrompts[mode] ?? modePrompts.generate
    if (clarifications.length > 0) {
      content += '\n\n## The Author Already Answered These Questions\n'
        + clarifications.map(c => `Q: ${c.question}\nA: ${c.answer}`).join('\n\n')
        + '\n\nUse these answers. Do not ask about anything answered above.'
    }
    return { ...b, content }
  })

  // Reasoning-length guidance — its own block so it survives user overrides of
  // the base instructions and renders right after them.
  prewriterBlocks = [
    ...prewriterBlocks,
    {
      id: 'reasoning-length',
      role: 'system' as const,
      content: PREWRITER_REASONING_DIRECTIVES[reasoning],
      order: 110,
      source: 'builtin',
    },
  ]

  // When clarify is enabled, append guidance telling the prewriter it may ask
  // questions via the askClarifyingQuestions tool. Kept as its own block so it survives
  // user block overrides of the base instructions.
  if (canAskQuestions) {
    prewriterBlocks = [
      ...prewriterBlocks,
      {
        id: 'clarify-instructions',
        role: 'system' as const,
        content: CLARIFY_INSTRUCTIONS,
        order: 150,
        source: 'builtin',
      },
    ]
  }

  let prewriterMessages = compileBlocks(prewriterBlocks)
  prewriterMessages = await expandMessagesFragmentTags(prewriterMessages, dataDir, storyId)

  // Directions collector — captured via closure in the proposeDirections tool
  let capturedDirections: PrewriterDirection[] = []

  const directionsTool = tool({
    description: 'Suggest 3 pacing-aware directions for the next passage.',
    inputSchema: z.object({
      // The same direction the librarian proposes, plus the pacing choice that
      // is this tool's own: one name should not mean two shapes.
      directions: z.array(suggestionDirectionSchema.extend({
        pacing: z.enum(['linger', 'continue', 'end']),
      })).length(3),
    }),
    execute: async ({ directions }) => {
      capturedDirections = directions
      onEvent?.({ type: 'directions', directions })
      return { ok: true }
    },
  })

  // Clarify tool — captures questions via closure. When the prewriter calls it,
  // we treat the turn as terminal: the caller surfaces the questions and skips
  // the writer entirely (no brief is produced this round).
  let capturedQuestions: ClarifyQuestion[] | null = null
  const askClarifyingQuestionsTool = tool({
    description: 'Ask the author up to 4 clarifying questions before writing. Use ONLY when the direction is genuinely ambiguous. Calling this ends your turn — do not also write a brief or propose directions.',
    inputSchema: ClarifyQuestionsInputSchema,
    execute: async ({ questions }) => {
      capturedQuestions = questions as ClarifyQuestion[]
      onEvent?.({ type: 'questions', questions: capturedQuestions })
      return { ok: true, asked: questions.length }
    },
  })

  const mergedTools: ToolSet = {
    ...configuredTools,
    proposeDirections: directionsTool,
    ...(canAskQuestions ? { askClarifyingQuestions: askClarifyingQuestionsTool } : {}),
  }
  const agent = new ToolLoopAgent({
    model,
    tools: mergedTools,
    toolChoice: 'auto',
    stopWhen: [
      stepCountIs(maxSteps),
      hasToolCall('proposeDirections'),
      hasToolCall('askClarifyingQuestions'),
    ],
    ...samplingCallSettings(runtime),
    providerOptions,
    maxOutputTokens: guards.maxOutputTokens,
  })

  // The brief is the text of the LATEST step that produced text. Capturing per
  // step (and keeping the last non-empty one) avoids concatenating drafts when a
  // model re-writes the brief across steps — e.g. writes it, looks a detail up,
  // then re-emits it in the same turn it calls proposeDirections. Accumulating
  // every text-delta would otherwise hand the writer the brief twice.
  let briefText = ''
  let currentStepText = ''
  let fullReasoning = ''
  let stepCount = 0
  let servedModelId: string | undefined
  let terminalToolReturned = false
  const toolCallArgsById = new Map<string, Record<string, unknown>>()
  const toolCalls: ToolCallLog[] = []
  const result = await agent.stream({
    messages: addCacheBreakpoints(prewriterMessages),
    abortSignal,
  })

  const captureStepBrief = () => {
    if (currentStepText.trim()) briefText = currentStepText
    currentStepText = ''
  }

  for await (const part of result.fullStream) {
    const p = part as Record<string, unknown>
    if (part.type === 'text-delta') {
      if (terminalToolReturned) continue
      const text = (p.text ?? '') as string
      // A fresh step starting to (re)write the brief supersedes the prior draft —
      // signal the client to clear the brief streamed so far.
      if (currentStepText === '' && briefText !== '') {
        onEvent?.({ type: 'reset' })
      }
      currentStepText += text
      onEvent?.({ type: 'text', text })
    } else if (part.type === 'reasoning-delta') {
      if (terminalToolReturned) continue
      const text = (p.text ?? '') as string
      fullReasoning += text
      onEvent?.({ type: 'reasoning', text })
    } else if (part.type === 'tool-call') {
      const toolCallId = p.toolCallId as string
      const input = (p.input ?? {}) as Record<string, unknown>
      toolCallArgsById.set(toolCallId, input)
      onEvent?.({
        type: 'tool-call',
        id: toolCallId,
        toolName: p.toolName as string,
        args: input,
      })
    } else if (part.type === 'tool-result') {
      const toolName = (p.toolName as string) ?? ''
      const toolCallId = p.toolCallId as string
      toolCalls.push({
        toolName,
        args: toolCallArgsById.get(toolCallId) ?? {},
        result: p.output,
      })
      if (p.toolName === 'proposeDirections' || p.toolName === 'askClarifyingQuestions') {
        terminalToolReturned = true
      }
      onEvent?.({
        type: 'tool-result',
        id: toolCallId,
        toolName,
        result: p.output,
      })
    } else if (part.type === 'finish-step') {
      // One step per LLM round-trip. `finish` (singular) fires once for the
      // whole run, so counting it would always yield 1.
      stepCount++
      servedModelId = servedModelIdFromResponse(p.response) ?? servedModelId
      captureStepBrief()
    }
  }
  // The final step may close with `finish` rather than `finish-step` (and some
  // providers/mocks emit only `finish`) — keep its text.
  captureStepBrief()

  const durationMs = Date.now() - startTime

  const { usage } = await resolveAndReportServedUsage(
    dataDir,
    storyId,
    'generation.prewriter',
    result.totalUsage,
    { providerId, configuredModelId: modelId, servedModelId },
  )

  requestLogger.info('Prewriter completed', { durationMs, briefLength: briefText.length })

  const serializedMessages = prewriterMessages.map(m => ({
    role: String(m.role),
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }))

  // Collect custom blocks from the prewriter's agent block config so they can be forwarded to the writer
  const customBlocks = prewriterBlocks.filter(b => b.source === 'custom')

  requestLogger.info('Prewriter steps used', { stepCount })

  return {
    brief: briefText,
    reasoning: fullReasoning,
    messages: serializedMessages,
    customBlocks,
    directions: capturedDirections,
    toolCalls,
    stepCount,
    durationMs,
    model: modelId,
    sampling: samplingDiagnostics(runtime),
    usage,
    presentedContextBlocks: prewriterBlocks.filter((block) => block.id.startsWith('full-context:')),
    questions: capturedQuestions ?? undefined,
  }
}

/**
 * Creates default blocks for the prewriter agent.
 * These blocks define the prewriter's prompt structure and can be
 * customized by users via the block editor.
 */
export function createPrewriterBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const planningContinuity = renderContinuity(ctx, 'generation.prewriter')
  return [
    {
      id: 'instructions',
      role: 'system' as const,
      content: instructionRegistry.resolve('generation.prewriter.system'),
      order: 100,
      source: 'builtin',
    },
    {
      id: 'full-context',
      role: 'user' as const,
      content: '(the full story context will appear here)',
      order: 100,
      source: 'builtin',
    },
    // The planner decides what the passage does, so it needs current state as a
    // block it owns. Flattened inside full-context instead, continuity is
    // unreachable from the block editor and shows only a placeholder in preview.
    ...(planningContinuity ? [{
      id: 'continuity-observations',
      role: 'user' as const,
      content: planningContinuity,
      order: 150,
      source: 'builtin' as const,
    }] : []),
    {
      id: 'planning-request',
      role: 'user' as const,
      content: '(the planning request will appear here, based on generation mode)',
      order: 200,
      source: 'builtin',
    },
  ]
}

/**
 * Builds a preview context for the prewriter's block editor.
 */
export async function buildPrewriterPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const state = await buildContextState(dataDir, storyId, '(preview)')
  return {
    ...baseBlockContext(state, state.story),
    systemPromptFragments: [],
  }
}

/**
 * Builds a stripped-down writer context that contains only:
 * - Simplified instructions
 * - Tool descriptions (writer can still look up fragments)
 * - Recent prose (for continuity)
 * - The prewriter's writing brief
 *
 * All other context (characters, guidelines, knowledge, summary, catalogs)
 * is omitted — the writer relies on the brief instead.
 */
export function createWriterBriefBlocks(
  proseFragments: Fragment[],
  brief: string,
  authorStoryTurn?: string,
): ContextBlock[] {
  const blocks: ContextBlock[] = []
  const normalizedBrief = brief
    .replace(/^\s{0,3}#{1,6}\s*Writing Brief\s*\n+/i, '')
    .replace(/^\s*Writing Brief\s*:\s*\n+/i, '')
    .trim()

  blocks.push({
    id: 'instructions',
    role: 'system' as const,
    content: instructionRegistry.resolve('generation.writer-brief.system'),
    order: 100,
    source: 'builtin',
  })

  {
    const prose = proseWindowBlock(proseFragments, {
      order: 100,
      newStoryGuidance: 'Write the opening from the brief below.',
    })
    if (prose) blocks.push(prose)
  }

  blocks.push({
    id: 'writing-brief',
    role: 'user' as const,
    content: `## Writing Brief\n\n${normalizedBrief}`,
    order: 200,
    source: 'builtin',
  })

  blocks.push(...createGenerationInputBlocks({
    authorInput: authorStoryTurn ?? '',
    inputMode: 'play',
    inputOrder: 300,
  }))

  return blocks
}
