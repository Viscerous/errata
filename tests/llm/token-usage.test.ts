import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeTokenUsage, resolveAndReportServedUsage, resolveAndReportUsage } from '@/server/llm/usage-normalizer'
import { clearServedModelObservations, getObservedServedModelId } from '@/server/llm/served-models'
import { flushAllPendingTokenUsage, getSessionUsage, reportUsage } from '@/server/llm/token-tracker'
import { createTempDir } from '../setup'

describe('normalizeTokenUsage', () => {
  it('normalizes AI SDK v6 totalUsage', () => {
    expect(normalizeTokenUsage({ inputTokens: 12, outputTokens: 8 })).toEqual({
      inputTokens: 12,
      outputTokens: 8,
    })
  })

  it('normalizes OpenAI-compatible usage fields', () => {
    expect(normalizeTokenUsage({ prompt_tokens: 21, completion_tokens: 13 })).toEqual({
      inputTokens: 21,
      outputTokens: 13,
    })
  })

  it('ignores non-finite token values', () => {
    expect(normalizeTokenUsage({ inputTokens: Number.NaN, outputTokens: 9 })).toEqual({
      inputTokens: 0,
      outputTokens: 9,
    })
  })
})

/**
 * These assert the in-memory session counters, but reporting also schedules a
 * debounced write, so the dataDir has to be a real disposable one — a literal
 * placeholder was landing usage files in the repo root on every test run.
 */
describe('usage reporting', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    clearServedModelObservations()
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
  })

  afterEach(async () => {
    // Drain before removing the directory: the write is on a 2s debounce plus a
    // beforeExit hook, so without this it lands after cleanup has run.
    await flushAllPendingTokenUsage()
    await cleanup()
  })

  describe('reportUsage', () => {
    it('does not let invalid token values poison counters', () => {
      const storyId = `story-token-usage-${Date.now()}`

      reportUsage(
        dataDir,
        storyId,
        'test.source',
        { inputTokens: Number.NaN, outputTokens: 12 },
        'test-model',
      )

      expect(getSessionUsage(storyId).total).toEqual({
        inputTokens: 0,
        outputTokens: 12,
        calls: 1,
      })
    })
  })

  describe('resolveAndReportUsage', () => {
    it('awaits, normalizes, reports, and returns the usage', async () => {
      const storyId = `story-resolve-usage-${Date.now()}`

      const usage = await resolveAndReportUsage(
        dataDir,
        storyId,
        'test.resolve-source',
        Promise.resolve({ inputTokens: 40, outputTokens: 8 }),
        'test-model',
      )

      expect(usage).toEqual({ inputTokens: 40, outputTokens: 8 })
      expect(getSessionUsage(storyId).total).toEqual({
        inputTokens: 40,
        outputTokens: 8,
        calls: 1,
      })
    })

    it('swallows a rejected totalUsage promise and reports nothing', async () => {
      const storyId = `story-resolve-usage-reject-${Date.now()}`

      const usage = await resolveAndReportUsage(
        dataDir,
        storyId,
        'test.resolve-source',
        Promise.reject(new Error('provider does not report usage')),
        'test-model',
      )

      expect(usage).toBeUndefined()
      expect(getSessionUsage(storyId).total).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
      })
    })

    it('resolves to undefined and reports nothing when usage cannot be normalized', async () => {
      const storyId = `story-resolve-usage-empty-${Date.now()}`

      const usage = await resolveAndReportUsage(
        dataDir,
        storyId,
        'test.resolve-source',
        Promise.resolve(undefined),
        'test-model',
      )

      expect(usage).toBeUndefined()
      expect(getSessionUsage(storyId).total.calls).toBe(0)
    })
  })

  describe('resolveAndReportServedUsage', () => {
    it('uses one served identity for the observation, result, and usage totals', async () => {
      const storyId = `story-served-usage-${Date.now()}`

      const result = await resolveAndReportServedUsage(
        dataDir,
        storyId,
        'test.served-source',
        Promise.resolve({ inputTokens: 12, outputTokens: 3 }),
        {
          providerId: 'local-provider',
          configuredModelId: 'configured-gemma',
          servedModelId: 'qwen3-30b',
        },
      )

      expect(result).toEqual({ modelId: 'qwen3-30b', usage: { inputTokens: 12, outputTokens: 3 } })
      expect(getObservedServedModelId('local-provider', 'configured-gemma')).toBe('qwen3-30b')
      expect(getSessionUsage(storyId).byModel['qwen3-30b']).toEqual({
        inputTokens: 12,
        outputTokens: 3,
        calls: 1,
      })
    })
  })
})
