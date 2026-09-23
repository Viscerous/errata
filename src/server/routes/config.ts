import { Elysia, t } from 'elysia'
import {
  getGlobalConfigSafe,
  addProvider,
  updateProvider as updateProviderConfig,
  deleteProvider as deleteProviderConfig,
  duplicateProvider as duplicateProviderConfig,
  mutateGlobalConfig,
  getProvider,
  maskProviders,
} from '../config/storage'
import { ProviderConfigSchema } from '../config/schema'
import { isGeminiProvider, normalizeGeminiBaseURL } from '../config/provider-urls'
import { fetchProviderModels } from '../config/model-capabilities'
import {
  createOpenRouterOAuthAuthorizationUrl,
  ensureOpenRouterOAuthCallbackBridge,
  exchangeAndSaveOpenRouterOAuthCode,
} from '../openrouter-oauth-callback'
import { discoverLocalProviders } from '../config/provider-discovery'

function maskConfigProviders<T extends { providers: Array<{ apiKey: string }> }>(config: T): T {
  return { ...config, providers: maskProviders(config.providers) }
}

interface TestableProvider {
  baseURL: string
  apiKey: string
  model: string
  preset?: string
  customHeaders?: Record<string, string>
}

/** Send a short chat completion so the user can see whether a provider answers. */
async function testProviderConnection(
  { baseURL, apiKey, model, preset, customHeaders = {} }: TestableProvider,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  try {
    if (isGeminiProvider({ preset, baseURL })) {
      const base = normalizeGeminiBaseURL(baseURL)
      const res = await fetch(
        `${base}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', ...customHeaders },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Hello! (keep your response short)' }] }],
            generationConfig: { maxOutputTokens: 64 },
          }),
        },
      )
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        return { ok: false, error: `${res.status} ${text}` }
      }
      const json = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      }
      const reply = json.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? ''
      return { ok: true, reply }
    }

    const base = baseURL.replace(/\/+$/, '')
    const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...customHeaders },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello! (keep your response short)' }],
        max_tokens: 64,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      return { ok: false, error: `${res.status} ${text}` }
    }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    return { ok: true, reply: json.choices?.[0]?.message?.content ?? '' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' }
  }
}

export function configRoutes(dataDir: string) {
  return new Elysia({ detail: { tags: ['Config'] } })
    .get('/config/providers', async () => {
      return getGlobalConfigSafe(dataDir)
    }, {
      detail: { summary: 'Get global config with masked API keys' },
    })

    .get('/config/discover-local', async () => ({
      providers: await discoverLocalProviders(),
    }), {
      detail: { summary: 'Probe known local model servers on loopback' },
    })

    .post('/config/providers', async ({ body }) => {
      const id = `prov-${Date.now().toString(36)}`
      const provider = ProviderConfigSchema.parse({
        id,
        name: body.name,
        preset: body.preset ?? 'custom',
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        defaultModel: body.defaultModel,
        enabled: true,
        customHeaders: body.customHeaders ?? {},
        temperature: body.temperature,
        reasoningAllowance: body.reasoningAllowance ?? {},
        ...(body.structuredOutput !== undefined ? { structuredOutput: body.structuredOutput } : {}),
        createdAt: new Date().toISOString(),
      })
      const config = await addProvider(dataDir, provider)
      return maskConfigProviders(config)
    }, {
      detail: { summary: 'Add a new provider' },
      body: t.Object({
        name: t.String(),
        preset: t.Optional(t.String()),
        baseURL: t.String(),
        apiKey: t.String(),
        defaultModel: t.String(),
        customHeaders: t.Optional(t.Record(t.String(), t.String())),
        temperature: t.Optional(t.Number()),
        reasoningAllowance: t.Optional(t.Record(t.String(), t.Integer({ minimum: 0 }))),
        structuredOutput: t.Optional(t.Boolean()),
      }),
    })

    .put('/config/providers/:providerId', async ({ params, body }) => {
      const updates: Record<string, unknown> = {}
      if (body.name !== undefined) updates.name = body.name
      if (body.baseURL !== undefined) updates.baseURL = body.baseURL
      if (body.apiKey !== undefined) updates.apiKey = body.apiKey
      if (body.defaultModel !== undefined) updates.defaultModel = body.defaultModel
      if (body.enabled !== undefined) updates.enabled = body.enabled
      if (body.customHeaders !== undefined) updates.customHeaders = body.customHeaders
      if (body.temperature !== undefined) updates.temperature = body.temperature
      if (body.reasoningAllowance !== undefined) updates.reasoningAllowance = body.reasoningAllowance
      if (body.structuredOutput !== undefined) updates.structuredOutput = body.structuredOutput
      const config = await updateProviderConfig(dataDir, params.providerId, updates)
      return maskConfigProviders(config)
    }, {
      detail: { summary: 'Update a provider' },
      body: t.Object({
        name: t.Optional(t.String()),
        baseURL: t.Optional(t.String()),
        apiKey: t.Optional(t.String()),
        defaultModel: t.Optional(t.String()),
        enabled: t.Optional(t.Boolean()),
        customHeaders: t.Optional(t.Record(t.String(), t.String())),
        temperature: t.Optional(t.Union([t.Number(), t.Null()])),
        reasoningAllowance: t.Optional(t.Record(t.String(), t.Integer({ minimum: 0 }))),
        structuredOutput: t.Optional(t.Boolean()),
      }),
    })

    .delete('/config/providers/:providerId', async ({ params }) => {
      const config = await deleteProviderConfig(dataDir, params.providerId)
      return maskConfigProviders(config)
    }, {
      detail: { summary: 'Delete a provider' },
    })

    .post('/config/providers/:providerId/duplicate', async ({ params }) => {
      const config = await duplicateProviderConfig(dataDir, params.providerId)
      return maskConfigProviders(config)
    }, {
      detail: { summary: 'Duplicate a provider' },
    })

    .patch('/config/default-provider', async ({ body }) => {
      await mutateGlobalConfig(dataDir, (config) => {
        config.defaultProviderId = body.providerId
      })
      return { ok: true, defaultProviderId: body.providerId }
    }, {
      detail: { summary: 'Set the default provider' },
      body: t.Object({
        providerId: t.Union([t.String(), t.Null()]),
      }),
    })

    .get('/config/providers/:providerId/models', async ({ params, set }) => {
      const provider = await getProvider(dataDir, params.providerId)
      if (!provider) {
        set.status = 404
        return { models: [], error: 'Provider not found' }
      }
      try {
        return await fetchProviderModels(provider)
      } catch (err) {
        return { models: [], error: err instanceof Error ? err.message : 'Unknown error fetching models' }
      }
    }, {
      detail: { summary: 'List models from a provider' },
    })

    // Fetch models with arbitrary credentials (for unsaved providers, avoids CORS)
    .post('/config/test-models', async ({ body }) => {
      try {
        return await fetchProviderModels(body)
      } catch (err) {
        return { models: [], error: err instanceof Error ? err.message : 'Unknown error fetching models' }
      }
    }, {
      detail: { summary: 'Fetch models with arbitrary credentials' },
      body: t.Object({
        baseURL: t.String(),
        apiKey: t.String(),
        preset: t.Optional(t.String()),
        customHeaders: t.Optional(t.Record(t.String(), t.String())),
      }),
    })

    // Testing a saved provider and testing unsaved credentials are separate
    // endpoints on purpose. A single one taking both a providerId and a baseURL
    // could be asked to send a stored key to a host of the caller's choosing;
    // split, the destination always comes from wherever the key came from.
    .post('/config/providers/:providerId/test-connection', async ({ params, body, set }) => {
      const stored = await getProvider(dataDir, params.providerId)
      if (!stored) {
        set.status = 404
        return { ok: false, error: 'Provider not found' }
      }
      return testProviderConnection({
        baseURL: stored.baseURL,
        apiKey: stored.apiKey,
        model: body.model || stored.defaultModel,
        preset: stored.preset,
        customHeaders: stored.customHeaders,
      })
    }, {
      detail: { summary: 'Test a saved provider using its stored credentials' },
      body: t.Object({ model: t.Optional(t.String()) }),
    })

    .post('/config/test-connection', async ({ body }) => testProviderConnection(body), {
      detail: { summary: 'Test unsaved credentials' },
      body: t.Object({
        baseURL: t.String(),
        apiKey: t.String(),
        model: t.String(),
        preset: t.Optional(t.String()),
        customHeaders: t.Optional(t.Record(t.String(), t.String())),
      }),
    })

    .post('/config/openrouter/oauth/start', async () => {
      await ensureOpenRouterOAuthCallbackBridge()
      return createOpenRouterOAuthAuthorizationUrl(dataDir)
    }, {
      detail: { summary: 'Create an OpenRouter OAuth authorization URL' },
    })

    .post('/config/openrouter/oauth/exchange', async ({ body, set }) => {
      try {
        const config = await exchangeAndSaveOpenRouterOAuthCode(dataDir, body.code, body.codeVerifier)
        return maskConfigProviders(config)
      } catch (err) {
        set.status = 502
        return { error: err instanceof Error ? err.message : 'OpenRouter OAuth exchange failed' }
      }
    }, {
      detail: { summary: 'Exchange an OpenRouter OAuth code for a provider API key' },
      body: t.Object({
        code: t.String(),
        codeVerifier: t.String(),
        codeChallengeMethod: t.Optional(t.Union([t.Literal('S256'), t.Literal('plain')])),
      }),
    })
}
