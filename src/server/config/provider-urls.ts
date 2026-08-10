/**
 * Provider-shape questions asked in more than one place: the LLM client when it
 * builds a model, and the config routes when they probe one. Kept together so
 * the two cannot answer them differently — they were byte-identical copies, and
 * a provider that counted as Gemini in one and not the other would fail in ways
 * that look like a bad API key.
 */

export function isGeminiProvider(provider: { preset?: string; baseURL: string }): boolean {
  return provider.preset === 'gemini' || provider.baseURL.includes('generativelanguage.googleapis.com')
}

/**
 * Gemini's OpenAI-compatible shim lives at `/openai` under the same base as the
 * native API. Strip it so the native endpoints resolve.
 */
export function normalizeGeminiBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/openai$/, '')
}
