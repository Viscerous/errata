// NDJSON event types emitted by agent streams
export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; toolName: string; result: unknown }
  | { type: 'tool-error'; id: string; toolName: string; error: string }
  | { type: 'finish'; finishReason: string; stepCount: number; stopped?: boolean }

export interface AgentStreamCompletion {
  text: string
  reasoning: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>
  toolErrors: Array<{ toolName: string; error: string }>
  stepCount: number
  finishReason: string
  /** The model the provider reports answered; see `DrainedAgentStream`. */
  servedModelId?: string
}

/** Completion produced by the shared runner after usage/model normalization. */
export interface ResolvedAgentStreamCompletion extends AgentStreamCompletion {
  modelId: string
}

export interface AgentStreamResult {
  eventStream: ReadableStream<string>
  completion: Promise<AgentStreamCompletion>
}

export interface ResolvedAgentStreamResult extends AgentStreamResult {
  completion: Promise<ResolvedAgentStreamCompletion>
}
