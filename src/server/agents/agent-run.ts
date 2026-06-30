import { recordAgentRun, makeAgentRunId } from './traces'
import { registerActiveAgent, unregisterActiveAgent } from './active-registry'
import { getActivityBuffer, pushActivityEvent, type ActivityStreamEvent } from './activity-stream'
import type { AgentTraceEntry } from './types'

export interface AgentRunDetail {
  error?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
}

export interface AgentRunHandle {
  readonly runId: string
  /** Push a reasoning/text/tool event onto the run's live activity trace. */
  pushEvent(event: ActivityStreamEvent): void
  /**
   * Record the run's outcome and clear its active-agent marker. Idempotent —
   * safe to call from a finally and an explicit branch; only the first wins.
   */
  finish(status: 'success' | 'error', detail?: AgentRunDetail): void
}

/**
 * The single lifecycle owner for an agent run: registers it as active, captures
 * timing, and on finish() records it into the activity history and clears the
 * active marker. Used by every agent execution path (streaming instances, the
 * writer/prewriter route) so they all surface in the same activity/history.
 */
export function beginAgentRun(storyId: string, agentName: string, input?: Record<string, unknown>): AgentRunHandle {
  const runId = makeAgentRunId()
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  const activityId = registerActiveAgent(storyId, agentName)
  // Buffer is owned by the active registry (created above); we just hold the ref to push into.
  const buffer = getActivityBuffer(storyId, agentName)
  let settled = false

  return {
    runId,
    pushEvent(event) {
      if (buffer) pushActivityEvent(buffer, event)
    },
    finish(status, detail) {
      if (settled) return
      settled = true
      unregisterActiveAgent(activityId) // finishes + clears the live buffer

      const finishedAt = new Date().toISOString()
      const durationMs = Date.now() - startMs
      const resolvedInput = detail?.input ?? input
      const entry: AgentTraceEntry = {
        runId,
        parentRunId: null,
        rootRunId: runId,
        agentName,
        startedAt,
        finishedAt,
        durationMs,
        status,
        ...(detail?.error ? { error: detail.error } : {}),
        ...(detail?.output ? { output: detail.output } : {}),
      }
      recordAgentRun(storyId, {
        rootRunId: runId,
        runId,
        storyId,
        agentName,
        status,
        startedAt,
        finishedAt,
        durationMs,
        ...(detail?.error ? { error: detail.error } : {}),
        ...(resolvedInput ? { input: resolvedInput } : {}),
        ...(detail?.output ? { output: detail.output } : {}),
        trace: [entry],
      })
    },
  }
}
