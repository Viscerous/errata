import { zipSync } from 'fflate'
import type { DroppedFileEntry, FileDropDetails } from './file-drop'

export type StoryFolderArchiveResult =
  | { kind: 'none' }
  | { kind: 'ambiguous'; directoryNames: string[] }
  | { kind: 'invalid'; directoryName: string; missing: 'meta.json' | 'branches.json' }
  | { kind: 'archive'; directoryName: string; file: File }

function normalizeRelativePath(entry: DroppedFileEntry): string | null {
  const path = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null
  return segments.join('/')
}

/**
 * Turn one dropped, unpacked Errata story directory into the same ZIP payload
 * accepted by the existing story importer. Non-story directories are ignored;
 * directories that contain half of the required archive markers get a useful
 * validation result instead.
 */
export async function createStoryArchiveFromFolderDrop(
  details: FileDropDetails,
): Promise<StoryFolderArchiveResult> {
  if (details.directoryNames.length === 0) return { kind: 'none' }

  const roots = details.directoryNames.map((directoryName) => {
    const paths = new Map<string, DroppedFileEntry>()
    for (const entry of details.entries) {
      if (entry.rootKind !== 'directory' || entry.rootName !== directoryName) continue
      const path = normalizeRelativePath(entry)
      if (path) paths.set(path, entry)
    }
    const root = directoryName.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return {
      directoryName,
      paths,
      hasMeta: paths.has(`${root}/meta.json`),
      hasBranches: paths.has(`${root}/branches.json`),
    }
  })
  const storyLikeRoots = roots.filter((root) => root.hasMeta || root.hasBranches)

  // A random directory should remain a no-op on the global drop surface.
  if (storyLikeRoots.length === 0) return { kind: 'none' }
  if (details.directoryNames.length !== 1 || details.topLevelEntryCount !== 1) {
    return { kind: 'ambiguous', directoryNames: details.directoryNames }
  }

  const [{ directoryName, paths, hasMeta, hasBranches }] = storyLikeRoots
  if (!hasMeta) return { kind: 'invalid', directoryName, missing: 'meta.json' }
  if (!hasBranches) return { kind: 'invalid', directoryName, missing: 'branches.json' }

  const archiveEntries: Record<string, Uint8Array> = {}
  await Promise.all([...paths.entries()].map(async ([path, entry]) => {
    archiveEntries[path] = new Uint8Array(await entry.file.arrayBuffer())
  }))

  const zipped = zipSync(archiveEntries)
  const zipBytes = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
  return {
    kind: 'archive',
    directoryName,
    file: new File([zipBytes], `${directoryName}.zip`, { type: 'application/zip' }),
  }
}
