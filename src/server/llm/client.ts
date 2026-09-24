import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { getGlobalConfig } from '../config/storage'
import { getStory } from '../fragments/storage'
import { modelRoleRegistry } from '../agents/model-role-registry'
import {
  extractReasoningMiddleware,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ToolLoopAgentSettings,
} from 'ai'
import { createLogger } from '../logging'
import type { SamplingSettings, StoryMeta } from '@/contracts/story'
import { isGeminiProvider, normalizeGeminiBaseURL } from '../config/provider-urls'
import { PROVIDER_PRESETS, isPresetId } from '@/contracts/providers'

type ModelOverride = StoryMeta['settings']['modelOverrides'][string]

// Provider cache includes every setting baked into the provider instance. The
// name matters because it also defines the providerOptions namespace.
const providerCache = new Map<string, ReturnType<typeof createOpenAICompatible>>()
const googleProviderCache = new Map<string, ReturnType<typeof createGoogleGenerativeAI>>()

function getCachedProvider(
  id: string,
  baseURL: string,
  apiKey: string,
  name: string,
  customHeaders: Record<string, string> | undefined,
  structuredOutput: boolean,
) {
  const headerStr = customHeaders ? JSON.stringify(customHeaders) : ''
  const cacheKey = `${id}:${name}:${baseURL}:${apiKey}:${headerStr}:${structuredOutput}`
  let provider = providerCache.get(cacheKey)
  if (!provider) {
    provider = createOpenAICompatible({
      name,
      baseURL,
      apiKey,
      includeUsage: true,
      supportsStructuredOutputs: structuredOutput,
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
 * Resolve the story's explicit per-generation limits. Every request is also
 * bounded by the size of its answer plus the reasoning allowance (see
 * output-budget.ts); an explicit limit applies only where it is lower.
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
  /** Whether the provider constrains a JSON-schema response format while decoding. */
  structuredOutput: boolean
  /** Configured reasoning tokens per structured request for this model, if any. */
  reasoningAllowance?: number
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
 * Walks the role's fallback chain through the story's model overrides.
 */
export async function getModel(dataDir: string, storyId?: string, opts: GetModelOptions = {}): Promise<ResolvedModel> {
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
      const overrides: Record<string, ModelOverride> = story.settings.modelOverrides ?? {}

      for (const r of chain) {
        const override = overrides[r]
        if (targetTopP === undefined && override?.topP != null) targetTopP = override.topP
        if (targetTopK === undefined && override?.topK != null) targetTopK = override.topK
      }

      for (const r of chain) {
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
    const structuredOutput = !nativeGemini && (
      provider.structuredOutput ?? (isPresetId(provider.preset) && PROVIDER_PRESETS[provider.preset].structuredOutput)
    )
    const rawModel = nativeGemini
      ? getCachedGoogleProvider(provider.id, baseURL, provider.apiKey, provider.customHeaders)(modelId)
      : getCachedProvider(provider.id, provider.baseURL, provider.apiKey, provider.name, provider.customHeaders, structuredOutput).chatModel(modelId)
    const model = nativeGemini
      ? rawModel
      : wrapLanguageModel({
          model: rawModel,
          middleware: [
            openAICompatibleSamplingMiddleware(providerOptionsKey),
            extractReasoningMiddleware({ tagName: 'think' }),
          ],
        })
    // Story-level temperature takes precedence over provider-level
    const temperature = targetTemperature ?? provider.temperature
    const toReturn = {
      model,
      providerId: provider.id,
      modelId,
      structuredOutput,
      ...(provider.reasoningAllowance?.[modelId] !== undefined ? { reasoningAllowance: provider.reasoningAllowance[modelId] } : {}),
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
  /** Whether the story lets the model reason before answering. */
  thinkingEnabled: boolean
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
    thinkingEnabled: story.settings.disableThinking !== true,
  }
}
