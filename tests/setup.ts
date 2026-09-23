import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { z } from 'zod'
import { StoryMetaSchema, type StoryMeta } from '@/contracts/story'
import { GlobalConfigSchema, type GlobalConfig } from '../src/server/config/schema'
import type { ContinuityView, LiveThreadEntry } from '../src/server/librarian/continuity-view'
import {
  liveStateItemId,
  type FoldedLiveState,
  type FoldedLiveStateField,
  type FoldedLiveStateItem,
} from '@/contracts/live-state'

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

const THROWAWAY_SOURCE = { sourceFragmentId: 'pr-0001', analysisId: 'la-1', narrativePosition: 1 }

/**
 * A folded continuity view built in memory, for tests about how it *renders*
 * rather than how it is folded. Entries carry throwaway provenance so a caller
 * only has to state the part it is asserting on.
 */
export function makeContinuityView(overrides: Partial<ContinuityView> = {}): ContinuityView {
  return {
    liveThreads: [makeLiveThread({ threadKey: 'who_sent_the_letter', label: 'Who sent the letter' })],
    liveStates: [
      makeLiveState({
        key: 'villain', fragmentId: undefined, name: 'Villain', present: true,
        fields: [makeLiveStateField('Where', 'the north tower')],
      }),
      makeLiveState({ items: [makeLiveStateItem('Knows', 'The key is missing.')] }),
    ],
    staleProjectionCount: 0,
    ...overrides,
  }
}

/** A live thread with throwaway provenance, for the render tests above. */
export function makeLiveThread(overrides: Partial<LiveThreadEntry> = {}): LiveThreadEntry {
  return {
    ...THROWAWAY_SOURCE,
    threadKey: 'a_thread',
    label: 'A thread',
    visibility: 'foreground',
    ...overrides,
  }
}

/** A character's folded live state, elsewhere unless stated otherwise. */
export function makeLiveState(overrides: Partial<FoldedLiveState> = {}): FoldedLiveState {
  const fragmentId = 'fragmentId' in overrides ? overrides.fragmentId : 'ch-0001'
  return {
    ...THROWAWAY_SOURCE,
    kind: 'character',
    key: fragmentId ?? 'someone',
    ...(fragmentId ? { fragmentId } : {}),
    name: 'Alice',
    present: false,
    fields: [],
    items: [],
    ended: [],
    ...overrides,
  }
}

export function makeLiveStateField(field: string, value: string, overrides: Partial<FoldedLiveStateField> = {}): FoldedLiveStateField {
  return { ...THROWAWAY_SOURCE, field, value, holds: 'lastKnown', visibility: 'outward', scenesAgo: 0, ...overrides }
}

export function makeLiveStateItem(field: string, text: string, overrides: Partial<FoldedLiveStateItem> = {}): FoldedLiveStateItem {
  return { ...THROWAWAY_SOURCE, id: liveStateItemId(field, text), field, text, visibility: 'inner', ...overrides }
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
 * Goes through saveGlobalConfig so the fixture lands in the same two-file shape
 * production uses.
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
