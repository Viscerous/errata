import type { ToolSet } from 'ai'
import type { WritingPlugin } from '../plugins/types'
import type { BuildContextOptions, ContextBlock, ContextBuildState, ContextMessage } from './context-builder'
import { buildContextState, createDefaultBlocks, compileBlocks, expandMessagesFragmentTags } from './context-builder'
import { getAgentBlockConfig } from '../agents/agent-block-storage'
import type { AgentBlockConfig } from '../agents/agent-block-storage'
import { applyBlockConfig } from '../blocks/apply'
import { createScriptHelpers } from '../blocks/script-context'
import { runBeforeBlocks, runBeforeContext, runBeforeGeneration } from '../plugins/hooks'
import { collectPluginToolsWithOrigin } from '../plugins/tools'
import { createFragmentTools } from './tools'

export interface PreparedGenerationWriterSurface {
  ctxState: ContextBuildState
  blocks: ContextBlock[]
  tools: ToolSet
  /** Unfiltered tools passed to the prewriter, which applies its own config. */
  allTools: ToolSet
  agentConfig: AgentBlockConfig
  pluginToolDescriptions: Array<{
    name: string
    description: string
    pluginName?: string
  }>
  ignoredPluginTools: Array<{ name: string; pluginName?: string }>
}

export interface CompiledGenerationWriterContext extends PreparedGenerationWriterSurface {
  messages: ContextMessage[]
}

/**
 * Compile the final model-visible messages from already configured blocks.
 * Fragment expansion deliberately follows beforeGeneration: plugin-injected
 * references must resolve exactly as references authored by a context block do.
 */
export async function finalizeGenerationMessages(
  blocks: ContextBlock[],
  enabledPlugins: WritingPlugin[],
  dataDir: string,
  storyId: string,
): Promise<ContextMessage[]> {
  let messages = compileBlocks(blocks)
  messages = await runBeforeGeneration(enabledPlugins, messages)
  return expandMessagesFragmentTags(messages, dataDir, storyId)
}

/**
 * Build the Writer surface from a context state that has already passed through
 * beforeContext. Runtime generation and previews share this function so tool
 * precedence, block customization, hooks, and fragment expansion cannot drift.
 */
export async function prepareGenerationWriterSurface(args: {
  dataDir: string
  storyId: string
  ctxState: ContextBuildState
  enabledPlugins: WritingPlugin[]
  modelId?: string
}): Promise<PreparedGenerationWriterSurface> {
  const { dataDir, storyId, enabledPlugins, modelId } = args
  const ctxState = modelId ? { ...args.ctxState, modelId } : args.ctxState

  const fragmentTools = createFragmentTools(dataDir, storyId, { readOnly: true })
  const { tools: pluginTools, origins: pluginToolOrigins } = collectPluginToolsWithOrigin(enabledPlugins, dataDir, storyId)
  const allTools: ToolSet = { ...fragmentTools }
  const ignoredPluginTools: Array<{ name: string; pluginName?: string }> = []
  for (const [name, tool] of Object.entries(pluginTools)) {
    if (name in allTools) {
      ignoredPluginTools.push({ name, pluginName: pluginToolOrigins[name] })
      continue
    }
    allTools[name] = tool
  }

  const pluginToolDescriptions = Object.entries(pluginTools)
    .filter(([name]) => name in allTools && !ignoredPluginTools.some((ignored) => ignored.name === name))
    .map(([name, tool]) => ({
      name,
      description: (tool as { description?: string }).description ?? '',
      pluginName: pluginToolOrigins[name],
    }))

  const agentConfig = await getAgentBlockConfig(dataDir, storyId, 'generation.writer')
  const disabledTools = new Set(agentConfig.disabledTools ?? [])
  const tools: ToolSet = {}
  for (const [name, tool] of Object.entries(allTools)) {
    if (!disabledTools.has(name)) tools[name] = tool
  }

  let blocks = createDefaultBlocks(ctxState)
  blocks = await applyBlockConfig(blocks, agentConfig, {
    ...ctxState,
    ...createScriptHelpers(dataDir, storyId),
  })
  blocks = await runBeforeBlocks(enabledPlugins, blocks)

  return {
    ctxState,
    blocks,
    tools,
    allTools,
    agentConfig,
    pluginToolDescriptions,
    ignoredPluginTools,
  }
}

export async function compileGenerationWriterContext(args: {
  dataDir: string
  storyId: string
  authorInput: string
  enabledPlugins: WritingPlugin[]
  contextOptions?: BuildContextOptions
  modelId?: string
}): Promise<CompiledGenerationWriterContext> {
  const { dataDir, storyId, authorInput, enabledPlugins, contextOptions, modelId } = args

  let ctxState = await buildContextState(dataDir, storyId, authorInput, contextOptions)
  ctxState = await runBeforeContext(enabledPlugins, ctxState)
  const prepared = await prepareGenerationWriterSurface({ dataDir, storyId, ctxState, enabledPlugins, modelId })
  const messages = await finalizeGenerationMessages(prepared.blocks, enabledPlugins, dataDir, storyId)
  return { ...prepared, messages }
}
