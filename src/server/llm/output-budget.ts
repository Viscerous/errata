import { DEFAULT_REASONING_ALLOWANCE } from '@/contracts/providers'

/**
 * Output budgets for structured tool calls.
 *
 * A tool's schema says how much a well-formed call can carry, so the largest
 * legitimate call is a property of the schema, not of the model. Reasoning is
 * the part that varies by model, and is budgeted separately by the caller.
 */

/**
 * JSON is denser than prose: short keys, digits, and punctuation tokenize
 * poorly. Three characters per token overestimates the token count of a
 * maximal call, which is the safe direction for a ceiling.
 */
const CHARS_PER_TOKEN = 3

/** Upper bound on the serialized JSON a schema admits. Unbounded constructs return Infinity. */
export function maxSerializedChars(node: unknown): number {
  if (!node || typeof node !== 'object') return 5
  const schema = node as Record<string, unknown>
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key]
    if (Array.isArray(options)) return Math.max(...options.map(maxSerializedChars))
  }
  if (Array.isArray(schema.enum)) return Math.max(...schema.enum.map((value) => JSON.stringify(value).length))
  if (schema.const !== undefined) return JSON.stringify(schema.const).length
  switch (schema.type) {
    case 'string':
      return (typeof schema.maxLength === 'number' ? schema.maxLength : Infinity) + 2
    case 'number':
    case 'integer':
      return 16
    case 'boolean':
      return 5
    case 'array': {
      const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : Infinity
      return maxItems * (maxSerializedChars(schema.items) + 1) + 2
    }
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, unknown>
      return Object.entries(properties).reduce(
        (total, [key, value]) => total + key.length + 4 + maxSerializedChars(value),
        2,
      )
    }
  }
  return Infinity
}

/**
 * The most output a single tool-call request may produce: the largest call its
 * schema admits, plus the reasoning allowance when the model thinks. Undefined
 * when the schema is unbounded, leaving the limit to the provider.
 */
export function toolCallOutputCap(
  jsonSchema: unknown,
  reasoning: { enabled: boolean; allowance?: number },
): number | undefined {
  const chars = maxSerializedChars(jsonSchema)
  if (!Number.isFinite(chars)) return undefined
  const callTokens = Math.ceil(chars / CHARS_PER_TOKEN)
  return callTokens + (reasoning.enabled ? reasoning.allowance ?? DEFAULT_REASONING_ALLOWANCE : 0)
}

/**
 * The output cap for one structured request on a resolved runtime: the tool's
 * largest well-formed call plus the reasoning allowance, and no more. The
 * provider is the only party that can stop generation: a client abort does not
 * reliably reach it, and a degenerate continuation the server's tool-call parser
 * withholds never shows on the stream. An explicit story limit still applies
 * when it is lower.
 */
export function structuredOutputCap(
  tool: { inputSchema?: unknown } | undefined,
  runtime: { thinkingEnabled: boolean; reasoningAllowance?: number; guards: { maxOutputTokens?: number } },
): number | undefined {
  const schema = (tool?.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema
  const derived = schema
    ? toolCallOutputCap(schema, { enabled: runtime.thinkingEnabled, allowance: runtime.reasoningAllowance })
    : undefined
  const configured = runtime.guards.maxOutputTokens
  if (derived === undefined) return configured
  return configured === undefined ? derived : Math.min(derived, configured)
}

/**
 * The longest free-form answer a role legitimately writes in one request, a
 * prose passage or a chat reply: several thousand words, well beyond any
 * passage the writer produces.
 */
export const FREEFORM_ANSWER_TOKENS = 8_192

/**
 * The output cap for one free-form request: the longest legitimate answer plus
 * the reasoning allowance when the model thinks. Without it a sampling loop in
 * reasoning or prose runs until the context window fills, since nothing but
 * the provider's token limit can stop generation. An explicit story limit
 * still applies when it is lower.
 */
export function freeformOutputCap(
  runtime: { thinkingEnabled: boolean; reasoningAllowance?: number; guards: { maxOutputTokens?: number } },
): number {
  const derived = FREEFORM_ANSWER_TOKENS
    + (runtime.thinkingEnabled ? runtime.reasoningAllowance ?? DEFAULT_REASONING_ALLOWANCE : 0)
  const configured = runtime.guards.maxOutputTokens
  return configured === undefined ? derived : Math.min(derived, configured)
}
