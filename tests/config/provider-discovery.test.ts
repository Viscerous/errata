import { describe, expect, it, vi } from 'vitest'
import { discoverLocalProviders, localProviderCandidates } from '@/server/config/provider-discovery'

describe('local provider discovery', () => {
  it('uses known defaults and reads local server ports without scanning', async () => {
    const candidates = await localProviderCandidates({
      homeDir: 'C:\\Users\\writer',
      env: { OLLAMA_HOST: 'localhost:22444' },
      readText: async (path) => {
        if (path.includes('.lmstudio')) return JSON.stringify({ port: 6123 })
        if (path.includes('.omlx')) return JSON.stringify({ server: { port: 8123 } })
        throw new Error('missing')
      },
    })

    expect(candidates).toEqual(expect.arrayContaining([
      { preset: 'ollama', baseURL: 'http://localhost:22444/v1' },
      { preset: 'lmstudio', baseURL: 'http://127.0.0.1:6123/v1' },
      { preset: 'llamacpp', baseURL: 'http://127.0.0.1:8080/v1' },
      { preset: 'llamacpp', baseURL: 'http://127.0.0.1:9931/v1' },
      { preset: 'koboldcpp', baseURL: 'http://127.0.0.1:5001/v1' },
      { preset: 'omlx', baseURL: 'http://127.0.0.1:8123/v1' },
    ]))
  })

  it('ignores a remote OLLAMA_HOST because automatic discovery is loopback-only', async () => {
    const candidates = await localProviderCandidates({
      env: { OLLAMA_HOST: 'http://model-box.example:11434' },
      readText: async () => { throw new Error('missing') },
    })

    expect(candidates.find(candidate => candidate.preset === 'ollama')?.baseURL)
      .toBe('http://127.0.0.1:11434/v1')
  })

  it('probes candidates concurrently and keeps one dead server from hiding the others', async () => {
    const requested: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.includes(':5001/')) throw new Error('connection refused')
      if (url.includes(':11434/')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await discoverLocalProviders({
      fetch: fetchMock,
      readText: async () => { throw new Error('missing') },
      timeoutMs: 100,
    })

    expect(requested).toEqual(expect.arrayContaining([
      'http://127.0.0.1:11434/v1/models',
      'http://127.0.0.1:11434/api/ps',
      'http://127.0.0.1:1234/v1/models',
      'http://127.0.0.1:1234/api/v1/models',
    ]))
    expect(result.find(provider => provider.preset === 'ollama')).toMatchObject({
      status: 'available', models: [{ id: 'qwen3:8b' }],
    })
    expect(result.find(provider => provider.preset === 'koboldcpp')).toMatchObject({
      status: 'unavailable', error: 'Failed to fetch models: connection refused',
    })
    expect(result.filter(provider => provider.status === 'available')).toHaveLength(4)
    expect(result.filter(provider => provider.preset === 'llamacpp')).toHaveLength(1)
    expect(result.find(provider => provider.preset === 'llamacpp')?.baseURL).toBe('http://127.0.0.1:8080/v1')
  })

  it('discovers llama.cpp on the announced future default port when 8080 is unavailable', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes(':8080/')) throw new Error('connection refused')
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await discoverLocalProviders({
      fetch: fetchMock,
      readText: async () => { throw new Error('missing') },
      timeoutMs: 100,
    })

    expect(result.find(provider => provider.preset === 'llamacpp')).toMatchObject({
      status: 'available', baseURL: 'http://127.0.0.1:9931/v1',
    })
  })
})
