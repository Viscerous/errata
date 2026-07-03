import type { QueryClient } from '@tanstack/react-query'

/**
 * The active timeline (branch) changed — a switch, a delete that auto-switches
 * to another timeline, or a create that auto-switches to the new one.
 *
 * Branch-scoped queries are keyed by `branchId` (see `qk.*` in
 * `lib/query-keys.ts`), so once the `['branches']` index refetches and reports
 * the new active branch, every content key changes and React Query serves or
 * fetches the correct timeline on its own. That makes switching back to a
 * previously-viewed timeline instant (its cache is still there) and means we no
 * longer need to blow away content caches by hand.
 *
 * A deleted branch's cached queries simply become unobserved and are garbage
 * collected; `main` (the auto-switch target) is unmodified by the delete, so its
 * cache is still valid to show immediately.
 */
export function onActiveBranchChanged(queryClient: QueryClient, storyId: string): void {
  queryClient.invalidateQueries({ queryKey: ['branches', storyId] })
}

/**
 * The story's prose changed — a passage was added, removed, reordered,
 * regenerated, imported, or a chapter marker moved. Refresh the passage list
 * (`proseChain`) and every fragment list (`fragments`, all types/branches) in
 * one call so call sites stop hand-spelling the same pair of invalidations.
 *
 * Uses branch-agnostic prefixes, so it invalidates the affected caches across
 * every branch (harmless — only the active branch's queries are mounted) without
 * needing the current `branchId` at the call site.
 *
 * This is the "prose content changed" event; use `onActiveBranchChanged` when
 * the *active timeline* changed instead.
 */
export function invalidateStoryContent(queryClient: QueryClient, storyId: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] }),
    queryClient.invalidateQueries({ queryKey: ['fragments', storyId] }),
  ]).then(() => undefined)
}
