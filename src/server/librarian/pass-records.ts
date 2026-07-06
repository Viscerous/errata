import type { LibrarianPassRecord } from './storage'

export function passRecord(params: {
  name: LibrarianPassRecord['name']
  status: LibrarianPassRecord['status']
  startedAt: string
  durationMs?: number
  modelId?: string
  stepCount?: number
  finishReason?: string
  reason?: string
  error?: string
  diagnostics?: Record<string, unknown>
}): LibrarianPassRecord {
  return {
    name: params.name,
    status: params.status,
    startedAt: params.startedAt,
    ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.stepCount !== undefined ? { stepCount: params.stepCount } : {}),
    ...(params.finishReason ? { finishReason: params.finishReason } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.error ? { error: params.error } : {}),
    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
  }
}
