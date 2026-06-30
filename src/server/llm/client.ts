import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { getGlobalConfig } from '../config/storage'
import { getStory } from '../fragments/storage'
import { modelRoleRegistry } from '../agents/model-role-registry'
import { ensureCoreAgentsRegistered } from '../agents/register-core'
import type { LanguageModel, ToolLoopAgentSettings } from 'ai'
import { createLogger } from '../logging'
import type { StoryMeta } from '../fragments/schema'

// Normalize old camelCase modelOverrides keys to dot-separated agent names
const OVERRIDE_KEY_ALIASES: Record<string, string> = {
  characterChat: 'character-chat.chat',
  librarianChat: 'librarian.chat',
  librarianRefine: 'librarian.refine',
  proseTransform: 'librarian.prose-transform',
  prewriter: 'generation.prewriter',
}

/** Apply key aliases to a modelOverrides map, returning a normalized copy */
function normalizeOverrideKeys(
  overrides: Record<string, { providerId?: string | null; modelId?: string | null; temperature?: number | null }>,
): Record<string, { providerId?: string | null; modelId?: string | null; temperature?: number | null }> {
  const result: Record<string, { providerId?: string | null; modelId?: string | null; temperature?: number | null }> = {}
  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = OVERRIDE_KEY_ALIASES[key] ?? key
    // Don't overwrite if the new key already exists (new-style key takes priority)
    if (!(normalizedKey in result)) {
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

// Provider cache: keyed by `id:baseURL:apiKey`
const providerCache = new Map<string, ReturnType<typeof createOpenAICompatible>>()

function getCachedProvider(id: string, baseURL: string, apiKey: string, name: string, customHeaders?: Record<string, string>) {
  const headerStr = customHeaders ? JSON.stringify(customHeaders) : ''
  const cacheKey = `${id}:${baseURL}:${apiKey}:${headerStr}`
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

export type ProviderOptions = NonNullable<ToolLoopAgentSettings['providerOptions']>

/**
 * Build providerOptions that suppress extended thinking / reasoning.
 * Returns undefined when thinking should remain enabled.
 */
export function buildProviderOptions(disableThinking: boolean): ProviderOptions | undefined {
  if (!disableThinking) return undefined
  return { openaiCompatible: { reasoningEffort: 'none' } }
}

/**
 * Default per-generation cap. Bounds a single LLM step so a runaway or looping
 * generation fails fast instead of streaming until the request timeout. Sized
 * with headroom over the largest legitimate output (a full whole-field rewrite),
 * so it truncates loops, not real work. Tunable per story via
 * `settings.generationLimits.maxOutputTokens`.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192

export interface GenerationGuards {
  maxOutputTokens: number
}

/**
 * Resolve the per-generation safety settings applied to every agent LLM call,
 * merging story-level overrides over the defaults. Centralized so the agent
 * construction sites stay in sync. Deliberately does not set sampling penalties
 * (frequency/presence) — those vary per model and are left to the provider/model.
 */
export function resolveGenerationGuards(
  limits?: { maxOutputTokens?: number },
): GenerationGuards {
  return {
    maxOutputTokens: limits?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }
}

export interface ResolvedModel {
  model: LanguageModel
  providerId: string | null
  modelId: string
  temperature?: number
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

  if (storyId) {
    const story = await getStory(dataDir, storyId)
    if (story?.settings) {
      const overrides = normalizeOverrideKeys(story.settings.modelOverrides ?? {})
      const settings = story.settings as Record<string, unknown>

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
    const oai = getCachedProvider(provider.id, provider.baseURL, provider.apiKey, provider.name, provider.customHeaders)
    const modelId = (usingFallback ? null : targetModelId) || provider.defaultModel
    // Story-level temperature takes precedence over provider-level
    const temperature = targetTemperature ?? provider.temperature
    const toReturn = {
      model: oai.chatModel(modelId),
      providerId: provider.id,
      modelId,
      temperature,
      config: {
        providerName: provider.name,
        baseURL: provider.baseURL,
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
