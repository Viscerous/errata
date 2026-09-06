import {
  auditGenerationInputSurface,
  createGenerationInputBlocks,
  createPlanningRequest,
} from '../src/server/llm/generation-input-contract'
import { instructionRegistry } from '../src/server/instructions'
import { buildInstructionInventory } from '../src/server/instructions/inventory'
import { agentRegistry } from '../src/server/agents/registry'
import { agentBlockRegistry } from '../src/server/agents/agent-block-registry'
import { registerChapterAgents } from '../src/server/chapters/agents'
import { registerCharacterChatAgents } from '../src/server/character-chat/agents'
import { registerDirectionsAgents } from '../src/server/directions/agents'
import { registerGenerationBlocks } from '../src/server/llm/agents'
import { registerLibrarianAgents } from '../src/server/librarian/agents'
import { registerStorySetupAgents } from '../src/server/story-setup/agents'

registerChapterAgents()
registerCharacterChatAgents()
registerDirectionsAgents()
registerGenerationBlocks()
registerLibrarianAgents()
registerStorySetupAgents()

function writeTable(title: string, rows: Array<Record<string, string | number>>): void {
  const columns = Object.keys(rows[0] ?? {})
  const widths = columns.map(column => Math.max(
    column.length,
    ...rows.map(row => String(row[column]).length),
  ))
  const line = (cells: Array<string | number>) => `| ${cells.map((cell, index) => String(cell).padEnd(widths[index])).join(' | ')} |\n`
  process.stdout.write(`\n${title}\n`)
  process.stdout.write(line(columns))
  process.stdout.write(line(widths.map(width => '-'.repeat(width))))
  for (const row of rows) process.stdout.write(line(columns.map(column => row[column])))
}

const instructionInventory = buildInstructionInventory()
const instructionKeysByAgent = new Map<string, string[]>()
for (const instruction of instructionInventory) {
  const keys = instructionKeysByAgent.get(instruction.usedBy) ?? []
  keys.push(instruction.key)
  instructionKeysByAgent.set(instruction.usedBy, keys)
}
const blockDefinitions = new Map(agentBlockRegistry.list().map(definition => [definition.agentName, definition]))
const runtimeAgents = new Map(agentRegistry.list().map(agent => [agent.name, agent]))

writeTable('Instruction inventory', instructionInventory.map(entry => ({
  agent: entry.usedBy,
  key: entry.key,
  kind: entry.kind,
  characters: entry.characters,
  estimatedTokens: entry.estimatedTokens,
  placeholders: entry.placeholders.join(', ') || '—',
})))

const agentNames = [...new Set([
  ...runtimeAgents.keys(),
  ...blockDefinitions.keys(),
  ...instructionKeysByAgent.keys(),
])].sort()
writeTable('Agent prompt surfaces', agentNames
  .map((agentName) => {
    const agent = runtimeAgents.get(agentName)
    const blocks = blockDefinitions.get(agentName)
    const instructions = instructionInventory.filter(entry => entry.usedBy === agentName)
    return {
      agent: agentName,
      instructionParts: instructions.length,
      instructionTokens: instructions.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
      contextBlocks: blocks ? 'yes' : 'no',
      advertisedTools: blocks?.availableTools?.length ?? 0,
      callableAgents: agent?.allowedCalls?.length ?? 0,
    }
  }))

const authorInput = '[AUTHOR INPUT]'
const surfaces = [
  {
    name: 'standard writer',
    mode: 'direct',
    blocks: createGenerationInputBlocks({ authorInput, inputMode: 'direct' }),
  },
  {
    name: 'standard writer',
    mode: 'play',
    blocks: createGenerationInputBlocks({ authorInput, inputMode: 'play' }),
  },
  {
    name: 'prewriter planner',
    mode: 'direct',
    blocks: [{ id: 'planning-request', content: createPlanningRequest(authorInput, 'direct', 'generate') }],
  },
  {
    name: 'prewriter planner',
    mode: 'play',
    blocks: [{ id: 'planning-request', content: createPlanningRequest(authorInput, 'play', 'generate') }],
  },
  {
    name: 'brief writer',
    mode: 'direct',
    blocks: [],
  },
  {
    name: 'brief writer',
    mode: 'play',
    blocks: createGenerationInputBlocks({
      authorInput,
      inputMode: 'play',
      inputBlockId: 'author-story-turn',
      inputOrder: 300,
    }),
  },
] as const

const rows = surfaces.map((surface) => {
  const audit = auditGenerationInputSurface(surface.blocks, authorInput)
  return {
    surface: surface.name,
    mode: surface.mode,
    inputBlocks: surface.blocks.map(block => block.id).join(', ') || '(none)',
    inputCopies: audit.authorInputOccurrences,
    outputContracts: audit.playOutputContractBlocks,
    turnDelimiters: `${audit.openingStoryTurnTags}/${audit.closingStoryTurnTags}`,
    inputCharacters: audit.characters,
  }
})

writeTable('Generation input contract', rows)

if (process.argv.includes('--verbose')) {
  for (const entry of instructionRegistry.listEntries()
    .slice()
    .sort((left, right) => left.key.localeCompare(right.key))) {
    process.stdout.write(`\n## ${entry.key}\n\n${entry.text}\n`)
  }
  for (const surface of surfaces) {
    process.stdout.write(`\n## ${surface.name} · ${surface.mode}\n`)
    for (const block of surface.blocks) {
      process.stdout.write(`\n### ${block.id}\n\n${block.content}\n`)
    }
  }
}

// Some agent modules own long-lived runtime resources. This command only reads
// registration metadata, so finish once the report has been printed.
process.exit(0)
