import { tool, ToolLoopAgent, stepCountIs, hasToolCall, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { resolveAgentRuntime } from './client'
import { addCacheBreakpoints, compileBlocks, expandMessagesFragmentTags, type ContextBlock, type ContextMessage } from './context-builder'
import { proseWindowBlock } from './fragment-context-blocks'
import { compileAgentContext } from '../agents/compile-agent-context'
import { instructionRegistry } from '../instructions'
import { buildContextState } from './context-builder'
import { type AgentBlockContext, baseBlockContext } from '../agents/agent-block-context'
import type { Fragment, StoryMeta } from '../fragments/schema'
import type { TokenUsage, ToolCallLog } from './generation-logs'
import { resolveAndReportUsage } from './usage-normalizer'
import { createLogger } from '../logging'

const logger = createLogger('prewriter')

export const PREWRITER_INSTRUCTIONS = `You are a writing planner. Analyze the full story context and the author's direction,
then produce a focused WRITING BRIEF for the writer — a separate prose model.

The writer sees exactly two things: the most recent prose (for continuity) and your brief.
Character fragments, guidelines, knowledge, and the story summary all stay with you.
Everything the writer needs must be in your brief.

## Writing Brief Requirements

Your brief must include:

1. **SCENE SETUP**: Where are we? Who is present? What just happened?
2. **OBJECTIVE**: What should this passage accomplish? (1-2 sentences)
3. **CHARACTER VOICES**: For each character active in this scene, a detailed voice profile distilled from their character fragment:
   - How they speak (vocabulary level, sentence patterns, verbal tics, accent cues)
   - Personality in action (how their traits manifest in dialogue and behavior)
   - Emotional state right now and what's driving it
   - What they want in this scene and how they'll pursue it
   - Example dialogue line that captures their voice in this moment
   *This section carries everything the writer will ever know about these characters.*
4. **PACING**: How much story time this passage covers and where it ends. Be specific: "End when X happens" or "End mid-conversation after Y."
5. **KEY DETAILS**: Specific facts, names, places from knowledge/guidelines to reference.
6. **TONE & STYLE**: Emotional register, prose style, POV constraints.
7. **SCOPE LIMITS**: Boundaries the writer must respect, stated as positive constraints:
   - "Keep the conflict unresolved in this passage"
   - "Stay within the current time frame"
   - "Keep the cast to the characters named above"

Be direct and specific. The Reasoning Length guidance below sets how long and how deeply to plan — follow it for the brief's length and level of detail. Spend the most space on **CHARACTER VOICES** — the writer depends entirely on your character direction to capture each character faithfully.

## Next Directions

After writing the brief, call the proposeDirections tool with exactly 3 pacing options for the NEXT passage:

1. **LINGER** — A direction that stays in the current moment. Deepen the atmosphere, explore character interiority, or develop the emotional texture of the scene without advancing the plot.
2. **CONTINUE** — A direction that advances the scene meaningfully but leaves the current plot thread unresolved. Move toward the next beat but leave it open.
3. **END** — A direction that brings the current scene or plot section to a natural conclusion. Resolve the active tension and transition to what comes next.

Anchor each direction in this specific story moment rather than generic advice.`

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
  short: `## Reasoning Length: SHORT — favor speed
Move fast. Do NOT deliberate at length or chase optional tool lookups — decide
from the context you already have. Write a tight, skimmable brief of roughly
300 words. Give voice notes only for characters who actually speak in this
scene, a line or two each. Getting the writer moving quickly matters more than
exhaustive coverage.`,
  normal: `## Reasoning Length: NORMAL — balanced
Plan thoughtfully but efficiently. Aim for a brief of around 800 words. Cover
the active characters' voices well without exhausting every detail.`,
  extensive: `## Reasoning Length: EXTENSIVE — favor depth
Reason thoroughly before committing. Weigh subtext, character interiority, and
alternative beats, and look things up when it genuinely helps. Write a detailed
brief (1200–1800 words is fine). Give every active character a rich voice
profile with an example line, and think carefully about pacing and exactly
where this passage should end.`,
}

/** Appended to the prewriter prompt when clarify-before-generate is enabled. */
export const CLARIFY_INSTRUCTIONS = `## Clarifying Questions

Before writing the brief, judge whether the author's direction is genuinely
ambiguous — missing intent, unclear POV or which character acts, undefined
stakes, or a fork you cannot resolve from context.

- If everything you need is clear, DO NOT ask. Proceed straight to the brief.
- If you genuinely need input, call the askClarifyingQuestions tool with up to 4 focused
  questions. For each question, supply 2-4 concrete options when you can
  enumerate the likely answers; omit options for open-ended questions.
- If you call askClarifyingQuestions, STOP — do not also write a brief or call
  proposeDirections. The author will answer and you will be re-invoked.
- Never re-ask anything the author has already answered.`

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
  compiledMessages: ContextMessage[]
  blockContext?: AgentBlockContext
  authorInput: string
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
  usage?: TokenUsage
  /** Set when the prewriter asked the author clarifying questions instead of finalizing a brief. */
  questions?: ClarifyQuestion[]
}

/**
 * Runs the prewriter agent to produce a focused writing brief.
 * The prewriter sees the full compiled context and produces a brief
 * that the writer will use instead of the full context.
 */
export async function runPrewriter(args: RunPrewriterArgs): Promise<PrewriterResult> {
  const { dataDir, storyId, story, compiledMessages, authorInput, mode, tools, maxSteps = 3, abortSignal, onEvent, clarifyEnabled = false, clarifications = [], round = 0, reasoning = 'normal' } = args
  const requestLogger = logger.child({ storyId })
  const canAskQuestions = clarifyEnabled && round < MAX_CLARIFY_ROUNDS

  const startTime = Date.now()
  const { model, modelId, temperature, providerOptions, guards } = await resolveAgentRuntime(dataDir, storyId, 'generation.prewriter', story)
  requestLogger.info('Prewriter model resolved', { modelId })

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

  // Replace the full-context placeholder with the actual compiled messages
  const fullContextContent = compiledMessages
    .map(m => `[${m.role}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n\n---\n\n')

  prewriterBlocks = prewriterBlocks.map(b =>
    b.id === 'full-context'
      ? { ...b, content: `## Full Story Context\n\n${fullContextContent}` }
      : b,
  )

  // Update planning-request based on mode
  const modePrompts: Record<string, string> = {
    generate: `The author wants to CONTINUE the story. Their direction: ${authorInput}\n\nCreate a writing brief for this continuation.`,
    regenerate: `The author wants to REGENERATE the latest passage. Their direction: ${authorInput}\n\nCreate a writing brief for an alternative version of the most recent prose.`,
    refine: `The author wants to REFINE/EDIT the latest passage. Their direction: ${authorInput}\n\nCreate a writing brief that addresses the author's refinement request while maintaining continuity.`,
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
      directions: z.array(z.object({
        pacing: z.enum(['linger', 'continue', 'end']),
        title: z.string().describe('Short evocative title (3-6 words)'),
        description: z.string().describe('1-2 sentences previewing what happens'),
        instruction: z.string().describe('Concrete writing prompt for the writer'),
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
    temperature,
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
      captureStepBrief()
    }
  }
  // The final step may close with `finish` rather than `finish-step` (and some
  // providers/mocks emit only `finish`) — keep its text.
  captureStepBrief()

  const durationMs = Date.now() - startTime

  const usage = await resolveAndReportUsage(dataDir, storyId, 'generation.prewriter', result.totalUsage, modelId)

  requestLogger.info('Prewriter completed', { durationMs, briefLength: briefText.length })

  const serializedMessages = prewriterMessages.map(m => ({
    role: String(m.role),
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }))

  // Collect custom blocks from the prewriter's agent block config so they can be forwarded to the writer
  const customBlocks = prewriterBlocks.filter(b => b.source === 'custom')

  requestLogger.info('Prewriter steps used', { stepCount })

  return { brief: briefText, reasoning: fullReasoning, messages: serializedMessages, customBlocks, directions: capturedDirections, toolCalls, stepCount, durationMs, model: modelId, usage, questions: capturedQuestions ?? undefined }
}

/**
 * Creates default blocks for the prewriter agent.
 * These blocks define the prewriter's prompt structure and can be
 * customized by users via the block editor.
 */
export function createPrewriterBlocks(_ctx: AgentBlockContext): ContextBlock[] {
  return [
    {
      id: 'instructions',
      role: 'system' as const,
      content: instructionRegistry.resolve('generation.prewriter.system', _ctx.modelId),
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
  modelId?: string,
): ContextBlock[] {
  const blocks: ContextBlock[] = []
  const normalizedBrief = brief
    .replace(/^\s{0,3}#{1,6}\s*Writing Brief\s*\n+/i, '')
    .replace(/^\s*Writing Brief\s*:\s*\n+/i, '')
    .trim()

  blocks.push({
    id: 'instructions',
    role: 'system' as const,
    content: instructionRegistry.resolve('generation.writer-brief.system', modelId),
    order: 100,
    source: 'builtin',
  })

  // Tools reach the model via the SDK schema; this block holds usage policy only.
  blocks.push({
    id: 'tools',
    role: 'system' as const,
    content: instructionRegistry.resolve('generation.writer-brief.tools-suffix', modelId),
    order: 200,
    source: 'builtin',
  })

  {
    const prose = proseWindowBlock(proseFragments, {
      order: 100,
      newStoryGuidance: 'Establish the opening scene — setting, tone, and any initial characters — based on the writing brief below.',
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

  return blocks
}
