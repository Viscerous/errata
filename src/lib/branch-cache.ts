import type { QueryClient } from '@tanstack/react-query'

/**
 * The active timeline (branch) changed — a switch, a delete that auto-switches
 * to another timeline, or a create that auto-switches to the new one.
 *
 * Branch-scoped queries are keyed by `branchId` (see `qk.*` in
 * `lib/query-keys.ts`), so once the `['branches']` index reports the new active
 * branch, every content key changes and React Query serves the correct timeline.
 *
 * This works only because the content endpoints are branch-addressed: each
 * branch-scoped query fetches with an explicit `?branch=` param, so a cache key
 * genuinely holds that branch's data. (They used to resolve "the active branch"
 * server-side, which made the keys unsound — a refetch returned whatever was
 * active, so keys ended up holding other timelines' prose, and switching served
 * that stale content until the view was remounted.) With addressed content,
 * poking the index is enough: keys flip and React Query fetches per branch.
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
