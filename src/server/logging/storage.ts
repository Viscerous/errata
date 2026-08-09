import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { LogEntry, LogSummary } from './types'
import { withKeyLock } from '../async-lock'

const MAX_LOGS_PER_FILE = 1000
const MAX_LOG_FILES = 5

function logsDir(dataDir: string): string {
  return join(dataDir, 'logs')
}

/** `app-0` is always the file being written; higher indexes are progressively older. */
function logFilePath(dataDir: string, index: number): string {
  return join(logsDir(dataDir), `app-${index}.jsonl`)
}

function logLockKey(dataDir: string): string {
  return `application-logs:${dataDir}`
}

async function readLines(path: string): Promise<string[]> {
  if (!existsSync(path)) return []
  return (await readFile(path, 'utf-8')).split('\n').filter((line) => line.trim())
}

/**
 * Lines already in `app-0`, per data dir. Counted from disk once per process and
 * tracked in memory after: deciding where to append by re-reading the logs made
 * every line written cost a full pass over all of them.
 */
const activeLineCount = new Map<string, number>()

/**
 * Drop the oldest file and shift the rest down by one. The previous copy-based
 * shift rewrote every retained file and never truncated the one it then wrote
 * to, so once the logs filled, every further line rotated again — five
 * near-identical copies of a log nothing was bounding.
 */
async function rotate(dataDir: string): Promise<void> {
  await rm(logFilePath(dataDir, MAX_LOG_FILES - 1), { force: true })
  for (let index = MAX_LOG_FILES - 2; index >= 0; index -= 1) {
    const from = logFilePath(dataDir, index)
    if (existsSync(from)) await rename(from, logFilePath(dataDir, index + 1))
  }
}

/**
 * Save a log entry to the application log file.
 * Uses rotating log files to prevent unbounded growth.
 */
export async function saveLogEntry(dataDir: string, entry: LogEntry): Promise<void> {
  return withKeyLock(logLockKey(dataDir), async () => {
    const dir = logsDir(dataDir)
    await mkdir(dir, { recursive: true })

    const path = logFilePath(dataDir, 0)
    let count = activeLineCount.get(dataDir) ?? (await readLines(path)).length
    if (count >= MAX_LOGS_PER_FILE) {
      await rotate(dataDir)
      count = 0
    }

    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf-8')
    activeLineCount.set(dataDir, count + 1)
  })
}

/**
 * List recent log entries with optional filtering.
 */
export async function listLogs(
  dataDir: string,
  options: {
    level?: 'debug' | 'info' | 'warn' | 'error'
    component?: string
    storyId?: string
    limit?: number
  } = {}
): Promise<LogSummary[]> {
  const { level, component, storyId, limit = 100 } = options
  const entries: LogSummary[] = []

  // Every retained file; the timestamp sort below decides the order.
  for (let i = MAX_LOG_FILES - 1; i >= 0; i--) {
    for (const line of await readLines(logFilePath(dataDir, i))) {
      try {
        const entry = JSON.parse(line) as LogEntry
        if (level && entry.level !== level) continue
        if (component && entry.component !== component) continue
        if (storyId && entry.storyId !== storyId) continue
        
        entries.push({
          id: entry.id,
          timestamp: entry.timestamp,
          level: entry.level,
          component: entry.component,
          message: entry.message,
          storyId: entry.storyId,
        })
      } catch {
        // Skip invalid lines
      }
    }
  }

  // Sort newest first and limit
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return entries.slice(0, limit)
}

/**
 * Get a specific log entry by ID.
 */
export async function getLogEntry(dataDir: string, logId: string): Promise<LogEntry | null> {
  for (let i = 0; i < MAX_LOG_FILES; i++) {
    for (const line of await readLines(logFilePath(dataDir, i))) {
      try {
        const entry = JSON.parse(line) as LogEntry
        if (entry.id === logId) return entry
      } catch {
        // Skip invalid lines
      }
    }
  }
  return null
}

/**
 * Clear all application logs.
 */
export async function clearLogs(dataDir: string): Promise<void> {
  return withKeyLock(logLockKey(dataDir), async () => {
    const dir = logsDir(dataDir)
    activeLineCount.delete(dataDir)
    if (!existsSync(dir)) return

    const entries = await readdir(dir)
    for (const entry of entries) {
      if (entry.startsWith('app-') && entry.endsWith('.jsonl')) {
        await writeFile(join(dir, entry), '', 'utf-8')
      }
    }
  })
}
