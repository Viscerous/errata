export interface DroppedFileEntry {
  file: File
  /** Path relative to the drop surface, including the top-level directory name. */
  relativePath: string
  /** Name of the top-level item that was dropped. */
  rootName: string
  rootKind: 'file' | 'directory'
}

export interface FileDropDetails {
  entries: DroppedFileEntry[]
  directoryNames: string[]
  topLevelEntryCount: number
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

function readDirectoryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

async function readAllDirectoryEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader()
  const entries: FileSystemEntry[] = []

  // Chromium returns directory contents in batches (typically at most 100).
  // Keep reading until an empty batch signals exhaustion.
  while (true) {
    const batch = await readDirectoryBatch(reader)
    if (batch.length === 0) return entries
    entries.push(...batch)
  }
}

async function walkEntry(
  entry: FileSystemEntry,
  rootName: string,
  rootKind: 'file' | 'directory',
  relativePath: string,
): Promise<DroppedFileEntry[]> {
  if (entry.isFile) {
    const file = await readFileEntry(entry as FileSystemFileEntry)
    return [{ file, relativePath, rootName, rootKind }]
  }

  if (!entry.isDirectory) return []

  const children = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry)
  const nested = await Promise.all(children.map((child) => (
    walkEntry(child, rootName, rootKind, `${relativePath}/${child.name}`)
  )))
  return nested.flat()
}

/**
 * Expand the top-level File System entries captured from a drop event. Directory
 * traversal is intentionally separate from the React hook so it can finish
 * after the browser releases the DataTransfer object.
 */
export async function collectDroppedFileDetails(
  rootEntries: FileSystemEntry[],
  fallbackFiles: File[],
): Promise<FileDropDetails> {
  if (rootEntries.length > 0) {
    const expanded = await Promise.all(rootEntries.map((entry) => (
      walkEntry(
        entry,
        entry.name,
        entry.isDirectory ? 'directory' : 'file',
        entry.name,
      )
    )))
    const entries = expanded.flat()
    return {
      entries,
      directoryNames: rootEntries.filter((entry) => entry.isDirectory).map((entry) => entry.name),
      topLevelEntryCount: rootEntries.length,
    }
  }

  // Fallback for browsers without webkitGetAsEntry(). A directory selected by
  // an input exposes webkitRelativePath; ordinary dropped files do not.
  const entries: DroppedFileEntry[] = fallbackFiles.map((file) => {
    const relativePath = file.webkitRelativePath || file.name
    const [rootName] = relativePath.replace(/\\/g, '/').split('/')
    return {
      file,
      relativePath,
      rootName,
      rootKind: file.webkitRelativePath ? 'directory' : 'file',
    }
  })
  const directoryNames = [...new Set(
    entries.filter((entry) => entry.rootKind === 'directory').map((entry) => entry.rootName),
  )]
  const topLevelFiles = entries.filter((entry) => entry.rootKind === 'file').length

  return {
    entries,
    directoryNames,
    topLevelEntryCount: directoryNames.length + topLevelFiles,
  }
}
