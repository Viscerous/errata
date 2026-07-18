import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import {
  collectDroppedFileDetails,
  type DroppedFileEntry,
  type FileDropDetails,
} from '@/lib/file-drop'
import { createStoryArchiveFromFolderDrop } from '@/lib/story-folder-import'

function droppedFile(
  relativePath: string,
  content: string,
  rootName = 'viscerous-victis',
): DroppedFileEntry {
  return {
    file: new File([content], relativePath.split('/').at(-1)!),
    relativePath,
    rootName,
    rootKind: 'directory',
  }
}

function folderDetails(entries: DroppedFileEntry[], directoryName = 'viscerous-victis'): FileDropDetails {
  return {
    entries,
    directoryNames: [directoryName],
    topLevelEntryCount: 1,
  }
}

function fakeFileEntry(name: string, content: string): FileSystemFileEntry {
  const file = new File([content], name)
  return {
    name,
    fullPath: `/${name}`,
    isFile: true,
    isDirectory: false,
    file: (success: FileCallback) => success(file),
  } as unknown as FileSystemFileEntry
}

function fakeDirectoryEntry(
  name: string,
  batches: FileSystemEntry[][],
): FileSystemDirectoryEntry {
  return {
    name,
    fullPath: `/${name}`,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let index = 0
      return {
        readEntries: (success: FileSystemEntriesCallback) => success(batches[index++] ?? []),
      }
    },
  } as unknown as FileSystemDirectoryEntry
}

describe('unpacked story folder import', () => {
  it('recursively expands directory entries and drains every reader batch', async () => {
    const nested = fakeDirectoryEntry('branches', [
      [fakeFileEntry('branches.json', '{}')],
      [],
    ])
    const root = fakeDirectoryEntry('viscerous-victis', [
      [fakeFileEntry('meta.json', '{}')],
      [nested],
      [],
    ])

    const result = await collectDroppedFileDetails([root], [])

    expect(result.directoryNames).toEqual(['viscerous-victis'])
    expect(result.topLevelEntryCount).toBe(1)
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      'viscerous-victis/meta.json',
      'viscerous-victis/branches/branches.json',
    ])
  })

  it('packages a complete story directory with its relative paths intact', async () => {
    const result = await createStoryArchiveFromFolderDrop(folderDetails([
      droppedFile('viscerous-victis/meta.json', '{"name":"Majesteit"}'),
      droppedFile('viscerous-victis/branches.json', '{"branches":[]}'),
      droppedFile('viscerous-victis/branches/master/fragments/ch-victoria.json', '{"id":"ch-victoria"}'),
    ]))

    expect(result.kind).toBe('archive')
    if (result.kind !== 'archive') return

    expect(result.file.name).toBe('viscerous-victis.zip')
    const files = unzipSync(new Uint8Array(await result.file.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual([
      'viscerous-victis/branches.json',
      'viscerous-victis/branches/master/fragments/ch-victoria.json',
      'viscerous-victis/meta.json',
    ])
    expect(new TextDecoder().decode(files['viscerous-victis/meta.json'])).toBe('{"name":"Majesteit"}')
  })

  it('quietly ignores an unrelated directory', async () => {
    const result = await createStoryArchiveFromFolderDrop(folderDetails([
      droppedFile('viscerous-victis/README.md', '# Notes'),
    ]))

    expect(result).toEqual({ kind: 'none' })
  })

  it('reports a story-like directory missing one required root file', async () => {
    const result = await createStoryArchiveFromFolderDrop(folderDetails([
      droppedFile('viscerous-victis/meta.json', '{}'),
    ]))

    expect(result).toEqual({
      kind: 'invalid',
      directoryName: 'viscerous-victis',
      missing: 'branches.json',
    })
  })

  it('rejects multiple top-level items instead of importing a parent bundle shelf', async () => {
    const result = await createStoryArchiveFromFolderDrop({
      entries: [
        droppedFile('viscerous-victis/meta.json', '{}'),
        droppedFile('viscerous-cabinet/meta.json', '{}', 'viscerous-cabinet'),
      ],
      directoryNames: ['viscerous-victis', 'viscerous-cabinet'],
      topLevelEntryCount: 2,
    })

    expect(result).toEqual({
      kind: 'ambiguous',
      directoryNames: ['viscerous-victis', 'viscerous-cabinet'],
    })
  })

  it('quietly ignores multiple unrelated directories', async () => {
    const result = await createStoryArchiveFromFolderDrop({
      entries: [
        droppedFile('notes/README.md', '# Notes', 'notes'),
        droppedFile('sources/book.txt', 'Text', 'sources'),
      ],
      directoryNames: ['notes', 'sources'],
      topLevelEntryCount: 2,
    })

    expect(result).toEqual({ kind: 'none' })
  })
})
