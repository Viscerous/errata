/**
 * What the provider actually served, learned from responses.
 *
 * A configured model id is a request, not an observation. Against a local
 * llama.cpp endpoint it is a label on a port, so swapping the GGUF behind it
 * changes the weights and nothing else: a whole Qwen branch recorded itself as
 * Gemma, and the roll-up cache — whose invariant is that its key identifies the
 * weights — would have gone on serving nodes derived by a model no longer
 * loaded. Responses carry the id the server used, so the first completed call
 * after a swap corrects subsequent attribution and cache selection.
 *
 * In-memory by design: an observation older than the process has no claim on
 * what is loaded now.
 */
const observed = new Map<string, string>()

function observationKey(providerId: string | null, configuredModelId: string): string {
  return `${providerId ?? ''}\u0000${configuredModelId}`
}

/** Read the provider-reported identity from AI SDK response metadata. */
export function servedModelIdFromResponse(response: unknown): string | undefined {
  const modelId = (response as { modelId?: unknown } | undefined)?.modelId
  return typeof modelId === 'string' && modelId ? modelId : undefined
}

/**
 * Record what a completed call reports it was served by, and return the id this
 * call should be attributed to — the served one when the provider named it, the
 * configured one otherwise.
 */
export function recordServedModel(
  providerId: string | null,
  configuredModelId: string,
  servedModelId: string | undefined,
): string {
  const effectiveModelId = servedModelId || configuredModelId
  observed.set(observationKey(providerId, configuredModelId), effectiveModelId)
  return effectiveModelId
}

/**
 * The identity learned during this process, without pretending the configured
 * request label is an observation. Persistent caches use this to avoid trusting
 * an old local-model identity immediately after startup.
 */
export function getObservedServedModelId(
  providerId: string | null,
  configuredModelId: string,
): string | undefined {
  return observed.get(observationKey(providerId, configuredModelId))
}

/** Test seam; the map is process-local and never persisted. */
export function clearServedModelObservations(): void {
  observed.clear()
}
