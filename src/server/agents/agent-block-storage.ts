import { readFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { CustomBlockDefinition, BlockOverride } from '../blocks/schema'
import {
  AgentBlockConfigSchema,
  type AgentBlockConfig,
  type AgentBlockConfigInput,
} from '@/contracts/block-config'
import { getContentRoot } from '../fragments/branches'
import { writeJsonAtomic, withStorageLock } from '../fs-utils'

export { AgentBlockConfigSchema }
export type { AgentBlockConfig, AgentBlockConfigInput }

const DISABLED_TOOL_MIGRATIONS: Record<string, string[]> = {
  getFragment: ['readFragments'],
  searchFragments: ['findFragments'],
  getStorySummary: ['readStorySummary'],
  updateStorySummary: ['editFragments'],
  createFragment: ['editFragments'],
  updateFragment: ['editFragments'],
  editFragment: ['editFragments'],
  deleteFragment: ['editFragments'],
  suggestFragment: ['editFragments'],
  suggestEdit: ['editFragments'],
  // Legacy write-tool names → the single direct edit tools.
  proposeProseChanges: ['editProse'],
  applyProposedChanges: ['editFragments'],
  updateSummary: ['reportAnalysis'],
  reportMentions: ['reportAnalysis'],
  reportContradictions: ['reportAnalysis'],
  reportTimeline: ['reportAnalysis'],
  suggestDirections: ['proposeDirections'],
  askQuestions: ['askClarifyingQuestions'],
  reanalyzeFragment: ['invokeAgent'],
  optimizeCharacter: ['invokeAgent'],
  inspectGeneration: ['inspectRun'],
}

function normalizeDisabledTools(disabledTools: string[]): string[] {
  const normalized = new Set<string>()
  for (const toolName of disabledTools) {
    const replacement = DISABLED_TOOL_MIGRATIONS[toolName]
    if (replacement) {
      for (const migrated of replacement) normalized.add(migrated)
    } else {
      normalized.add(toolName)
    }
  }
  return [...normalized]
}

async function agentBlockConfigPath(dataDir: string, storyId: string, agentName: string): Promise<string> {
  const root = await getContentRoot(dataDir, storyId)
  return join(root, 'agent-blocks', `${agentName}.json`)
}

function emptyConfig(): AgentBlockConfig {
  return { customBlocks: [], overrides: {}, blockOrder: [], disabledTools: [], disableAutoAnalysis: false }
}

export async function getAgentBlockConfig(dataDir: string, storyId: string, agentName: string): Promise<AgentBlockConfig> {
  const path = await agentBlockConfigPath(dataDir, storyId, agentName)
  return readAgentBlockConfig(path)
}

async function readAgentBlockConfig(path: string): Promise<AgentBlockConfig> {
  if (!existsSync(path)) return emptyConfig()
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = AgentBlockConfigSchema.parse(JSON.parse(raw))
    return { ...parsed, disabledTools: normalizeDisabledTools(parsed.disabledTools) }
  } catch (error) {
    throw new Error(`Unable to read agent block configuration at ${path}; the original file was left untouched`, { cause: error })
  }
}

async function writeAgentBlockConfig(path: string, config: AgentBlockConfigInput): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const parsed = AgentBlockConfigSchema.parse(config)
  await writeJsonAtomic(path, { ...parsed, disabledTools: normalizeDisabledTools(parsed.disabledTools) })
}

export async function saveAgentBlockConfig(dataDir: string, storyId: string, agentName: string, config: AgentBlockConfigInput): Promise<void> {
  const path = await agentBlockConfigPath(dataDir, storyId, agentName)
  await withStorageLock(path, () => writeAgentBlockConfig(path, config))
}

async function mutateAgentBlockConfig(
  dataDir: string,
  storyId: string,
  agentName: string,
  mutate: (config: AgentBlockConfig) => AgentBlockConfig | null,
): Promise<AgentBlockConfig | null> {
  const path = await agentBlockConfigPath(dataDir, storyId, agentName)
  return withStorageLock(path, async () => {
    const config = await readAgentBlockConfig(path)
    const result = mutate(config)
    if (!result) return null
    await writeAgentBlockConfig(path, result)
    return result
  })
}

export async function addAgentCustomBlock(
  dataDir: string,
  storyId: string,
  agentName: string,
  block: CustomBlockDefinition,
): Promise<AgentBlockConfig> {
  return (await mutateAgentBlockConfig(dataDir, storyId, agentName, (config) => {
    config.customBlocks.push(block)
    config.blockOrder.push(block.id)
    return config
  }))!
}

export async function updateAgentCustomBlock(
  dataDir: string,
  storyId: string,
  agentName: string,
  blockId: string,
  updates: Partial<Omit<CustomBlockDefinition, 'id'>>,
): Promise<AgentBlockConfig | null> {
  return mutateAgentBlockConfig(dataDir, storyId, agentName, (config) => {
    const idx = config.customBlocks.findIndex(b => b.id === blockId)
    if (idx === -1) return null
    config.customBlocks[idx] = { ...config.customBlocks[idx], ...updates }
    return config
  })
}

export async function deleteAgentCustomBlock(
  dataDir: string,
  storyId: string,
  agentName: string,
  blockId: string,
): Promise<AgentBlockConfig> {
  return (await mutateAgentBlockConfig(dataDir, storyId, agentName, (config) => {
    config.customBlocks = config.customBlocks.filter(b => b.id !== blockId)
    config.blockOrder = config.blockOrder.filter(id => id !== blockId)
    delete config.overrides[blockId]
    return config
  }))!
}

export async function updateAgentBlockOverrides(
  dataDir: string,
  storyId: string,
  agentName: string,
  overrides: Record<string, BlockOverride>,
  blockOrder?: string[],
): Promise<AgentBlockConfig> {
  return (await mutateAgentBlockConfig(dataDir, storyId, agentName, (config) => {
    for (const [id, override] of Object.entries(overrides)) {
      config.overrides[id] = { ...config.overrides[id], ...override }
    }
    if (blockOrder !== undefined) config.blockOrder = blockOrder
    return config
  }))!
}

export async function updateAgentDisabledTools(
  dataDir: string,
  storyId: string,
  agentName: string,
  disabledTools: string[],
): Promise<AgentBlockConfig> {
  return (await mutateAgentBlockConfig(dataDir, storyId, agentName, (config) => {
    config.disabledTools = normalizeDisabledTools(disabledTools)
    return config
  }))!
}
