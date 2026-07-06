import type { Fragment, StoryMeta } from '../fragments/schema'
import { listFragments } from '../fragments/storage'
import { customContextFragmentTypes } from '../llm/fragment-context-blocks'
import type { ContextSelectionSource } from '../llm/context-selection'

export type FragmentCandidateSource = Extract<
  ContextSelectionSource,
  'current-observation' | 'writer-context' | 'router'
>

export interface FragmentCandidate {
  fragmentId: string
  source: FragmentCandidateSource
  reason?: string
  score?: number
}

export interface MergedFragmentCandidate {
  fragmentId: string
  sources: FragmentCandidateSource[]
  reasons?: string[]
  score?: number
}

const ROUTABLE_BUILTIN_TYPES = new Set(['character', 'knowledge'])
function routableTypes(story: StoryMeta): Set<string> {
  return new Set([
    ...ROUTABLE_BUILTIN_TYPES,
    ...customContextFragmentTypes(story).map((def) => def.type),
  ])
}

export function isRoutableMemoryFragment(story: StoryMeta, fragment: Fragment): boolean {
  return routableTypes(story).has(fragment.type)
}

export async function listRoutableMemoryFragments(
  dataDir: string,
  storyId: string,
  story: StoryMeta,
): Promise<Fragment[]> {
  const all = await listFragments(dataDir, storyId)
  return all.filter((fragment) => isRoutableMemoryFragment(story, fragment))
}

function writerContextIds(fragment: Fragment | null | undefined): string[] {
  return Array.isArray(fragment?.meta?.writerContextIds)
    ? (fragment.meta.writerContextIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : []
}

export function observationFragmentCandidates(params: {
  mentionedFragmentIds: string[]
  candidateFragmentIds: string[]
}): FragmentCandidate[] {
  const out: FragmentCandidate[] = []
  for (const fragmentId of params.mentionedFragmentIds) {
    out.push({
      fragmentId,
      source: 'current-observation',
      reason: 'The observation pass reported a mention.',
    })
  }
  for (const fragmentId of params.candidateFragmentIds) {
    out.push({
      fragmentId,
      source: 'current-observation',
      reason: 'The online analysis requested full memory context.',
    })
  }
  return out
}

export function writerProvenanceFragmentCandidates(
  story: StoryMeta,
  proseFragment: Fragment | null | undefined,
  fragments: Fragment[],
): FragmentCandidate[] {
  const ids = new Set(writerContextIds(proseFragment))
  return fragments
    .filter((fragment) => ids.has(fragment.id) && isRoutableMemoryFragment(story, fragment))
    .map((fragment) => ({
      fragmentId: fragment.id,
      source: 'writer-context' as const,
      reason: 'The writer used this fragment when drafting the prose.',
    }))
}

export function mergeFragmentCandidates(...groups: FragmentCandidate[][]): MergedFragmentCandidate[] {
  const byId = new Map<string, MergedFragmentCandidate>()
  for (const candidate of groups.flat()) {
    const existing = byId.get(candidate.fragmentId)
    if (!existing) {
      byId.set(candidate.fragmentId, {
        fragmentId: candidate.fragmentId,
        sources: [candidate.source],
        ...(candidate.reason ? { reasons: [candidate.reason] } : {}),
        ...(candidate.score !== undefined ? { score: candidate.score } : {}),
      })
      continue
    }

    if (!existing.sources.includes(candidate.source)) {
      existing.sources.push(candidate.source)
    }
    if (candidate.reason) {
      const reasons = existing.reasons ?? []
      if (!reasons.includes(candidate.reason)) reasons.push(candidate.reason)
      existing.reasons = reasons
    }
    if (candidate.score !== undefined) {
      existing.score = Math.max(existing.score ?? Number.NEGATIVE_INFINITY, candidate.score)
    }
  }
  return [...byId.values()]
}

export function fragmentCandidateIds(candidates: MergedFragmentCandidate[]): string[] {
  return candidates.map((candidate) => candidate.fragmentId)
}
