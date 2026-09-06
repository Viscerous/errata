import { describe, expect, it, vi } from 'vitest'
import {
  advertisedContextWindow,
  fetchProviderModels,
} from '@/server/config/model-capabilities'

describe('provider model capabilities', () => {
  it('reads only positive advertised context-window fields', () => {
    expect(advertisedContextWindow({ context_length: 32_768 })).toBe(32_768)
    expect(advertisedContextWindow({ inputTokenLimit: 1_000_000 })).toBe(1_000_000)
    expect(advertisedContextWindow({ top_provider: { context_length: '131072' } })).toBe(131_072)
    expect(advertisedContextWindow({ context_length: 0 })).toBeUndefined()
  })

  it('keeps compatible catalogue capacity and free-model metadata', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'paid/model', context_length: 65_536, pricing: { prompt: '0.1', completion: '0.2' } },
        { id: 'free/model:free', top_provider: { context_length: 131_072 } },
      ],
    }), { status: 200 })) as unknown as typeof fetch

    const result = await fetchProviderModels({
      preset: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'key',
    }, { fetch: fetchMock, timeoutMs: 100 })

    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'paid/model', contextWindow: 65_536, isFree: false }),
      expect.objectContaining({ id: 'free/model:free', contextWindow: 131_072, isFree: true }),
    ]))
  })

  it('enriches llama.cpp catalogue models from its native loaded context', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/props')) {
        return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 16_384 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchProviderModels({
      preset: 'llamacpp',
      baseURL: 'http://127.0.0.1:8080/v1',
      apiKey: '',
    }, { fetch: fetchMock, timeoutMs: 100 })

    expect(result.models).toEqual([
      expect.objectContaining({ id: 'local-model', contextWindow: 16_384 }),
    ])
  })

  it('uses Gemini inputTokenLimit and excludes non-generation models', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-writing', inputTokenLimit: 1_048_576, supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-embed', inputTokenLimit: 8_192, supportedGenerationMethods: ['embedContent'] },
      ],
    }), { status: 200 })) as unknown as typeof fetch

    const result = await fetchProviderModels({
      preset: 'gemini',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key',
    }, { fetch: fetchMock, timeoutMs: 100 })

    expect(result.models).toEqual([{
      id: 'gemini-writing',
      owned_by: 'google',
      isFree: false,
      contextWindow: 1_048_576,
    }])
  })
})
