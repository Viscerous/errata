import { apiFetch, fetchGetEventStream } from './client'

export interface ActiveAgent {
  id: string
  storyId: string
  agentName: string
  startedAt: string
}

export const agents = {
  listActive: (storyId: string) =>
    apiFetch<ActiveAgent[]>(`/stories/${storyId}/active-agents`),
  // Live reasoning/tool trace for a running agent (NDJSON event stream).
  streamActivity: (storyId: string, agentName: string) =>
    fetchGetEventStream(`/stories/${storyId}/activity/${agentName}/stream`),
}
