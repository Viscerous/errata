import type { QueryClient } from '@tanstack/react-query'

/**
 * The active timeline (branch) changed — a switch, or a delete/create that
 * auto-switches.
 *
 * Branch-scoped queries are keyed by `branchId` (see `qk.*` in
 * `lib/query-keys.ts`), so once the `['branches']` index reports the new active
 * branch, every content key changes and React Query serves the right timeline.
 * Poking the index is enough only because content endpoints are branch-addressed:
 * each query fetches with an explicit `?branch=`, so a key genuinely holds that
 * branch's data. An endpoint that resolves "the active branch" server-side
 * instead makes the keys unsound — a refetch fills them with whatever is active.
 */
export function onActiveBranchChanged(queryClient: QueryClient, storyId: string): void {
  queryClient.invalidateQueries({ queryKey: ['branches', storyId] })
}

/**
 * The story's prose changed — a passage added, removed, reordered, regenerated,
 * imported, or a chapter marker moved. Refreshes the passage list and every
 * fragment list in one call, so call sites stop hand-spelling the pair.
 *
 * The branch-agnostic prefixes invalidate across every branch, which spares the
 * call site from knowing the current `branchId` and is harmless since only the
 * active branch's queries are mounted. Use `onActiveBranchChanged` when the
 * active timeline changed instead.
 */
export function invalidateStoryContent(queryClient: QueryClient, storyId: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] }),
    queryClient.invalidateQueries({ queryKey: ['fragments', storyId] }),
  ]).then(() => undefined)
}
