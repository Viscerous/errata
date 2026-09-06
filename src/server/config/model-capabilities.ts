import type { ProviderModelInfo } from '@/contracts/providers'
import { isGeminiProvider, normalizeGeminiBaseURL } from './provider-urls'

interface ModelProvider {
  id?: string
  preset?: string
  baseURL: string
  apiKey: string
  customHeaders?: Record<string, string>
}

interface FetchModelOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  cache?: boolean
}

const OPENROUTER_FREE_MODEL_ID = 'openrouter/free'
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
const modelCatalogCache = new Map<string, {
  expiresAt: number
  result: Promise<{ models: ProviderModelInfo[] }>
}>()

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
    if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) return number
  }
  return undefined
}

/** Read the context-window fields used by compatible model catalogues. */
export function advertisedContextWindow(value: unknown): number | undefined {
  const model = record(value)
  if (!model) return undefined
  const topProvider = record(model.top_provider)
  return positiveInteger(
    model.context_length,
    model.contextWindow,
    model.context_window,
    model.max_context_length,
    model.max_context_window,
    model.max_model_len,
    model.inputTokenLimit,
    model.input_token_limit,
    topProvider?.context_length,
  )
}

function isOpenRouterProvider(provider: { preset?: string; baseURL: string }) {
  return provider.preset === 'openrouter' || provider.baseURL.includes('openrouter.ai')
}

function isFreeModel(model: Record<string, unknown>, id: string) {
  const pricing = record(model.pricing)
  return id === OPENROUTER_FREE_MODEL_ID
    || id.endsWith(':free')
    || (pricing?.prompt === '0' && pricing.completion === '0')
}

function modelId(value: Record<string, unknown>): string | null {
  const id = value.id ?? value.name ?? value.model ?? value.key
  return typeof id === 'string' && id.trim() ? id.replace(/^models\//, '') : null
}

function normalizeRows(rows: unknown[], provider: ModelProvider): ProviderModelInfo[] {
  const models = rows.flatMap((value): ProviderModelInfo[] => {
    if (typeof value === 'string' && value.trim()) {
      return [{ id: value, isFree: value.endsWith(':free') }]
    }
    const row = record(value)
    if (!row) return []
    const id = modelId(row)
    if (!id) return []
    const ownedBy = row.owned_by
    const contextWindow = advertisedContextWindow(row)
    return [{
      id,
      ...(typeof ownedBy === 'string' && ownedBy ? { owned_by: ownedBy } : {}),
      isFree: isFreeModel(row, id),
      ...(contextWindow ? { contextWindow } : {}),
    }]
  })

  if (isOpenRouterProvider(provider) && !models.some(model => model.id === OPENROUTER_FREE_MODEL_ID)) {
    models.push({ id: OPENROUTER_FREE_MODEL_ID, owned_by: 'openrouter', isFree: true })
  }

  models.sort((left, right) => {
    if (left.id === OPENROUTER_FREE_MODEL_ID) return -1
    if (right.id === OPENROUTER_FREE_MODEL_ID) return 1
    if (left.isFree !== right.isFree) return left.isFree ? -1 : 1
    return left.id.localeCompare(right.id)
  })
  return models
}

function providerRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v\d+$/i, '')
}

async function fetchJSON(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText)
      throw new Error(`${response.status} ${text}`.trim())
    }
    return response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchCompatibleCatalog(
  provider: ModelProvider,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProviderModelInfo[]> {
  const base = provider.baseURL.replace(/\/+$/, '')
  const url = /\/v\d+$/i.test(base) ? `${base}/models` : `${base}/v1/models`
  const json = record(await fetchJSON(fetchImpl, url, {
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      ...(provider.customHeaders ?? {}),
    },
  }, timeoutMs))
  return normalizeRows(Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [], provider)
}

async function fetchGeminiCatalog(
  provider: ModelProvider,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProviderModelInfo[]> {
  const base = normalizeGeminiBaseURL(provider.baseURL)
  const json = record(await fetchJSON(fetchImpl, `${base}/models`, {
    headers: {
      'x-goog-api-key': provider.apiKey,
      ...(provider.customHeaders ?? {}),
    },
  }, timeoutMs))
  const rows = Array.isArray(json?.models)
    ? json.models.filter((value) => {
        const methods = record(value)?.supportedGenerationMethods
        return !Array.isArray(methods) || methods.includes('generateContent')
      })
    : []
  return normalizeRows(rows, provider).map(model => ({ ...model, owned_by: 'google', isFree: false }))
}

async function fetchNativeCatalog(
  provider: ModelProvider,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProviderModelInfo[]> {
  const root = providerRoot(provider.baseURL)
  let url: string | null = null
  switch (provider.preset) {
    case 'ollama': url = `${root}/api/ps`; break
    case 'lmstudio': url = `${root}/api/v1/models`; break
    case 'omlx': url = `${root}/v1/models/status`; break
    case 'llamacpp': url = `${root}/props`; break
    case 'koboldcpp': url = `${root}/api/extra/true_max_context_length`; break
  }
  if (!url) return []

  const json = record(await fetchJSON(fetchImpl, url, { headers: provider.customHeaders }, timeoutMs))
  if (!json) return []

  if (provider.preset === 'llamacpp') {
    const settings = record(json.default_generation_settings)
    const contextWindow = positiveInteger(settings?.n_ctx)
    return contextWindow ? [{ id: '*', contextWindow }] : []
  }
  if (provider.preset === 'koboldcpp') {
    const contextWindow = positiveInteger(json.value)
    return contextWindow ? [{ id: '*', contextWindow }] : []
  }

  const rows = Array.isArray(json.models) ? json.models : []
  if (provider.preset === 'lmstudio') {
    return rows.flatMap((value): ProviderModelInfo[] => {
      const row = record(value)
      if (!row) return []
      const id = modelId(row)
      if (!id) return []
      const instances = Array.isArray(row.loaded_instances) ? row.loaded_instances : []
      const loadedWindow = instances.map(instance => advertisedContextWindow(record(instance)?.config)).find(Boolean)
      const contextWindow = loadedWindow ?? advertisedContextWindow(row)
      return [{ id, ...(contextWindow ? { contextWindow } : {}) }]
    })
  }
  return normalizeRows(rows, provider)
}

function mergeModels(catalog: ProviderModelInfo[], native: ProviderModelInfo[]): ProviderModelInfo[] {
  const wildcard = native.find(model => model.id === '*')?.contextWindow
  const nativeById = new Map(native.filter(model => model.id !== '*').map(model => [model.id, model]))
  const merged = new Map<string, ProviderModelInfo>()
  for (const model of [...catalog, ...native]) {
    if (model.id === '*') continue
    const richer = nativeById.get(model.id)
    merged.set(model.id, {
      ...merged.get(model.id),
      ...model,
      contextWindow: richer?.contextWindow ?? model.contextWindow ?? wildcard,
    })
  }
  return [...merged.values()]
}

/**
 * List models and retain only capacity that the backend actually advertises.
 * Native local endpoints enrich the compatible catalogue but never make a
 * model-list request fail when that optional introspection is unavailable.
 */
async function loadProviderModels(
  provider: ModelProvider,
  options: FetchModelOptions = {},
): Promise<{ models: ProviderModelInfo[] }> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  if (isGeminiProvider(provider)) {
    return { models: await fetchGeminiCatalog(provider, fetchImpl, timeoutMs) }
  }

  const [catalog, native] = await Promise.allSettled([
    fetchCompatibleCatalog(provider, fetchImpl, timeoutMs),
    fetchNativeCatalog(provider, fetchImpl, timeoutMs),
  ])
  if (catalog.status === 'rejected' && (native.status === 'rejected' || native.value.length === 0)) {
    throw new Error(`Failed to fetch models: ${catalog.reason instanceof Error ? catalog.reason.message : String(catalog.reason)}`)
  }
  return {
    models: mergeModels(
      catalog.status === 'fulfilled' ? catalog.value : [],
      native.status === 'fulfilled' ? native.value : [],
    ),
  }
}

/** Fetch model metadata, sharing short-lived catalog reads in normal runtime. */
export function fetchProviderModels(
  provider: ModelProvider,
  options: FetchModelOptions = {},
): Promise<{ models: ProviderModelInfo[] }> {
  const useCache = options.cache ?? options.fetch === undefined
  if (!useCache) return loadProviderModels(provider, options)

  const cacheKey = JSON.stringify([
    provider.id,
    provider.preset,
    provider.baseURL,
    provider.apiKey,
    provider.customHeaders,
  ])
  const now = Date.now()
  const cached = modelCatalogCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.result

  const result = loadProviderModels(provider, options).catch((error) => {
    modelCatalogCache.delete(cacheKey)
    throw error
  })
  modelCatalogCache.set(cacheKey, { expiresAt: now + MODEL_CATALOG_TTL_MS, result })
  return result
}

export async function advertisedModelContextWindow(
  provider: ModelProvider,
  modelId: string,
  options: FetchModelOptions = {},
): Promise<number | undefined> {
  const { models } = await fetchProviderModels(provider, options)
  return models.find(model => model.id === modelId)?.contextWindow
}
