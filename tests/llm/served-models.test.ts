import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearServedModelObservations,
  getObservedServedModelId,
  recordServedModel,
  servedModelIdFromResponse,
} from '@/server/llm/served-models'

describe('served model observations', () => {
  beforeEach(() => clearServedModelObservations())

  it('distinguishes an unobserved configured label from a served identity', () => {
    expect(getObservedServedModelId('local', 'configured-gemma')).toBeUndefined()

    expect(recordServedModel('local', 'configured-gemma', 'qwen3-30b')).toBe('qwen3-30b')
    expect(getObservedServedModelId('local', 'configured-gemma')).toBe('qwen3-30b')
  })

  it('records the configured fallback after a response supplies no model metadata', () => {
    expect(recordServedModel('remote', 'gpt-test', undefined)).toBe('gpt-test')
    expect(getObservedServedModelId('remote', 'gpt-test')).toBe('gpt-test')
  })

  it('reads only non-empty model ids from response metadata', () => {
    expect(servedModelIdFromResponse({ modelId: 'qwen3-30b' })).toBe('qwen3-30b')
    expect(servedModelIdFromResponse({ modelId: '' })).toBeUndefined()
    expect(servedModelIdFromResponse(undefined)).toBeUndefined()
  })
})
