import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { z } from 'zod'
import { StoryMetaSchema, type StoryMeta } from '../src/server/fragments/schema'
import { GlobalConfigSchema, type GlobalConfig } from '../src/server/config/schema'

type StorySettings = StoryMeta['settings']

/**
 * Creates a default test story settings object.
 * Derived from the schema's own defaults so it can never drift behind a
 * newly added setting. Accepts optional overrides for any field.
 */
export function makeTestSettings(overrides?: Partial<StorySettings>): StorySettings {
  return {
    ...StoryMetaSchema.shape.settings.parse(undefined),
    ...overrides,
  }
}

/**
 * Creates a temporary directory for test isolation.
 * Returns the path and a cleanup function.
 */
export async function createTempDir(): Promise<{
  path: string
  cleanup: () => Promise<void>
}> {
  const path = await mkdtemp(join(tmpdir(), 'errata-test-'))
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  }
}

/**
 * Builds a full global config from partial input, filling every field
 * (providers/sharing/erratanet defaults) from the schema so test literals
 * never have to enumerate config sections they don't care about.
 */
export function makeTestGlobalConfig(
  overrides?: Partial<z.input<typeof GlobalConfigSchema>>,
): GlobalConfig {
  return GlobalConfigSchema.parse(overrides ?? {})
}

/**
 * Writes a minimal provider config to the test data directory.
 * Required because getModel() throws when no provider is configured.
 */
export async function seedTestProvider(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const config = makeTestGlobalConfig({
    providers: [{
      id: 'test-provider',
      name: 'Test',
      preset: 'custom',
      baseURL: 'http://localhost:0',
      apiKey: 'test-key',
      defaultModel: 'test-model',
      enabled: true,
      customHeaders: {},
      createdAt: new Date().toISOString(),
    }],
    defaultProviderId: 'test-provider',
  })
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(config))
}

afterEach(async () => {
  const { awaitPending, clearPending } = await import('../src/server/librarian/scheduler')
  await awaitPending()
  clearPending()
})
