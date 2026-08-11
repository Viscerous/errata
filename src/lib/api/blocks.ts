import { apiFetch } from './client'
import type { ExportedConfigs, ImportConfigsPayload } from './types'

/**
 * Shared block utilities — script eval and config import/export. Per-agent block
 * configuration lives in `agentBlocks` (see agent-blocks.ts), which is the single
 * source of truth for generation-writer blocks.
 */
export const blocks = {
  evalScript: (storyId: string, content: string) =>
    apiFetch<{ result: string | null; error: string | null }>(
      `/stories/${storyId}/blocks/eval-script`,
      { method: 'POST', body: JSON.stringify({ content }) },
    ),

  exportConfigs: (storyId: string) =>
    apiFetch<ExportedConfigs>(`/stories/${storyId}/export-configs`),

  importConfigs: (storyId: string, data: ImportConfigsPayload) =>
    apiFetch<{ ok: boolean }>(`/stories/${storyId}/import-configs`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
}
