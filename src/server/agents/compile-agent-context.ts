import type { ToolSet } from 'ai'
import type { ContextBlock, ContextMessage } from '../llm/context-builder'
import { compileBlocks, expandMessagesFragmentTags } from '../llm/context-builder'
import { applyBlockConfig } from '../blocks/apply'
import { createScriptHelpers } from '../blocks/script-context'
import { agentBlockRegistry } from './agent-block-registry'
import { getAgentBlockConfig } from './agent-block-storage'
import type { AgentBlockContext } from './agent-block-context'

export interface CompiledAgentContext {
  messages: ContextMessage[]
  blocks: ContextBlock[]
  tools: ToolSet
}

export async function compileAgentContext(
  dataDir: string,
  storyId: string,
  agentName: string,
  blockContext: AgentBlockContext,
  allTools: ToolSet,
): Promise<CompiledAgentContext> {
  const def = agentBlockRegistry.get(agentName)
  if (!def) throw new Error(`No block definition for agent: ${agentName}`)

  // 1. Load config first so default blocks can align prompt text with disabled
  // tools before block overrides/custom blocks are applied.
  const config = await getAgentBlockConfig(dataDir, storyId, agentName)
  const disabledTools = new Set(config.disabledTools ?? [])
  const enabledTools = Object.keys(allTools).filter((name) => !disabledTools.has(name))
  const contextWithConfig: AgentBlockContext = {
    ...blockContext,
    disabledTools: config.disabledTools ?? [],
    enabledTools,
  }

  // 2. Create default blocks
  let blocks = def.createDefaultBlocks(contextWithConfig)

  const scriptContext = {
    ...contextWithConfig,
    ...createScriptHelpers(dataDir, storyId),
  }
  blocks = await applyBlockConfig(blocks, config, scriptContext)

  // 3. Compile blocks -> messages
  let messages = compileBlocks(blocks)
  messages = await expandMessagesFragmentTags(messages, dataDir, storyId)

  // 4. Filter tools
  const tools: ToolSet = {}
  for (const [name, tool] of Object.entries(allTools)) {
    if (!disabledTools.has(name)) tools[name] = tool
  }

  return { messages, blocks, tools }
}
