import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * The active timeline (branch) for a story, read from the shared `['branches']`
 * query. Returns `undefined` until that query resolves — callers pass it
 * straight into `qk.*` key builders, so during the brief pre-load window a query
 * keys under `undefined`. That's safe: the server resolves the active branch on
 * its own, so the data is correct regardless, and `undefined` is a one-shot
 * sentinel that's never reused for a real branch once the index loads.
 *
 * Do NOT default this to `'main'` — that would cache a non-main branch's content
 * under the `'main'` key and surface it the next time `'main'` becomes active.
 */
export function useActiveBranchId(storyId: string | undefined): string | undefined {
  const { data } = useQuery({
    queryKey: ['branches', storyId],
    queryFn: () => api.branches.list(storyId!),
    enabled: !!storyId,
  })
  return data?.activeBranchId
}

type BranchId = string | undefined

/**
 * Query-key factory for per-timeline (branch-scoped) data. Every builder takes
 * `branchId` as a required argument, so it's impossible to construct a
 * branch-scoped key that forgets the branch — switching timelines then changes
 * the key and React Query serves/fetches the correct branch automatically.
 *
 * Shape convention: `[domain, storyId, branchId, ...rest]`. Invalidations that
 * should hit every branch use the branch-agnostic prefix `[domain, storyId]`
 * (see `invalidateStoryContent` / the fragment predicates), which still
 * prefix-matches these keys.
 *
 * Story-global data (`branches`, `story`, `stories`, `plugins`, config,
 * ErrataNet/account, character-chat conversations, agent blocks) is NOT
 * branch-scoped and does not belong here.
 */
export const qk = {
  proseChain: (storyId: string | undefined, branchId: BranchId) =>
    ['proseChain', storyId, branchId] as const,

  /** All fragments, or a single type when `type` is given. */
  fragments: (storyId: string | undefined, branchId: BranchId, type?: string) =>
    (type === undefined
      ? ['fragments', storyId, branchId]
      : ['fragments', storyId, branchId, type]) as (string | undefined)[],

  fragmentsArchived: (storyId: string | undefined, branchId: BranchId, type?: string) =>
    (type === undefined
      ? ['fragments-archived', storyId, branchId]
      : ['fragments-archived', storyId, branchId, type]) as (string | undefined)[],

  fragment: (storyId: string | undefined, branchId: BranchId, fragmentId: string | undefined | null) =>
    ['fragment', storyId, branchId, fragmentId] as const,

  fragmentVersions: (storyId: string | undefined, branchId: BranchId, fragmentId: string | undefined | null) =>
    ['fragment-versions', storyId, branchId, fragmentId] as const,

  folders: (storyId: string | undefined, branchId: BranchId) =>
    ['folders', storyId, branchId] as const,

  tags: (storyId: string | undefined, branchId: BranchId, fragmentId: string) =>
    ['tags', storyId, branchId, fragmentId] as const,

  refs: (storyId: string | undefined, branchId: BranchId, fragmentId: string) =>
    ['refs', storyId, branchId, fragmentId] as const,

  librarianStatus: (storyId: string | undefined, branchId: BranchId) =>
    ['librarian-status', storyId, branchId] as const,

  librarianAnalysisIndex: (storyId: string | undefined, branchId: BranchId) =>
    ['librarian-analysis-index', storyId, branchId] as const,

  librarianAnalyses: (storyId: string | undefined, branchId: BranchId) =>
    ['librarian-analyses', storyId, branchId] as const,

  librarianConversations: (storyId: string | undefined, branchId: BranchId) =>
    ['librarian-conversations', storyId, branchId] as const,

  librarianAgentRuns: (storyId: string | undefined, branchId: BranchId) =>
    ['librarian-agent-runs', storyId, branchId] as const,

  generationLogs: (storyId: string | undefined, branchId: BranchId) =>
    ['generation-logs', storyId, branchId] as const,

  generationLog: (storyId: string | undefined, branchId: BranchId, logId: string | null) =>
    ['generation-log', storyId, branchId, logId] as const,
} as const
