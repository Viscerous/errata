import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Fragment, FragmentVersion, StoryMeta } from './schema'
import { getContentRoot, initBranches } from './branches'
import { createLogger } from '../logging'
import { writeJsonAtomic } from '../fs-utils'

const requestLogger = createLogger('fragment-storage')

// --- Path helpers ---

function storiesDir(dataDir: string) {
  return join(dataDir, 'stories')
}

function storyDir(dataDir: string, storyId: string) {
  return join(storiesDir(dataDir), storyId)
}

function storyMetaPath(dataDir: string, storyId: string) {
  return join(storyDir(dataDir, storyId), 'meta.json')
}

async function fragmentsDir(dataDir: string, storyId: string) {
  const root = await getContentRoot(dataDir, storyId)
  return join(root, 'fragments')
}

async function fragmentPath(dataDir: string, storyId: string, fragmentId: string) {
  const dir = await fragmentsDir(dataDir, storyId)
  return join(dir, `${fragmentId}.json`)
}

// --- JSON read/write helpers ---

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as T
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeJsonAtomic(path, data)
}

function normalizeFragment(fragment: Fragment | null): Fragment | null {
  if (!fragment) return null
  const version = fragment.version ?? 1
  const rawVersions = Array.isArray(fragment.versions) ? fragment.versions : []
  // Invariant: the live content is always represented as a version, so switching
  // between versions is a pointer move (no new snapshot). Legacy fragments stored
  // history as past-only with the current content outside the array — fold the
  // current content in as its own version here, idempotently.
  const versions = rawVersions.some((v) => v.version === version)
    ? rawVersions
    : [
        ...rawVersions,
        {
          version,
          name: fragment.name,
          description: fragment.description,
          content: fragment.content,
          createdAt: fragment.updatedAt ?? fragment.createdAt ?? new Date().toISOString(),
        },
      ]
  return {
    ...fragment,
    archived: fragment.archived ?? false,
    version,
    versions,
  }
}

// --- Story CRUD ---

export async function createStory(
  dataDir: string,
  story: StoryMeta
): Promise<void> {
  const dir = storyDir(dataDir, story.id)
  await mkdir(dir, { recursive: true })
  await initBranches(dataDir, story.id)
  await writeJson(storyMetaPath(dataDir, story.id), story)
}

export async function getStory(
  dataDir: string,
  storyId: string
): Promise<StoryMeta | null> {
  return readJson<StoryMeta>(storyMetaPath(dataDir, storyId))
}

export async function listStories(dataDir: string): Promise<StoryMeta[]> {
  const dir = storiesDir(dataDir)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir, { withFileTypes: true })
  const stories: StoryMeta[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const meta = await getStory(dataDir, entry.name)
      if (meta) stories.push(meta)
    }
  }

  return stories
}

export async function updateStory(
  dataDir: string,
  story: StoryMeta
): Promise<void> {
  await writeJson(storyMetaPath(dataDir, story.id), story)
}

export async function deleteStory(
  dataDir: string,
  storyId: string
): Promise<void> {
  const dir = storyDir(dataDir, storyId)
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true })
  }
}

// --- Fragment CRUD ---

export async function createFragment(
  dataDir: string,
  storyId: string,
  fragment: Fragment
): Promise<void> {
  const dir = await fragmentsDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  const normalized = normalizeFragment(fragment)
  await writeJson(await fragmentPath(dataDir, storyId, fragment.id), normalized)
}

export async function getFragment(
  dataDir: string,
  storyId: string,
  fragmentId: string
): Promise<Fragment | null> {
  const fragment = await readJson<Fragment>(await fragmentPath(dataDir, storyId, fragmentId))
  return normalizeFragment(fragment)
}

export async function listFragments(
  dataDir: string,
  storyId: string,
  type?: string,
  opts?: { includeArchived?: boolean }
): Promise<Fragment[]> {
  const dir = await fragmentsDir(dataDir, storyId)
  if (!existsSync(dir)) return []

  const includeArchived = opts?.includeArchived ?? false
  const entries = await readdir(dir)
  const fragments: Fragment[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue

    const rawFragment = await readJson<Fragment>(join(dir, entry))
    const fragment = normalizeFragment(rawFragment)
    if (fragment) {
      if (type && fragment.type !== type) continue
      // Skip archived fragments unless caller opts in
      if (!includeArchived && fragment.archived) continue
      fragments.push(fragment)
    }
  }

  return fragments
}

export async function archiveFragment(
  dataDir: string,
  storyId: string,
  fragmentId: string
): Promise<Fragment | null> {
  const fragment = await getFragment(dataDir, storyId, fragmentId)
  if (!fragment) return null
  const updated: Fragment = {
    ...fragment,
    archived: true,
    updatedAt: new Date().toISOString(),
  }
  await writeJson(await fragmentPath(dataDir, storyId, fragmentId), updated)
  return updated
}

export async function restoreFragment(
  dataDir: string,
  storyId: string,
  fragmentId: string
): Promise<Fragment | null> {
  const fragment = await getFragment(dataDir, storyId, fragmentId)
  if (!fragment) return null
  const updated: Fragment = {
    ...fragment,
    archived: false,
    updatedAt: new Date().toISOString(),
  }
  await writeJson(await fragmentPath(dataDir, storyId, fragmentId), updated)
  return updated
}

export async function updateFragment(
  dataDir: string,
  storyId: string,
  fragment: Fragment
): Promise<void> {
  const normalized = normalizeFragment(fragment)
  const path = await fragmentPath(dataDir, storyId, fragment.id)
  requestLogger.info('Updating fragment', { path })
  await writeJson(path, normalized)
}

export async function updateFragmentVersioned(
  dataDir: string,
  storyId: string,
  fragmentId: string,
  updates: Partial<Pick<Fragment, 'name' | 'description' | 'content'>>,
  opts?: { reason?: string }
): Promise<Fragment | null> {
  const existing = await getFragment(dataDir, storyId, fragmentId)
  if (!existing) return null

  const nextName = updates.name ?? existing.name
  const nextDescription = updates.description ?? existing.description
  const nextContent = updates.content ?? existing.content
  const hasVersionedChange =
    nextName !== existing.name ||
    nextDescription !== existing.description ||
    nextContent !== existing.content

  const now = new Date().toISOString()
  // existing.versions already contains the current version (normalizeFragment).
  // An edit appends the new content as a fresh version and points at it; numbering
  // is max+1 so it never collides even when editing after switching to an older one.
  const maxVersion = (existing.versions ?? []).reduce((m, v) => Math.max(m, v.version), 0)
  const newVersion = maxVersion + 1
  const updated: Fragment = hasVersionedChange
    ? {
        ...existing,
        name: nextName,
        description: nextDescription,
        content: nextContent,
        updatedAt: now,
        version: newVersion,
        versions: [
          ...(existing.versions ?? []),
          {
            version: newVersion,
            name: nextName,
            description: nextDescription,
            content: nextContent,
            createdAt: now,
            ...(opts?.reason ? { reason: opts.reason } : {}),
          },
        ],
      }
    : {
        ...existing,
        name: nextName,
        description: nextDescription,
        content: nextContent,
        updatedAt: now,
      }

  await updateFragment(dataDir, storyId, updated)
  return updated
}

export async function listFragmentVersions(
  dataDir: string,
  storyId: string,
  fragmentId: string
): Promise<FragmentVersion[] | null> {
  const fragment = await getFragment(dataDir, storyId, fragmentId)
  if (!fragment) return null
  return [...(fragment.versions ?? [])]
}

/**
 * Make a stored version current. This is a pointer move: the version history is
 * unchanged, only which version is active. With no targetVersion it steps back to
 * the previous version (the highest number below the current) — the "undo" path.
 * Returns null if the fragment, the target, or (for undo) a previous version is absent.
 */
export async function revertFragmentToVersion(
  dataDir: string,
  storyId: string,
  fragmentId: string,
  targetVersion?: number
): Promise<Fragment | null> {
  const fragment = await getFragment(dataDir, storyId, fragmentId)
  if (!fragment) return null

  const versions = fragment.versions ?? []
  const resolvedTarget = targetVersion === undefined
    ? versions
        .map((v) => v.version)
        .filter((n) => n < (fragment.version ?? 1))
        .reduce<number | null>((max, n) => (max === null || n > max ? n : max), null)
    : targetVersion
  if (resolvedTarget === null || resolvedTarget === undefined) return null

  const snapshot = versions.find((v) => v.version === resolvedTarget)
  if (!snapshot) return null

  const updated: Fragment = {
    ...fragment,
    name: snapshot.name,
    description: snapshot.description,
    content: snapshot.content,
    updatedAt: new Date().toISOString(),
    version: resolvedTarget,
  }

  await updateFragment(dataDir, storyId, updated)
  return updated
}

/**
 * Remove a single snapshot from a fragment's version history (for tidying up).
 * The current version cannot be deleted — switch to another version first.
 * Returns null if the fragment is absent, the version is missing, or it is current.
 */
export async function deleteFragmentVersion(
  dataDir: string,
  storyId: string,
  fragmentId: string,
  targetVersion: number
): Promise<Fragment | null> {
  const fragment = await getFragment(dataDir, storyId, fragmentId)
  if (!fragment) return null

  const versions = fragment.versions ?? []
  if (!versions.some((v) => v.version === targetVersion)) return null
  if ((fragment.version ?? 1) === targetVersion) return null

  const updated: Fragment = {
    ...fragment,
    versions: versions.filter((v) => v.version !== targetVersion),
  }

  await updateFragment(dataDir, storyId, updated)
  return updated
}

export async function deleteFragment(
  dataDir: string,
  storyId: string,
  fragmentId: string
): Promise<void> {
  const path = await fragmentPath(dataDir, storyId, fragmentId)
  if (existsSync(path)) {
    await rm(path)
  }
}

/**
 * @deprecated TRANSITIONAL. Delete alongside `StoryMeta.summary` once all
 * live stories have been migrated.
 *
 * One-shot migration for the summary-fragments feature. Converts any
 * non-empty `story.summary` string into a single summary fragment, then
 * clears the field. Idempotent — running again with no `story.summary`
 * is a no-op. Existing summary fragments are never overwritten.
 *
 * Called at the top of `buildContextState` and `applyDeferredSummaries`
 * so legacy content surfaces through the new fragment path on first use.
 */
export async function migrateStoryToSummaryFragments(
  dataDir: string,
  storyId: string,
): Promise<{ migrated: boolean; fragmentId?: string }> {
  const story = await getStory(dataDir, storyId)
  if (!story) return { migrated: false }

  const legacy = typeof story.summary === 'string' ? story.summary.trim() : ''
  if (!legacy) return { migrated: false }

  const existing = await listFragments(dataDir, storyId, 'summary', { includeArchived: true })
  if (existing.length > 0) {
    // Already migrated or summaries exist from the new flow. Clear the
    // legacy field so it doesn't drift further.
    await updateStory(dataDir, { ...story, summary: '', updatedAt: new Date().toISOString() })
    return { migrated: false }
  }

  const { generateFragmentId } = await import('@/lib/fragment-ids')
  const now = new Date().toISOString()
  const fragment: Fragment = {
    id: generateFragmentId('summary'),
    type: 'summary',
    name: 'Story summary',
    description: 'Rolling summary migrated from the legacy story.summary field.',
    content: legacy,
    tags: [],
    refs: [],
    sticky: false,
    placement: 'system',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {
      isEraSummary: true,
      chapterId: null,
      migratedFromLegacy: true,
    },
    archived: false,
    version: 1,
    versions: [],
  }

  await createFragment(dataDir, storyId, fragment)
  await updateStory(dataDir, { ...story, summary: '', updatedAt: now })

  requestLogger.info('Migrated legacy story.summary to summary fragment', {
    storyId,
    fragmentId: fragment.id,
    length: legacy.length,
  })

  return { migrated: true, fragmentId: fragment.id }
}
