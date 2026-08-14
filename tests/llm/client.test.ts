import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings, makeTestGlobalConfig, seedTestProvider } from '../setup'
import { createStory } from '@/server/fragments/storage'
import { saveGlobalConfig } from '@/server/config/storage'
import {
  getModel,
  resolveAgentRuntime,
  resolveGenerationGuards,
  translateOpenAICompatibleTopK,
} from '@/server/llm/client'
import type { StoryMeta } from '@/server/fragments/schema'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings({ librarianProviderId: null, librarianModelId: null }),
  }
}

describe('resolveGenerationGuards', () => {
  it('delegates output length to the provider when unset', () => {
    expect(resolveGenerationGuards(undefined)).toEqual({
      maxOutputTokens: undefined,
    })
  })

  it('lets story settings override the token cap', () => {
    expect(resolveGenerationGuards({ maxOutputTokens: 2048 })).toEqual({
      maxOutputTokens: 2048,
    })
  })
})

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
    await saveGlobalConfig(dataDir, makeTestGlobalConfig({
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
    }))

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
    await saveGlobalConfig(dataDir, makeTestGlobalConfig({
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
    }))

    const story = makeStory()
    story.settings.providerId = 'gen'
    story.settings.modelId = 'gen-model'
    await createStory(dataDir, story)

    const resolved = await getModel(dataDir, story.id, { role: 'librarian' })
    expect(resolved.providerId).toBe('gen')
    expect(resolved.modelId).toBe('gen-model')
  })

  it('uses a model-only override with the inherited provider', async () => {
    await saveGlobalConfig(dataDir, makeTestGlobalConfig({
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
    }))

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
    await saveGlobalConfig(dataDir, makeTestGlobalConfig({
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
    }))
    await createStory(dataDir, makeStory())

    const resolved = await getModel(dataDir, 'story-test')

    expect(resolved.providerId).toBe('gemini')
    expect(resolved.modelId).toBe('gemini-3.5-flash')
    expect((resolved.model as unknown as { provider: string }).provider).toBe('google.generative-ai')
  })

  it('migrates Google OpenAI-compatible endpoints to the native Gemini provider', async () => {
    await saveGlobalConfig(dataDir, makeTestGlobalConfig({
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
    }))
    await createStory(dataDir, makeStory())

    const resolved = await getModel(dataDir, 'story-test')

    expect((resolved.model as unknown as { provider: string }).provider).toBe('google.generative-ai')
    expect(resolved.config.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  it('inherits top-p and top-k independently through the role chain', async () => {
    await seedTestProvider(dataDir)
    const story = makeStory()
    story.settings.modelOverrides = {
      generation: { topP: 0.9, topK: 64 },
      librarian: { topK: 20 },
    }
    await createStory(dataDir, story)

    const writer = await getModel(dataDir, story.id, { role: 'generation.writer' })
    const analyze = await getModel(dataDir, story.id, { role: 'librarian.analyze' })

    expect(writer).toMatchObject({ topP: 0.9, topK: 64 })
    expect(analyze).toMatchObject({ topP: 0.9, topK: 20 })
  })

  it('prefers canonical role overrides to legacy aliases regardless of property order', async () => {
    await seedTestProvider(dataDir)
    const story = makeStory()
    story.settings.modelOverrides = {
      prewriter: { topK: 64 },
      'generation.prewriter': { topK: 20 },
    }
    await createStory(dataDir, story)

    const resolved = await getModel(dataDir, story.id, { role: 'generation.prewriter' })

    expect(resolved.topK).toBe(20)
  })

  it('translates canonical topK only at the OpenAI-compatible provider boundary', async () => {
    const params = {
      prompt: [],
      topK: 64,
      providerOptions: { Test: { reasoning_effort: 'high' } },
    } as Parameters<typeof translateOpenAICompatibleTopK>[0]

    expect(translateOpenAICompatibleTopK(params, 'Test')).toMatchObject({
      topK: undefined,
      providerOptions: { Test: { reasoning_effort: 'high', top_k: 64 } },
    })
  })

  it('rebuilds an OpenAI-compatible provider when its options namespace changes', async () => {
    const provider = {
      id: 'rename-test',
      name: 'Before Rename',
      preset: 'custom',
      baseURL: 'https://example.com/v1',
      apiKey: 'test-key',
      defaultModel: 'test-model',
      enabled: true,
      customHeaders: {},
      temperature: undefined,
      createdAt: new Date().toISOString(),
    }
    await saveGlobalConfig(dataDir, makeTestGlobalConfig({
      defaultProviderId: provider.id,
      providers: [provider],
    }))
    await createStory(dataDir, makeStory())

    const before = await getModel(dataDir, 'story-test')
    await saveGlobalConfig(dataDir, makeTestGlobalConfig({
      defaultProviderId: provider.id,
      providers: [{ ...provider, name: 'After Rename' }],
    }))
    const after = await getModel(dataDir, 'story-test')

    expect((before.model as unknown as { provider: string }).provider).toBe('Before Rename.chat')
    expect((after.model as unknown as { provider: string }).provider).toBe('After Rename.chat')
  })

  it('uses the SDK top-k field for native Gemini providers', async () => {
    await saveGlobalConfig(dataDir, makeTestGlobalConfig({
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
    }))
    const story = makeStory()
    story.settings.modelOverrides = { generation: { topK: 20 } }
    await createStory(dataDir, story)

    const runtime = await resolveAgentRuntime(dataDir, story.id, 'generation.writer', story)

    expect(runtime.topK).toBe(20)
    expect(runtime.providerOptions).toBeUndefined()
  })
})
