import type { AuthorInputMode } from '@/contracts/generation'
import type { ContextBlock } from './context-builder'
import { instructionRegistry } from '../instructions'

export type GenerationOperation = 'generate' | 'regenerate' | 'refine'

/**
 * Build the model-facing Writer blocks for an explicit author input.
 *
 * Direct input is an instruction. Play input is the protagonist's intended move,
 * so it carries the staged play continuation contract and becomes the raw final user input.
 */
export function createGenerationInputBlocks(args: {
  authorInput: string
  inputMode: AuthorInputMode
  inputOrder?: number
}): ContextBlock[] {
  const {
    authorInput,
    inputMode,
    inputOrder = 600,
  } = args
  if (!authorInput.trim()) return []

  const blocks: ContextBlock[] = []
  if (inputMode === 'play') {
    blocks.push({
      id: 'play-output-contract',
      role: 'system',
      content: instructionRegistry.resolve('generation.play-continuation'),
      order: 150,
      source: 'builtin',
    })
  }

  blocks.push({
    id: 'author-input',
    role: 'user',
    content: inputMode === 'play'
      ? authorInput
      : `## Author Direction\n\n${authorInput}`,
    order: inputOrder,
    source: 'builtin',
  })
  return blocks
}

/** The prewriter's one authoritative rendering of the author request. */
export function createPlanningRequest(
  authorInput: string,
  inputMode: AuthorInputMode,
  operation: GenerationOperation,
): string {
  if (operation === 'regenerate') {
    return `The author wants to REGENERATE the latest passage. Their direction: ${authorInput}\n\nCreate a writing brief for an alternative version of the most recent prose.`
  }
  if (operation === 'refine') {
    return `The author wants to REFINE/EDIT the latest passage. Their direction: ${authorInput}\n\nCreate a writing brief that addresses the author's refinement request while maintaining continuity.`
  }
  return inputMode === 'play'
    ? `## Protagonist Move\n\nThis is the protagonist's intended move. Stage this beat near the opening of the passage and plan the world's answering response.\n\n${authorInput}`
    : `## Author Request\n\n${authorInput}`
}

export interface GenerationInputSurfaceAudit {
  authorInputOccurrences: number
  playOutputContractBlocks: number
  characters: number
}

function countLiteral(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count++
    offset += needle.length
  }
  return count
}

/**
 * Describe a generation-input surface for tests and the prompt audit command.
 * This is observability only; it never accepts, rejects, or rewrites a request.
 */
export function auditGenerationInputSurface(
  blocks: ReadonlyArray<Pick<ContextBlock, 'id' | 'content'>>,
  authorInput: string,
): GenerationInputSurfaceAudit {
  const text = blocks.map(block => block.content).join('\n\n')
  return {
    authorInputOccurrences: countLiteral(text, authorInput),
    playOutputContractBlocks: blocks.filter(block => block.id === 'play-output-contract').length,
    characters: text.length,
  }
}
