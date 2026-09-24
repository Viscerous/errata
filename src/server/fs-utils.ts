import { writeFile, rename, readFile, rm } from 'node:fs/promises'
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
  try {
    await renameOver(tmpPath, path)
  } catch (error) {
    await rm(tmpPath, { force: true })
    throw error
  }
}

/**
 * Windows refuses to replace a file another process holds open, such as a
 * virus scanner or the search indexer reading it the moment it was written,
 * and reports it as one of these codes. The hold lasts moments, so the rename
 * is retried briefly before the write is reported as failed.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 8

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= RENAME_ATTEMPTS || !code || !TRANSIENT_RENAME_CODES.has(code)) throw error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * 2 ** attempt))
    }
  }
}

/**
 * Serializes a complete filesystem transaction by its resolved resource path.
 * Callers must perform both the read and the write inside `fn`; atomic writes
 * alone only prevent torn files, not lost read-modify-write updates.
 */
export function withStorageLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`storage:${resolve(path)}`, fn)
}
