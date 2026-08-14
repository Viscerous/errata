import { ToolLoopAgent, stepCountIs, type ToolSet } from 'ai'
import { drainAgentStream } from '../agents/drain-agent-stream'
import type { ActivityStreamEvent } from '../agents/activity-stream'
import { servedModelIdFromResponse } from '../llm/served-models'

type ToolLoopAgentSettings = ConstructorParameters<typeof ToolLoopAgent>[0]

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
}

export interface ToolLoopPassResult {
  fullText: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>
  stepCount: number
  finishReason: string
  servedModelId?: string
  totalUsage: PromiseLike<unknown>
  /** Per-request usage, retained so successful multi-step passes expose their peak context size. */
  stepUsages: ToolLoopStepUsage[]
}

export interface ToolLoopStepUsage {
  stepNumber: number
  finishReason: string
  usage: unknown
  servedModelId?: string
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
  const agent = new ToolLoopAgent({
    model: args.model,
    instructions: args.instructions,
    tools: args.tools,
    toolChoice: 'auto',
    stopWhen: args.terminalToolName
      ? [stepCountIs(args.maxSteps ?? 6), terminalToolSucceeded(args.terminalToolName, args.terminalRequiresToolName)]
      : stepCountIs(args.maxSteps ?? 6),
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
    providerOptions: args.providerOptions,
    maxOutputTokens: args.maxOutputTokens,
    onStepFinish: (event) => {
      stepUsages.push({
        stepNumber: event.stepNumber,
        finishReason: event.finishReason,
        usage: event.usage,
        servedModelId: servedModelIdFromResponse(event.response),
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
