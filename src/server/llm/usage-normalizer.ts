import type { TokenUsage } from './generation-logs'
import { reportUsage } from './token-tracker'

function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function readFirstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = toNumber(obj[key])
    if (typeof parsed === 'number') return parsed
  }
  return undefined
}

/**
 * Normalizes token usage across providers/SDKs.
 * Supports:
 * - AI SDK style: { inputTokens, outputTokens }
 * - OpenAI-style camelCase: { promptTokens, completionTokens }
 * - OpenAI-style snake_case: { prompt_tokens, completion_tokens }
 * - Nested OpenAI response: { usage: { ... } }
 */
export function normalizeTokenUsage(rawUsage: unknown): TokenUsage | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined

  const top = rawUsage as Record<string, unknown>
  const nestedUsage = top.usage && typeof top.usage === 'object'
    ? (top.usage as Record<string, unknown>)
    : null

  const inputTokens =
    readFirstNumber(top, ['inputTokens', 'promptTokens', 'prompt_tokens', 'input_tokens']) ??
    (nestedUsage ? readFirstNumber(nestedUsage, ['inputTokens', 'promptTokens', 'prompt_tokens', 'input_tokens']) : undefined)

  const outputTokens =
    readFirstNumber(top, ['outputTokens', 'completionTokens', 'completion_tokens', 'output_tokens']) ??
    (nestedUsage ? readFirstNumber(nestedUsage, ['outputTokens', 'completionTokens', 'completion_tokens', 'output_tokens']) : undefined)

  if (typeof inputTokens !== 'number' && typeof outputTokens !== 'number') return undefined

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  }
}

/**
 * Await a stream's `totalUsage`, normalize it, and report it — the
 * try/await/normalize/report/catch sequence every agent needs once its stream
 * completes, in one place so a new call site can't quietly skip it (librarian
 * chat did, until this was centralized). Swallows failures: some providers
 * never resolve usage. Returns the normalized usage so callers that also need
 * the value (a saved generation log, a returned result field) don't re-derive it.
 */
export async function resolveAndReportUsage(
  dataDir: string,
  storyId: string,
  source: string,
  totalUsage: PromiseLike<unknown>,
  modelId?: string,
): Promise<TokenUsage | undefined> {
  try {
    const usage = normalizeTokenUsage(await totalUsage)
    if (usage) reportUsage(dataDir, storyId, source, usage, modelId)
    return usage
  } catch {
    return undefined
  }
}
