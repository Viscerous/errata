export type ProviderKind = 'cloud' | 'local' | 'custom'

export interface ProviderModelInfo {
  id: string
  owned_by?: string
  isFree?: boolean
  /** Advertised total context window. Absent when the backend does not state one. */
  contextWindow?: number
}

export interface ProviderPresetDefinition {
  name: string
  baseURL: string
  defaultModel: string
  models?: readonly string[]
  description: string
  kind: ProviderKind
  requiresApiKey: boolean
  accent: string
  customHeaders: Readonly<Record<string, string>>
  /**
   * Whether the server constrains a JSON-schema response format while decoding.
   * Where it does, structured requests are answered in that format, so the
   * schema bounds what the model can emit; elsewhere they go through tool calls.
   */
  structuredOutput: boolean
}

/**
 * Reasoning tokens a thinking model may spend per request when none is
 * configured for it: enough for models that think for tens of thousands of
 * tokens, so it only binds on a request that has stopped making progress.
 */
export const DEFAULT_REASONING_ALLOWANCE = 32_768

/**
 * The single provider catalogue used by validation, onboarding, settings, and
 * local discovery. A provider is a connection; models remain children of it.
 */
export const PROVIDER_PRESETS = {
  deepseek: {
    name: 'DeepSeek', baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    description: 'Fast and affordable. A strong default for fiction writing.',
    kind: 'cloud', requiresApiKey: true, accent: 'blue', structuredOutput: false, customHeaders: {},
  },
  openai: {
    name: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-5.2',
    description: 'OpenAI models through the native API.',
    kind: 'cloud', requiresApiKey: true, accent: 'emerald', structuredOutput: false, customHeaders: {},
  },
  anthropic: {
    name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', defaultModel: 'claude-opus-4-6',
    description: 'Claude models with strong long-form writing ability.',
    kind: 'cloud', requiresApiKey: true, accent: 'amber', structuredOutput: false, customHeaders: {},
  },
  gemini: {
    name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-3.5-flash',
    models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash'],
    description: 'Native Gemini models with tool use and long-context reasoning.',
    kind: 'cloud', requiresApiKey: true, accent: 'indigo', structuredOutput: false, customHeaders: {},
  },
  kimi: {
    name: 'Kimi', baseURL: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k2.5',
    description: 'Moonshot models through their OpenAI-compatible API.',
    kind: 'cloud', requiresApiKey: true, accent: 'cyan', structuredOutput: false, customHeaders: {},
  },
  'kimi-code': {
    name: 'Kimi Code', baseURL: 'https://api.kimi.com/coding/v1', defaultModel: 'kimi-for-coding',
    description: 'Kimi Code with its compatible client header.',
    kind: 'cloud', requiresApiKey: true, accent: 'rose', structuredOutput: false, customHeaders: { 'User-Agent': 'claude-code/1.0' },
  },
  openrouter: {
    name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat-v3-0324',
    description: 'Access many hosted models through one connection.',
    kind: 'cloud', requiresApiKey: true, accent: 'purple', structuredOutput: false, customHeaders: {},
  },
  zai: {
    name: 'Z.AI', baseURL: 'https://api.z.ai/api/paas/v4', defaultModel: 'glm-5',
    description: 'GLM models through the Z.AI API.',
    kind: 'cloud', requiresApiKey: true, accent: 'cyan', structuredOutput: false, customHeaders: {},
  },
  ollama: {
    name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', defaultModel: '',
    description: 'Models running locally through Ollama.',
    kind: 'local', requiresApiKey: false, accent: 'emerald', structuredOutput: true, customHeaders: {},
  },
  lmstudio: {
    name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', defaultModel: '',
    description: 'Models served locally by LM Studio.',
    kind: 'local', requiresApiKey: false, accent: 'amber', structuredOutput: true, customHeaders: {},
  },
  llamacpp: {
    name: 'llama.cpp', baseURL: 'http://127.0.0.1:8080/v1', defaultModel: '',
    description: 'A local llama.cpp OpenAI-compatible server.',
    kind: 'local', requiresApiKey: false, accent: 'blue', structuredOutput: true, customHeaders: {},
  },
  koboldcpp: {
    name: 'KoboldCpp', baseURL: 'http://127.0.0.1:5001/v1', defaultModel: '',
    description: 'A local KoboldCpp OpenAI-compatible server.',
    kind: 'local', requiresApiKey: false, accent: 'purple', structuredOutput: false, customHeaders: {},
  },
  omlx: {
    name: 'oMLX', baseURL: 'http://127.0.0.1:8000/v1', defaultModel: '',
    description: 'Models served locally by oMLX.',
    kind: 'local', requiresApiKey: false, accent: 'indigo', structuredOutput: false, customHeaders: {},
  },
  custom: {
    name: 'Custom', baseURL: '', defaultModel: '',
    description: 'Any OpenAI-compatible endpoint.',
    kind: 'custom', requiresApiKey: false, accent: 'neutral', structuredOutput: false, customHeaders: {},
  },
} as const satisfies Record<string, ProviderPresetDefinition>

export type PresetId = keyof typeof PROVIDER_PRESETS

export function providerPresetEntries() {
  return Object.entries(PROVIDER_PRESETS) as Array<[PresetId, (typeof PROVIDER_PRESETS)[PresetId]]>
}

export function isPresetId(value: string): value is PresetId {
  return value in PROVIDER_PRESETS
}
