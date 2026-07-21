import { fetchEventStream } from './client'
import type { GenerationLogSummary, GenerationLog, SuggestionDirection, Clarification } from './types'

/** Optional clarify-before-generate answers carried into a (re)generation request. */
export interface ClarifyOpts {
  clarifications?: Clarification[]
  clarifyRound?: number
}

export interface GenerationRequestOpts extends ClarifyOpts {
  runId?: string
  branchId?: string
}

export function clarifyBody(opts?: ClarifyOpts): Record<string, unknown> {
  const clarifications = opts?.clarifications ?? []
  const round = opts?.clarifyRound ?? 0
  // Send the round even with no clarifications so "write anyway" (a high
  // force-proceed round) actually withholds the ask tool server-side. Without
  // this, skipping on the first round would just re-ask.
  if (!clarifications.length && round <= 0) return {}
  return { clarifications, clarifyRound: round }
}

function generationRequestBody(opts?: GenerationRequestOpts): Record<string, unknown> {
  return {
    ...clarifyBody(opts),
    ...(opts?.runId ? { runId: opts.runId } : {}),
    ...(opts?.branchId ? { branchId: opts.branchId } : {}),
  }
}

export const generation = {
  /** Stream prose generation (returns ReadableStream of ChatEvent) */
  stream: (storyId: string, input: string, signal?: AbortSignal, opts?: GenerationRequestOpts) =>
    fetchEventStream(`/stories/${storyId}/generate`, { input, saveResult: false, ...generationRequestBody(opts) }, signal),
  /** Generate and save as a new prose fragment */
  generateAndSave: (storyId: string, input: string, signal?: AbortSignal, opts?: GenerationRequestOpts) =>
    fetchEventStream(`/stories/${storyId}/generate`, { input, saveResult: true, ...generationRequestBody(opts) }, signal),
  /** Regenerate an existing fragment with a new prompt */
  regenerate: (storyId: string, fragmentId: string, input: string, signal?: AbortSignal, opts?: GenerationRequestOpts) =>
    fetchEventStream(`/stories/${storyId}/generate`, { input, saveResult: true, mode: 'regenerate', fragmentId, ...generationRequestBody(opts) }, signal),
  /** Refine an existing fragment with instructions */
  refine: (storyId: string, fragmentId: string, input: string, signal?: AbortSignal, opts?: GenerationRequestOpts) =>
    fetchEventStream(`/stories/${storyId}/generate`, { input, saveResult: true, mode: 'refine', fragmentId, ...generationRequestBody(opts) }, signal),
  /** Explicit server-side cancellation; transport abort remains a fallback. */
  cancel: (storyId: string, runId: string) =>
    apiFetch<{ ok: boolean; active: boolean }>(`/stories/${storyId}/generations/${runId}/cancel`, { method: 'POST' }),
  /** Get AI-generated story direction proposals */
  proposeDirections: (storyId: string, count?: number) =>
    apiFetch<{ suggestions: SuggestionDirection[] }>(
      `/stories/${storyId}/propose-directions`,
      { method: 'POST', body: JSON.stringify({ count }) },
    ),
  /** List generation log summaries (newest first) */
  listLogs: (storyId: string) =>
    apiFetch<GenerationLogSummary[]>(`/stories/${storyId}/generation-logs`),
  /** Get a full generation log by ID */
  getLog: (storyId: string, logId: string) =>
    apiFetch<GenerationLog>(`/stories/${storyId}/generation-logs/${logId}`),
}

// Import apiFetch for the non-streaming methods
import { apiFetch } from './client'
