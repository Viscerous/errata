import { writeFile, rename, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withKeyLock } from './async-lock'

/**
 * Read and parse a JSON file, treating "not there" as a value rather than an
 * error. A file that exists but does not parse throws: it is the shape of a
 * half-written or corrupted file, and reporting it as absent invites the caller
 * to overwrite the only copy.
 *
 * Missing-ness is decided by the failed read, not a prior `existsSync` — the
 * gap between the two checks is long enough for the file to go away.
 */
export async function readJsonFile<T = unknown>(path: string): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Unable to read ${path}; the original file was left untouched`, { cause: error })
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`Unable to read ${path}; the original file was left untouched`, { cause: error })
  }
}

/**
 * `mode` sets POSIX permission bits on the temp file before the rename, so the
 * contents are never briefly world-readable. Windows honours only the read-only
 * bit, so there the file inherits the directory ACL and this does nothing.
 */
export async function writeJsonAtomic(path: string, value: unknown, mode?: number): Promise<void> {
  const tmpPath = `${path}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode })
  await rename(tmpPath, path)
}

/**
 * Serializes a complete filesystem transaction by its resolved resource path.
 * Callers must perform both the read and the write inside `fn`; atomic writes
 * alone only prevent torn files, not lost read-modify-write updates.
 */
export function withStorageLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`storage:${resolve(path)}`, fn)
}
