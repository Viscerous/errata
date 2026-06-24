import type { ToolSet } from 'ai'
import type { ContextBlock } from '../llm/context-builder'
import type { AgentBlockContext } from './agent-block-context'

export interface AgentBlockDefinition {
  agentName: string
  displayName: string
  description: string
  createDefaultBlocks: (ctx: AgentBlockContext) => ContextBlock[]
  availableTools?: string[]
  /**
   * Resolve the tools the agent sends to the model, built from the same
   * factories the runtime handler uses, so the context preview shows a faithful
   * no-drift catalog. Optional — without it the preview omits the tools section.
   */
  resolveTools?: (args: { dataDir: string; storyId: string }) => ToolSet | Promise<ToolSet>
  buildPreviewContext: (dataDir: string, storyId: string) => Promise<AgentBlockContext>
}

class AgentBlockRegistry {
  private definitions = new Map<string, AgentBlockDefinition>()

  register(def: AgentBlockDefinition): void {
    this.definitions.set(def.agentName, def)
  }

  get(name: string): AgentBlockDefinition | undefined {
    return this.definitions.get(name)
  }

  list(): AgentBlockDefinition[] {
    return [...this.definitions.values()]
  }

  clear(): void {
    this.definitions.clear()
  }
}

export const agentBlockRegistry = new AgentBlockRegistry()
