import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { z } from 'zod'
import { StoryMetaSchema, type StoryMeta } from '../src/server/fragments/schema'
import { GlobalConfigSchema, type GlobalConfig } from '../src/server/config/schema'
import type {
  CharacterKnowledgeEntry,
  ContinuityView,
  LiveThreadEntry,
} from '../src/server/librarian/continuity-view'

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
 * A folded continuity view built in memory, for tests about how it *renders*
 * rather than how it is folded. Entries carry throwaway provenance so a caller
 * only has to state the part it is asserting on.
 */
export function makeContinuityView(overrides: Partial<ContinuityView> = {}): ContinuityView {
  const source = { sourceFragmentId: 'pr-0001', analysisId: 'la-1', narrativePosition: 1 }
  return {
    currentState: [{ ...source, stateKey: 'villain_location', subject: 'Villain location', value: 'the north tower' }],
    liveThreads: [{
      ...source,
      threadKey: 'who_sent_the_letter',
      label: 'Who sent the letter',
      relatedFragmentIds: [],
      visibility: 'foreground',
    }],
    characterKnowledge: [{
      ...source,
      characterId: 'ch-0001',
      knowledgeKey: 'key_missing',
      fact: 'The key is missing.',
      acquisition: 'witnessed',
    }],
    staleProjectionCount: 0,
    ...overrides,
  }
}

/** A live thread with throwaway provenance, for the render tests above. */
export function makeLiveThread(overrides: Partial<LiveThreadEntry> = {}): LiveThreadEntry {
  return {
    sourceFragmentId: 'pr-0001',
    analysisId: 'la-1',
    narrativePosition: 1,
    threadKey: 'a_thread',
    label: 'A thread',
    relatedFragmentIds: [],
    visibility: 'foreground',
    ...overrides,
  }
}

/** A knowledge entry with throwaway provenance, for the render tests above. */
export function makeCharacterKnowledge(overrides: Partial<CharacterKnowledgeEntry> = {}): CharacterKnowledgeEntry {
  return {
    sourceFragmentId: 'pr-0001',
    analysisId: 'la-1',
    narrativePosition: 1,
    characterId: 'ch-0001',
    knowledgeKey: 'a_fact',
    fact: 'A fact.',
    acquisition: 'witnessed',
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
 *
 * Goes through saveGlobalConfig rather than writing config.json directly, so the
 * fixture lands in the same two-file shape production uses — writing the file by
 * hand would leave every suite exercising the legacy inline-secret fallback.
 */
export async function seedTestProvider(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const { saveGlobalConfig } = await import('../src/server/config/storage')
  await saveGlobalConfig(dataDir, makeTestGlobalConfig({
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
  }))
}

afterEach(async () => {
  const { awaitPending, clearPending } = await import('../src/server/librarian/scheduler')
  await awaitPending()
  clearPending()
})
