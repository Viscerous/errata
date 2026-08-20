import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { streamText } from 'ai'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory } from '@/server/fragments/storage'
import { saveGlobalConfig } from '@/server/config/storage'
import { getModel } from '@/server/llm/client'
import type { StoryMeta } from '@/server/fragments/schema'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings({ librarianProviderId: null, librarianModelId: null }),
  }
}

describe('llm client model resolution', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('uses librarian-specific provider/model when configured', async () => {
    await saveGlobalConfig(dataDir, {
      defaultProviderId: 'gen',
      providers: [
        {
          id: 'gen',
          name: 'Gen Provider',
          preset: 'custom',
          baseURL: 'https://example.com/v1',
          apiKey: 'test-key-gen',
          defaultModel: 'gen-default',
          enabled: true,
          customHeaders: {},
          temperature: undefined,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'lib',
          name: 'Lib Provider',
          preset: 'custom',
          baseURL: 'https://example.org/v1',
          apiKey: 'test-key-lib',
          defaultModel: 'lib-default',
          enabled: true,
          customHeaders: {},
          temperature: undefined,
          createdAt: new Date().toISOString(),
        },
      ],
    })

    const story = makeStory()
    story.settings.providerId = 'gen'
    story.settings.modelId = 'gen-model'
    story.settings.librarianProviderId = 'lib'
    story.settings.librarianModelId = 'lib-model'
    await createStory(dataDir, story)

    const resolved = await getModel(dataDir, story.id, { role: 'librarian' })
    expect(resolved.providerId).toBe('lib')
    expect(resolved.modelId).toBe('lib-model')
  })

  it('falls back to generation provider/model when librarian settings are unset', async () => {
    await saveGlobalConfig(dataDir, {
      defaultProviderId: 'gen',
      providers: [
        {
          id: 'gen',
          name: 'Gen Provider',
          preset: 'custom',
          baseURL: 'https://example.com/v1',
          apiKey: 'test-key-gen',
          defaultModel: 'gen-default',
          enabled: true,
          customHeaders: {},
          temperature: undefined,
          createdAt: new Date().toISOString(),
        },
      ],
    })

    const story = makeStory()
    story.settings.providerId = 'gen'
    story.settings.modelId = 'gen-model'
    await createStory(dataDir, story)

    const resolved = await getModel(dataDir, story.id, { role: 'librarian' })
    expect(resolved.providerId).toBe('gen')
    expect(resolved.modelId).toBe('gen-model')
  })

  it('uses a model-only override with the inherited provider', async () => {
    await saveGlobalConfig(dataDir, {
      defaultProviderId: 'openrouter',
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          preset: 'openrouter',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'test-key-openrouter',
          defaultModel: 'openrouter/glm-5',
          enabled: true,
          customHeaders: {},
          temperature: undefined,
          createdAt: new Date().toISOString(),
        },
      ],
    })

    const story = makeStory()
    story.settings.modelOverrides = {
      generation: { modelId: 'anthropic/claude-sonnet-4.5' },
    }
    await createStory(dataDir, story)

    const resolved = await getModel(dataDir, story.id, { role: 'generation' })
    expect(resolved.providerId).toBe('openrouter')
    expect(resolved.modelId).toBe('anthropic/claude-sonnet-4.5')
  })

  it('uses the native Google provider for Gemini presets', async () => {
    await saveGlobalConfig(dataDir, {
      defaultProviderId: 'gemini',
      providers: [{
        id: 'gemini',
        name: 'Google Gemini',
        preset: 'gemini',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'test-gemini-key',
        defaultModel: 'gemini-3.5-flash',
        enabled: true,
        customHeaders: {},
        temperature: undefined,
        createdAt: new Date().toISOString(),
      }],
    })
    await createStory(dataDir, makeStory())

    const resolved = await getModel(dataDir, 'story-test')

    expect(resolved.providerId).toBe('gemini')
    expect(resolved.modelId).toBe('gemini-3.5-flash')
    expect((resolved.model as unknown as { provider: string }).provider).toBe('google.generative-ai')
  })

  it('migrates Google OpenAI-compatible endpoints to the native Gemini provider', async () => {
    await saveGlobalConfig(dataDir, {
      defaultProviderId: 'legacy-gemini',
      providers: [{
        id: 'legacy-gemini',
        name: 'Gemini (legacy)',
        preset: 'custom',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: 'test-gemini-key',
        defaultModel: 'gemini-3.5-flash',
        enabled: true,
        customHeaders: {},
        temperature: undefined,
        createdAt: new Date().toISOString(),
      }],
    })
    await createStory(dataDir, makeStory())

    const resolved = await getModel(dataDir, 'story-test')

    expect((resolved.model as unknown as { provider: string }).provider).toBe('google.generative-ai')
    expect(resolved.config.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  it('extracts inline <think> tags into reasoning parts for OpenAI-compatible providers', async () => {
    await saveGlobalConfig(dataDir, {
      defaultProviderId: 'local',
      providers: [{
        id: 'local',
        name: 'Local Qwen',
        preset: 'custom',
        baseURL: 'http://localhost:1234/v1',
        apiKey: 'not-needed',
        defaultModel: 'qwen3-think',
        enabled: true,
        customHeaders: {},
        temperature: undefined,
        createdAt: new Date().toISOString(),
      }],
    })
    await createStory(dataDir, makeStory())

    const resolved = await getModel(dataDir, 'story-test')

    // Simulate a local thinking model that emits <think>...</think> inside
    // ordinary content deltas (no separate reasoning field).
    const chunk = (content: string) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'qwen3-think',
        choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
      })}\n\n`
    const sseBody =
      chunk('<think>planning the ') +
      chunk('scene</think>') +
      chunk('Once upon a time.') +
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'qwen3-think',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 },
      })}\n\n` +
      'data: [DONE]\n\n'

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ))

    try {
      const result = streamText({ model: resolved.model, prompt: 'Write.' })
      let text = ''
      let reasoning = ''
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') text += part.text
        if (part.type === 'reasoning-delta') reasoning += part.text
      }

      expect(text).not.toContain('<think>')
      expect(text.trim()).toBe('Once upon a time.')
      expect(reasoning).toContain('planning the scene')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
