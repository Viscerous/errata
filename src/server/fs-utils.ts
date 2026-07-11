import { writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withKeyLock } from './async-lock'

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8')
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
