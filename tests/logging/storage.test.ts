import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempDir } from '../setup'
import { saveLogEntry } from '@/server/logging/storage'

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
})
