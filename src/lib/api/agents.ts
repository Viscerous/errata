import { apiFetch, fetchGetEventStream } from './client'

export interface ActiveAgent {
  id: string
  runId?: string
  storyId: string
  branchId?: string
  agentName: string
  startedAt: string
  status: 'running' | 'cancelling'
}

export const agents = {
  cancel: (storyId: string, runId: string) =>
    apiFetch<{ ok: boolean; active: boolean }>(`/stories/${storyId}/agents/${runId}/cancel`, {
      method: 'POST',
    }),
  listActive: (storyId: string) =>
    apiFetch<ActiveAgent[]>(`/stories/${storyId}/active-agents`),
  // Live reasoning/tool trace for a running agent (NDJSON event stream).
  streamActivity: (storyId: string, agentName: string) =>
    fetchGetEventStream(`/stories/${storyId}/activity/${agentName}/stream`),
}
