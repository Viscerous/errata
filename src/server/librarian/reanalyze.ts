import type { Fragment } from '../fragments/schema'
import { getStory } from '../fragments/storage'
import { getAgentBlockConfig } from '../agents/agent-block-storage'
import { clearAnalysisIndexEntry } from './storage'

/**
 * Automatic librarian analysis is disabled either via story settings
 * (`disableLibrarianAutoAnalysis`) or via the `librarian.analyze` agent
 * config's `disableAutoAnalysis` flag.
 */
export async function isLibrarianAutoAnalysisDisabled(
  dataDir: string,
  storyId: string,
): Promise<boolean> {
  const [story, librarianConfig] = await Promise.all([
    getStory(dataDir, storyId),
    getAgentBlockConfig(dataDir, storyId, 'librarian.analyze'),
  ])
  return story?.settings.disableLibrarianAutoAnalysis === true
    || librarianConfig.disableAutoAnalysis === true
}

/**
 * Shared post-edit hook for prose changes: unconditionally clears the stale
 * analysis index entry, then schedules librarian re-analysis unless automatic
 * analysis is disabled.
 *
 * Used by both the HTTP fragment routes and the LLM-facing write tools so
 * librarian/agent-driven prose edits invalidate analysis the same way manual
 * edits do.
 *
 * The scheduler is imported lazily to break the import cycle
 * llm/tools -> librarian/scheduler -> agents -> llm/tools.
 */
export async function reanalyzeAfterProseChange(
  dataDir: string,
  storyId: string,
  fragment: Fragment,
): Promise<void> {
  await clearAnalysisIndexEntry(dataDir, storyId, fragment.id).catch(() => {})
  if (await isLibrarianAutoAnalysisDisabled(dataDir, storyId)) return
  const { triggerLibrarian } = await import('./scheduler')
  await triggerLibrarian(dataDir, storyId, fragment)
}
