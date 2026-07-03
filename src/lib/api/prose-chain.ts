import { apiFetch } from './client'
import type { ProseChain } from './types'

export const proseChain = {
  // `branchId` addresses a specific timeline; pass the same branchId the query is
  // keyed under so the cache entry holds that branch's chain (see `qk`).
  get: (storyId: string, branchId?: string) =>
    apiFetch<ProseChain>(`/stories/${storyId}/prose-chain${branchId ? `?branch=${encodeURIComponent(branchId)}` : ''}`),
  addSection: (storyId: string, fragmentId: string) =>
    apiFetch<{ ok: boolean }>(`/stories/${storyId}/prose-chain`, {
      method: 'POST',
      body: JSON.stringify({ fragmentId }),
    }),
  switchVariation: (storyId: string, sectionIndex: number, fragmentId: string) =>
    apiFetch<{ ok: boolean }>(`/stories/${storyId}/prose-chain/${sectionIndex}/switch`, {
      method: 'POST',
      body: JSON.stringify({ fragmentId }),
    }),
  removeSection: (storyId: string, sectionIndex: number) =>
    apiFetch<{ ok: boolean; archivedFragmentIds: string[] }>(`/stories/${storyId}/prose-chain/${sectionIndex}`, {
      method: 'DELETE',
    }),
  reorder: (storyId: string, order: number[]) =>
    apiFetch<{ ok: boolean }>(`/stories/${storyId}/prose-chain/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ order }),
    }),
}
