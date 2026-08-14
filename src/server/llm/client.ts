import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { getGlobalConfig } from '../config/storage'
import { getStory } from '../fragments/storage'
import { modelRoleRegistry } from '../agents/model-role-registry'
import { ensureCoreAgentsRegistered } from '../agents/register-core'
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type ToolLoopAgentSettings } from 'ai'
import { createLogger } from '../logging'
import type { SamplingSettings, StoryMeta } from '../fragments/schema'
import { isGeminiProvider, normalizeGeminiBaseURL } from '../config/provider-urls'

// Normalize old camelCase modelOverrides keys to dot-separated agent names
const OVERRIDE_KEY_ALIASES: Record<string, string> = {
  characterChat: 'character-chat.chat',
  librarianChat: 'librarian.chat',
  librarianRefine: 'librarian.refine',
  proseTransform: 'librarian.prose-transform',
  prewriter: 'generation.prewriter',
}

/** Apply key aliases to a modelOverrides map, returning a normalized copy */
type ModelOverride = StoryMeta['settings']['modelOverrides'][string]

function normalizeOverrideKeys(
  overrides: Record<string, ModelOverride>,
): Record<string, ModelOverride> {
  const result: Record<string, ModelOverride> = {}
  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = OVERRIDE_KEY_ALIASES[key] ?? key
    const legacyAlias = normalizedKey !== key
    // A canonical key always wins, regardless of JSON property order. A legacy
    // alias only fills the slot when no canonical value has been seen.
    if (!legacyAlias || !(normalizedKey in result)) {
      result[normalizedKey] = value
    }
  }
  return result
}

// Legacy field name mapping for backward compat with old story JSON files
const LEGACY_FIELD_MAP: Record<string, { providerId: string; modelId: string }> = {
  generation: { providerId: 'providerId', modelId: 'modelId' },
  librarian: { providerId: 'librarianProviderId', modelId: 'librarianModelId' },
  'character-chat': { providerId: 'characterChatProviderId', modelId: 'characterChatModelId' },
  'librarian.prose-transform': { providerId: 'proseTransformProviderId', modelId: 'proseTransformModelId' },
  'librarian.chat': { providerId: 'librarianChatProviderId', modelId: 'librarianChatModelId' },
  'librarian.refine': { providerId: 'librarianRefineProviderId', modelId: 'librarianRefineModelId' },
  directions: { providerId: 'directionsProviderId', modelId: 'directionsModelId' },
}

// Provider cache includes every setting baked into the provider instance. The
// name matters because it also defines the providerOptions namespace.
const providerCache = new Map<string, ReturnType<typeof createOpenAICompatible>>()
const googleProviderCache = new Map<string, ReturnType<typeof createGoogleGenerativeAI>>()

function getCachedProvider(id: string, baseURL: string, apiKey: string, name: string, customHeaders?: Record<string, string>) {
  const headerStr = customHeaders ? JSON.stringify(customHeaders) : ''
  const cacheKey = `${id}:${name}:${baseURL}:${apiKey}:${headerStr}`
  let provider = providerCache.get(cacheKey)
  if (!provider) {
    provider = createOpenAICompatible({
      name,
      baseURL,
      apiKey,
      includeUsage: true,
      headers: customHeaders && Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    })
    providerCache.set(cacheKey, provider)
  }
  return provider
}

function getCachedGoogleProvider(
  id: string,
  baseURL: string,
  apiKey: string,
  customHeaders?: Record<string, string>,
) {
  const headerStr = customHeaders ? JSON.stringify(customHeaders) : ''
  const cacheKey = `${id}:${baseURL}:${apiKey}:${headerStr}`
  let provider = googleProviderCache.get(cacheKey)
  if (!provider) {
    provider = createGoogleGenerativeAI({
      apiKey,
      baseURL,
      headers: customHeaders && Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    })
    googleProviderCache.set(cacheKey, provider)
  }
  return provider
}

export type ProviderOptions = NonNullable<ToolLoopAgentSettings['providerOptions']>

/**
 * Build providerOptions that suppress extended thinking / reasoning.
 * Returns undefined when thinking should remain enabled.
 */
export function buildProviderOptions(disableThinking: boolean): ProviderOptions | undefined {
  if (!disableThinking) return undefined
  return { openaiCompatible: { reasoningEffort: 'none' } }
}

/** Provider-boundary translation for OpenAI-compatible sampling extensions. */
export function translateOpenAICompatibleTopK(
  params: LanguageModelV3CallOptions,
  providerOptionsKey: string,
): LanguageModelV3CallOptions {
  if (params.topK == null) return params
  const existing = params.providerOptions?.[providerOptionsKey]
  const providerOptions = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing
    : {}
  return {
    ...params,
    topK: undefined,
    providerOptions: {
      ...params.providerOptions,
      [providerOptionsKey]: { ...providerOptions, top_k: params.topK },
    },
  }
}

function openAICompatibleSamplingMiddleware(providerOptionsKey: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => translateOpenAICompatibleTopK(params, providerOptionsKey),
  }
}

export interface GenerationGuards {
  /** Undefined delegates the output length to the provider/model. */
  maxOutputTokens?: number
}

/**
 * Resolve opt-in per-generation safety settings. Output length is deliberately
 * unbounded by Errata when unset so reasoning-capable models can use the budget
 * exposed by their provider and context window.
 */
export function resolveGenerationGuards(
  limits?: { maxOutputTokens?: number },
): GenerationGuards {
  return {
    maxOutputTokens: limits?.maxOutputTokens,
  }
}

export interface ResolvedModel extends SamplingSettings {
  model: LanguageModel
  providerId: string | null
  modelId: string
  config: {
    providerName: string | null
    baseURL: string | null
    headers: Record<string, string>
  }
}

export interface GetModelOptions {
  role?: string
}

/**
 * Resolve the model to use for a given story.
 * Checks modelOverrides map first, then legacy fields, walking the role's fallback chain.
 */
export async function getModel(dataDir: string, storyId?: string, opts: GetModelOptions = {}): Promise<ResolvedModel> {
  ensureCoreAgentsRegistered()

  const role = opts.role ?? 'generation'
  const chain = modelRoleRegistry.getFallbackChain(role)

  // 1. Try to resolve from story settings by walking the fallback chain
  let targetProviderId: string | null = null
  let targetModelId: string | null = null
  let targetTemperature: number | undefined = undefined
  let targetTopP: number | undefined = undefined
  let targetTopK: number | undefined = undefined

  if (storyId) {
    const story = await getStory(dataDir, storyId)
    if (story?.settings) {
      const overrides = normalizeOverrideKeys(story.settings.modelOverrides ?? {})
      const settings = story.settings as Record<string, unknown>

      for (const r of chain) {
        const override = overrides[r]
        if (targetTopP === undefined && override?.topP != null) targetTopP = override.topP
        if (targetTopK === undefined && override?.topK != null) targetTopK = override.topK
      }

      for (const r of chain) {
        // Check modelOverrides map first
        const override = overrides[r]
        if (!targetModelId && override?.modelId) {
          targetModelId = override.modelId
        }
        if (override?.providerId) {
          targetProviderId = override.providerId
          targetModelId = targetModelId || override.modelId || null
          if (override.temperature != null) {
            targetTemperature = override.temperature
          }
          break
        }
        // Fall back to legacy fields
        const legacy = LEGACY_FIELD_MAP[r]
        if (legacy) {
          const pid = settings[legacy.providerId] as string | null | undefined
          if (pid) {
            targetProviderId = pid
            targetModelId = (settings[legacy.modelId] as string | null | undefined) ?? null
            break
          }
        }
      }

      // If no temperature from the matched role override, check if any role in chain has temperature set
      if (targetTemperature === undefined) {
        for (const r of chain) {
          const override = overrides[r]
          if (override?.temperature != null) {
            targetTemperature = override.temperature
            break
          }
        }
      }
    }
  }

  // 2. Load global config
  const globalConfig = await getGlobalConfig(dataDir)

  // 3. Build the candidate list in priority order: the story's configured
  //    provider, then the global default. This way a story that points at a
  //    now-disabled or deleted provider falls back to the default instead of
  //    hard-failing with "No provider configured".
  const candidateIds: string[] = []
  if (targetProviderId) candidateIds.push(targetProviderId)
  if (globalConfig.defaultProviderId && globalConfig.defaultProviderId !== targetProviderId) {
    candidateIds.push(globalConfig.defaultProviderId)
  }

  // 4. Use the first candidate that exists and is enabled.
  for (const candidateId of candidateIds) {
    const provider = globalConfig.providers.find((p) => p.id === candidateId && p.enabled)
    if (!provider) continue

    // When the story explicitly chose a provider that turned out unusable and we
    // fell through to the default, its stored modelId belongs to the old provider
    // — use the fallback provider's default model instead.
    const usingFallback = targetProviderId != null && candidateId !== targetProviderId
    const modelId = (usingFallback ? null : targetModelId) || provider.defaultModel
    const nativeGemini = isGeminiProvider(provider)
    const baseURL = nativeGemini ? normalizeGeminiBaseURL(provider.baseURL) : provider.baseURL
    const providerOptionsKey = provider.name.split('.')[0].trim()
    const rawModel = nativeGemini
      ? getCachedGoogleProvider(provider.id, baseURL, provider.apiKey, provider.customHeaders)(modelId)
      : getCachedProvider(provider.id, provider.baseURL, provider.apiKey, provider.name, provider.customHeaders).chatModel(modelId)
    const model = nativeGemini
      ? rawModel
      : wrapLanguageModel({ model: rawModel, middleware: openAICompatibleSamplingMiddleware(providerOptionsKey) })
    // Story-level temperature takes precedence over provider-level
    const temperature = targetTemperature ?? provider.temperature
    const toReturn = {
      model,
      providerId: provider.id,
      modelId,
      temperature,
      topP: targetTopP,
      topK: targetTopK,
      config: {
        providerName: provider.name,
        baseURL,
        headers: { ...(provider.customHeaders ?? {}) },
      },
    }
    createLogger("models").debug('Resolved model', {...toReturn, model: "[hidden]"}) // Don't log the full model object to avoid spam
    return toReturn
  }

  // 5. No provider found — throw descriptive error
  throw new Error('No LLM provider configured. Add a provider in Settings > Providers.')
}

/**
 * Everything an agent's `ToolLoopAgent` construction needs beyond its role's
 * resolved model: the thinking toggle and the per-generation safety caps, both
 * derived from `story.settings` rather than the role. Bundling them here means
 * a new cross-cutting knob (the next one, whatever it is) is a one-place change
 * instead of a re-edit of every agent construction site.
 */
export interface AgentRuntime extends ResolvedModel {
  providerOptions?: ProviderOptions
  guards: GenerationGuards
}

/** Settings that can be spread directly into AI SDK generation calls. */
export function samplingCallSettings(runtime: SamplingSettings): SamplingSettings {
  return {
    temperature: runtime.temperature,
    topP: runtime.topP,
    topK: runtime.topK,
  }
}

/** Serializable effective settings for logs and saved diagnostics. */
export function samplingDiagnostics(runtime: SamplingSettings): SamplingSettings {
  return {
    ...(runtime.temperature !== undefined ? { temperature: runtime.temperature } : {}),
    ...(runtime.topP !== undefined ? { topP: runtime.topP } : {}),
    ...(runtime.topK !== undefined ? { topK: runtime.topK } : {}),
  }
}

/**
 * Resolve a role's model plus the story-level runtime knobs (`disableThinking`,
 * `generationLimits`) in one call. Takes `story` rather than reloading it —
 * every call site already has it (fetched for its own settings checks), so this
 * never hides a redundant fetch behind a "just resolve everything" call.
 */
export async function resolveAgentRuntime(
  dataDir: string,
  storyId: string,
  role: string,
  story: StoryMeta,
): Promise<AgentRuntime> {
  const resolved = await getModel(dataDir, storyId, { role })
  return {
    ...resolved,
    providerOptions: buildProviderOptions(story.settings.disableThinking ?? false),
    guards: resolveGenerationGuards(story.settings.generationLimits),
  }
}
