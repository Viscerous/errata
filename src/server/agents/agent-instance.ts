import { createLogger } from '../logging'
import { agentRegistry } from './registry'
import { ensureCoreAgentsRegistered } from './register-core'
import { beginAgentRun, type AgentRunHandle } from './agent-run'
import type { AgentInvocationContext } from './types'
import type { AgentStreamResult, AgentStreamCompletion } from './stream-types'

/**
 * Maps agent name literals to their parsed input types.
 * Each agent registration file augments this via declaration merging.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AgentInputMap {}

/** Resolve input type: known agents get their specific type, others fall back to Record<string, unknown>. */
type AgentInput<K extends string> = K extends keyof AgentInputMap ? AgentInputMap[K] : Record<string, unknown>

export interface AgentInstance<K extends string = string> {
  readonly agentName: K
  execute(input: AgentInput<K>): Promise<AgentStreamResult>
  /** Record failure if the runner threw before producing a stream. Idempotent. */
  fail(error: unknown): void
}

function safeSerialize(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function createAgentInstance<K extends string>(
  agentName: K,
  context: { dataDir: string; storyId: string },
): AgentInstance<K> {
  ensureCoreAgentsRegistered()

  const definition = agentRegistry.get(agentName)
  if (!definition) {
    throw new Error(`Agent not registered: ${agentName}`)
  }

  let settled = false
  let handle: AgentRunHandle | undefined
  const logger = createLogger(agentName).child({ storyId: context.storyId })

  // Translate the agent's completion/error into the shared run handle. The handle
  // owns the active marker and the activity-history record; this just serializes
  // the agent-specific output.
  function finish(status: 'success' | 'error', resultOrError: unknown): void {
    if (settled || !handle) return
    settled = true

    if (status === 'success') {
      const completion = resultOrError as AgentStreamCompletion
      handle.finish('success', {
        output: safeSerialize({
          text: completion.text,
          reasoning: completion.reasoning,
          toolCalls: completion.toolCalls,
          stepCount: completion.stepCount,
          finishReason: completion.finishReason,
        }),
      })
    } else {
      handle.finish('error', {
        error: resultOrError instanceof Error ? resultOrError.message : String(resultOrError),
      })
    }
  }

  return {
    agentName,

    async execute(input: AgentInput<K>): Promise<AgentStreamResult> {
      // Begin the run before parsing so a validation error is still recorded.
      handle = beginAgentRun(context.storyId, agentName, safeSerialize(input))
      const parsedInput = definition.inputSchema.parse(input)

      const invocationContext: AgentInvocationContext = {
        dataDir: context.dataDir,
        storyId: context.storyId,
        logger,
        runId: handle.runId,
        parentRunId: null,
        rootRunId: handle.runId,
        depth: 0,
        invokeAgent: async () => {
          throw new Error('Nested agent calls not supported via createAgentInstance')
        },
      }

      const rawOutput = await definition.run(invocationContext, parsedInput)
      const { eventStream, completion } = rawOutput as AgentStreamResult

      const wrappedCompletion = completion.then(
        (result) => {
          finish('success', result)
          return result
        },
        (err) => {
          finish('error', err)
          throw err
        },
      )

      return { eventStream, completion: wrappedCompletion }
    },

    fail(error: unknown): void {
      finish('error', error)
    },
  }
}
