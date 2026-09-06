/**
 * Registry of the app's built-in instruction strings, keyed by name (e.g.
 * `generation.system`, `librarian.chat.system`). Agents register their defaults
 * at startup and resolve them at request time.
 *
 * Model-specific JSON overrides (`data/instruction-sets/*.json`) were removed:
 * per-agent block configuration supersedes them. `resolve` keeps its optional
 * `modelId` parameter for call-site compatibility, but ignores it.
 */
export type InstructionKind = 'system' | 'contract' | 'template'

export interface InstructionMetadata {
  /** Agent/model call that receives this text. */
  usedBy: string
  /** How the text participates in that call. */
  kind: InstructionKind
}

export interface RegisteredInstruction extends Partial<InstructionMetadata> {
  key: string
  text: string
}

class InstructionRegistry {
  private defaults = new Map<string, RegisteredInstruction>()

  registerDefault(key: string, text: string, metadata: Partial<InstructionMetadata> = {}): void {
    this.defaults.set(key, { key, text, ...metadata })
  }

  resolve(key: string, _modelId?: string): string {
    const entry = this.defaults.get(key)
    if (entry === undefined) {
      throw new Error(`Instruction key "${key}" not registered`)
    }
    return entry.text
  }

  getDefault(key: string): string | undefined {
    return this.defaults.get(key)?.text
  }

  listKeys(): string[] {
    return [...this.defaults.keys()]
  }

  listEntries(): RegisteredInstruction[] {
    return [...this.defaults.values()].map(entry => ({ ...entry }))
  }

  clear(): void {
    this.defaults.clear()
  }
}

export const instructionRegistry = new InstructionRegistry()

/**
 * Last-resort system prompt used when a compiled agent context is missing its
 * system message. Every agent registers a real prompt, so this firing means a
 * block-compilation bug — shared here so the sentinel is greppable in one place.
 */
export const MISSING_SYSTEM_PROMPT_FALLBACK = 'You are a helpful assistant.'
