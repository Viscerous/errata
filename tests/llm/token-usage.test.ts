import { describe, expect, it } from 'vitest'
import { normalizeTokenUsage, resolveAndReportUsage } from '@/server/llm/usage-normalizer'
import { getSessionUsage, reportUsage } from '@/server/llm/token-tracker'

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

describe('reportUsage', () => {
  it('does not let invalid token values poison counters', () => {
    const storyId = `story-token-usage-${Date.now()}`

    reportUsage(
      'unused-data-dir',
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
      'unused-data-dir',
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
      'unused-data-dir',
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
      'unused-data-dir',
      storyId,
      'test.resolve-source',
      Promise.resolve(undefined),
      'test-model',
    )

    expect(usage).toBeUndefined()
    expect(getSessionUsage(storyId).total.calls).toBe(0)
  })
})
