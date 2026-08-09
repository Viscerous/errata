import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempDir } from '../setup'
import { clearLogs, listLogs, saveLogEntry } from '@/server/logging/storage'

function makeEntry(index: number) {
  return {
    id: `log-${index}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    level: 'info' as const,
    component: 'rotation-test',
    message: `Entry ${index}`,
    extra: {},
  }
}

describe('application log storage', () => {
  it('preserves concurrent writes as complete JSONL entries', async () => {
    const temp = await createTempDir()
    try {
      await Promise.all(Array.from({ length: 100 }, (_, index) => saveLogEntry(temp.path, {
        id: `log-${index}`,
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
        level: 'info',
        component: 'concurrency-test',
        message: `Entry ${index}`,
        extra: {},
      })))

      const content = await readFile(join(temp.path, 'logs', 'app-0.jsonl'), 'utf-8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(100)
      const entries = lines.map(line => JSON.parse(line) as { id: string })
      expect(new Set(entries.map(entry => entry.id)).size).toBe(100)
    } finally {
      await temp.cleanup()
    }
  })

  // The copy-based shift never truncated the file it went on to write, so once
  // the logs filled every further line rotated again and the retained files
  // became near-identical copies of one unbounded log.
  it('rotates into a fresh file and keeps each retained generation distinct', async () => {
    const temp = await createTempDir()
    try {
      await clearLogs(temp.path)
      for (let index = 0; index < 1200; index += 1) {
        await saveLogEntry(temp.path, makeEntry(index))
      }

      const current = (await readFile(join(temp.path, 'logs', 'app-0.jsonl'), 'utf-8')).trim().split('\n')
      const previous = (await readFile(join(temp.path, 'logs', 'app-1.jsonl'), 'utf-8')).trim().split('\n')
      expect(current).toHaveLength(200)
      expect(previous).toHaveLength(1000)
      expect(JSON.parse(current[0]).id).toBe('log-1000')
      expect(JSON.parse(previous[0]).id).toBe('log-0')
      expect(existsSync(join(temp.path, 'logs', 'app-2.jsonl'))).toBe(false)

      const listed = await listLogs(temp.path, { component: 'rotation-test', limit: 2000 })
      expect(listed).toHaveLength(1200)
    } finally {
      await temp.cleanup()
    }
  })
})
