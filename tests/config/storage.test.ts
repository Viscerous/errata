import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addProvider, getGlobalConfig } from '@/server/config/storage'
import type { ProviderConfig } from '@/server/config/schema'
import { createTempDir } from '../setup'

describe('global configuration storage', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const temp = await createTempDir()
    dataDir = temp.path
    cleanup = temp.cleanup
  })

  afterEach(async () => cleanup())

  const provider = (id: string): ProviderConfig => ({
    id,
    name: id,
    preset: 'custom',
    baseURL: 'https://example.com/v1',
    apiKey: 'secret',
    defaultModel: 'model',
    enabled: true,
    customHeaders: {},
    temperature: undefined,
    createdAt: new Date().toISOString(),
  })

  it('serializes concurrent provider additions', async () => {
    await Promise.all([
      addProvider(dataDir, provider('provider-a')),
      addProvider(dataDir, provider('provider-b')),
    ])
    const config = await getGlobalConfig(dataDir)
    expect(config.providers.map((entry) => entry.id).sort()).toEqual(['provider-a', 'provider-b'])
  })

  it('does not replace a corrupt config with defaults', async () => {
    const path = join(dataDir, 'config.json')
    await writeFile(path, '{broken', 'utf-8')
    await expect(getGlobalConfig(dataDir)).rejects.toThrow('original file was left untouched')
    await expect(readFile(path, 'utf-8')).resolves.toBe('{broken')
  })
})
