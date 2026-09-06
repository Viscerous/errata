import {
  auditGenerationInputSurface,
  createGenerationInputBlocks,
  createPlanningRequest,
} from '../src/server/llm/generation-input-contract'
import { instructionRegistry } from '../src/server/instructions'
import { PLAY_CONTINUATION_SYSTEM_PROMPT } from '../src/server/llm/instruction-texts'

instructionRegistry.registerDefault('generation.play-continuation', PLAY_CONTINUATION_SYSTEM_PROMPT)

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

console.table(rows)

if (process.argv.includes('--verbose')) {
  for (const surface of surfaces) {
    console.log(`\n## ${surface.name} · ${surface.mode}`)
    for (const block of surface.blocks) {
      console.log(`\n### ${block.id}\n\n${block.content}`)
    }
  }
}
