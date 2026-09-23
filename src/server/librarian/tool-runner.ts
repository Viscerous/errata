import { Output, ToolLoopAgent, asSchema, stepCountIs, streamText, type ToolSet } from 'ai'
import { drainAgentStream } from '../agents/drain-agent-stream'
import type { ActivityStreamEvent } from '../agents/activity-stream'
import { servedModelIdFromResponse } from '../llm/served-models'

type ToolLoopAgentSettings = ConstructorParameters<typeof ToolLoopAgent>[0]
export type ToolLoopPrepareStep = NonNullable<ToolLoopAgentSettings['prepareStep']>
export type ToolLoopStopWhen = ToolLoopAgentSettings['stopWhen']

/** Zero disables the watchdog; callers may opt in when a provider needs one. */
export const DEFAULT_TOOL_LOOP_IDLE_TIMEOUT_MS = 0

export interface ToolLoopPassArgs {
  model: ToolLoopAgentSettings['model']
  instructions: string
  prompt: string
  tools: ToolSet
  temperature: ToolLoopAgentSettings['temperature']
  topP: ToolLoopAgentSettings['topP']
  topK: ToolLoopAgentSettings['topK']
  providerOptions: ToolLoopAgentSettings['providerOptions']
  maxOutputTokens?: number
  emit?: (event: ActivityStreamEvent) => void
  maxSteps?: number
  terminalToolName?: string
  terminalRequiresToolName?: string
  abortSignal?: AbortSignal
  idleTimeoutMs?: number
  prepareStep?: ToolLoopPrepareStep
  stopWhen?: ToolLoopStopWhen
}

export interface ToolLoopPassResult {
  fullText: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>
  toolErrors: Array<{ toolName: string; error: string }>
  stepCount: number
  finishReason: string
  servedModelId?: string
  totalUsage: PromiseLike<unknown>
  /** Per-request usage, retained so successful multi-step passes expose their peak context size. */
  stepUsages: ToolLoopStepUsage[]
}

export interface ToolLoopStepUsage {
  stepNumber: number
  /** Parent pipeline stage when several isolated requests are aggregated. */
  stage?: string
  finishReason: string
  usage: unknown
  servedModelId?: string
  /** Tool schemas exposed for this request when the loop uses staged tools. */
  activeTools?: string[]
  /** Wall time for the request and its tool execution, when staged timing is available. */
  durationMs?: number
}

/** Carries usage from completed steps when a later request in the loop fails. */
export class ToolLoopPassError extends Error {
  readonly stepUsages: ToolLoopStepUsage[]

  constructor(cause: unknown, stepUsages: ToolLoopStepUsage[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ToolLoopPassError'
    this.stepUsages = stepUsages
  }
}

function toolOutputOk(output: unknown): boolean {
  if (!output || typeof output !== 'object') return true
  const value = (output as Record<string, unknown>).ok
  return value !== false
}

/** Stop only after the terminal tool executed successfully, not merely after it was called. */
export function terminalToolSucceeded(toolName: string, requiresToolName?: string) {
  return ({ steps }: { steps: Array<{ toolResults?: Array<{ toolName: string; output: unknown }> }> }): boolean => {
    const lastStep = steps[steps.length - 1]
    const terminalSucceeded = lastStep?.toolResults?.some((result) =>
      result.toolName === toolName && toolOutputOk(result.output)
    ) ?? false
    if (!terminalSucceeded) return false
    if (!requiresToolName) return true

    return steps.some((step) =>
      step.toolResults?.some((result) => result.toolName === requiresToolName) ?? false
    )
  }
}

function linkedAbortController(parent?: AbortSignal): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController()
  if (!parent) return { controller, dispose: () => {} }

  const abortFromParent = () => controller.abort()
  if (parent.aborted) {
    controller.abort()
    return { controller, dispose: () => {} }
  }

  parent.addEventListener('abort', abortFromParent, { once: true })
  return {
    controller,
    dispose: () => parent.removeEventListener('abort', abortFromParent),
  }
}

export async function runToolLoopPass(args: ToolLoopPassArgs): Promise<ToolLoopPassResult> {
  const stepUsages: ToolLoopStepUsage[] = []
  const activeToolsByStep = new Map<number, string[]>()
  const stepStartedAt = new Map<number, number>()
  const agent = new ToolLoopAgent({
    model: args.model,
    instructions: args.instructions,
    tools: args.tools,
    toolChoice: 'auto',
    stopWhen: [
      stepCountIs(args.maxSteps ?? 6),
      ...(args.terminalToolName
        ? [terminalToolSucceeded(args.terminalToolName, args.terminalRequiresToolName)]
        : []),
      ...(Array.isArray(args.stopWhen) ? args.stopWhen : args.stopWhen ? [args.stopWhen] : []),
    ],
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
    providerOptions: args.providerOptions,
    maxOutputTokens: args.maxOutputTokens,
    prepareStep: args.prepareStep
      ? async (options) => {
          stepStartedAt.set(options.stepNumber, Date.now())
          const prepared = await args.prepareStep!(options)
          if (prepared?.activeTools) {
            activeToolsByStep.set(options.stepNumber, prepared.activeTools.map(String))
          }
          return prepared
        }
      : undefined,
    onStepFinish: (event) => {
      const startedAt = stepStartedAt.get(event.stepNumber)
      stepUsages.push({
        stepNumber: event.stepNumber,
        finishReason: event.finishReason,
        usage: event.usage,
        servedModelId: servedModelIdFromResponse(event.response),
        ...(activeToolsByStep.has(event.stepNumber)
          ? { activeTools: activeToolsByStep.get(event.stepNumber) }
          : {}),
        ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
      })
    },
  })

  const { controller, dispose } = linkedAbortController(args.abortSignal)
  try {
    const result = await agent.stream({
      prompt: args.prompt,
      abortSignal: controller.signal,
    })
    const drained = await drainAgentStream(result.fullStream, args.emit ?? (() => {}), {
      abortSignal: controller.signal,
      idleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_TOOL_LOOP_IDLE_TIMEOUT_MS,
      onIdleTimeout: () => controller.abort(),
    })
    return {
      fullText: drained.fullText,
      toolCalls: drained.toolCalls,
      toolErrors: drained.toolErrors,
      stepCount: drained.stepCount,
      finishReason: drained.finishReason,
      servedModelId: drained.servedModelId,
      totalUsage: result.totalUsage,
      stepUsages,
    }
  } catch (error) {
    if (!controller.signal.aborted) controller.abort()
    throw new ToolLoopPassError(error, stepUsages)
  } finally {
    dispose()
  }
}

export interface StructuredPassArgs {
  model: ToolLoopPassArgs['model']
  instructions: string
  prompt: string
  toolName: string
  tool: ToolSet[string]
  temperature: ToolLoopPassArgs['temperature']
  topP: ToolLoopPassArgs['topP']
  topK: ToolLoopPassArgs['topK']
  providerOptions: ToolLoopPassArgs['providerOptions']
  maxOutputTokens?: number
  emit?: (event: ActivityStreamEvent) => void
  abortSignal?: AbortSignal
  idleTimeoutMs?: number
}

/**
 * One request answered in the tool's input schema as a JSON response format,
 * then handed to the tool as its input.
 *
 * Where the provider constrains that format while decoding, the schema is the
 * whole answer: bounds hold, required fields exist, and nothing can follow the
 * closing brace. The result has the shape of a one-step tool pass, so callers
 * treat both the same.
 */
export async function runStructuredPass(args: StructuredPassArgs): Promise<ToolLoopPassResult> {
  const stepUsages: ToolLoopStepUsage[] = []
  const startedAt = Date.now()
  const schema = asSchema(args.tool.inputSchema)
  const { controller, dispose } = linkedAbortController(args.abortSignal)
  try {
    const result = streamText({
      model: args.model,
      system: args.instructions,
      prompt: args.prompt,
      output: Output.object({ schema, name: args.toolName, description: args.tool.description }),
      temperature: args.temperature,
      topP: args.topP,
      topK: args.topK,
      providerOptions: args.providerOptions,
      maxOutputTokens: args.maxOutputTokens,
      abortSignal: controller.signal,
      onStepFinish: (event) => {
        stepUsages.push({
          stepNumber: 0,
          finishReason: event.finishReason,
          usage: event.usage,
          servedModelId: servedModelIdFromResponse(event.response),
          activeTools: [args.toolName],
          durationMs: Date.now() - startedAt,
        })
      },
    })
    const drained = await drainAgentStream(result.fullStream, args.emit ?? (() => {}), {
      abortSignal: controller.signal,
      idleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_TOOL_LOOP_IDLE_TIMEOUT_MS,
      onIdleTimeout: () => controller.abort(),
    })

    const toolCalls: ToolLoopPassResult['toolCalls'] = []
    const toolErrors: ToolLoopPassResult['toolErrors'] = []
    const toolCallId = `structured-${args.toolName}-${startedAt.toString(36)}`
    let parsed: unknown
    try {
      parsed = JSON.parse(drained.fullText)
    } catch {
      toolErrors.push({
        toolName: args.toolName,
        error: `The response was not a complete JSON report (finish reason: ${drained.finishReason}).`,
      })
    }
    if (parsed !== undefined) {
      const validation = await schema.validate?.(parsed) ?? { success: true as const, value: parsed }
      if (!validation.success) {
        toolErrors.push({ toolName: args.toolName, error: String(validation.error) })
      } else {
        const input = validation.value as Record<string, unknown>
        args.emit?.({ type: 'tool-call', id: toolCallId, toolName: args.toolName, args: input })
        const output = await args.tool.execute?.(input, { toolCallId, messages: [], abortSignal: controller.signal })
        args.emit?.({ type: 'tool-result', id: toolCallId, toolName: args.toolName, result: output })
        toolCalls.push({ toolName: args.toolName, args: input, result: output })
      }
    }
    for (const failure of toolErrors) {
      args.emit?.({ type: 'tool-error', id: toolCallId, toolName: failure.toolName, error: failure.error })
    }

    return {
      fullText: '',
      toolCalls,
      toolErrors,
      stepCount: drained.stepCount,
      finishReason: toolCalls.length > 0 ? 'tool-calls' : drained.finishReason,
      servedModelId: drained.servedModelId,
      totalUsage: result.totalUsage,
      stepUsages,
    }
  } catch (error) {
    if (!controller.signal.aborted) controller.abort()
    throw new ToolLoopPassError(error, stepUsages)
  } finally {
    dispose()
  }
}
