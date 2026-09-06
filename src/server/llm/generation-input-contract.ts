import type { AuthorInputMode } from '@/contracts/generation'
import type { ContextBlock } from './context-builder'
import { instructionRegistry } from '../instructions'

export type GenerationOperation = 'generate' | 'regenerate' | 'refine'

export const AUTHOR_STORY_TURN_TAG = 'author-story-turn'

function authorStoryTurnBody(authorInput: string, planning: boolean): string {
  const framing = planning
    ? 'This is canonical manuscript text. Plan from its endpoint.\n\n'
    : ''
  return `${framing}<${AUTHOR_STORY_TURN_TAG}>\n${authorInput}\n</${AUTHOR_STORY_TURN_TAG}>`
}

/**
 * Build the model-facing Writer blocks for an explicit author input.
 *
 * Direct input is an instruction. Play input is manuscript, so it carries the
 * continuation-only output contract and stays verbatim inside one delimited
 * story-turn block. The caller chooses only the block id/order appropriate to
 * its Writer surface; the semantic framing is shared.
 */
export function createGenerationInputBlocks(args: {
  authorInput: string
  inputMode: AuthorInputMode
  modelId?: string
  inputBlockId?: string
  inputOrder?: number
}): ContextBlock[] {
  const {
    authorInput,
    inputMode,
    modelId,
    inputBlockId = 'author-input',
    inputOrder = 600,
  } = args
  if (!authorInput.trim()) return []

  const blocks: ContextBlock[] = []
  if (inputMode === 'play') {
    blocks.push({
      id: 'play-output-contract',
      role: 'system',
      content: instructionRegistry.resolve('generation.play-continuation', modelId),
      order: 150,
      source: 'builtin',
    })
  }

  blocks.push({
    id: inputBlockId,
    role: 'user',
    content: inputMode === 'play'
      ? `## Author Story Turn\n\n${authorStoryTurnBody(authorInput, false)}`
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
    ? `## Author Story Turn\n\n${authorStoryTurnBody(authorInput, true)}`
    : `## Author Request\n\n${authorInput}`
}

export interface GenerationInputSurfaceAudit {
  authorInputOccurrences: number
  playOutputContractBlocks: number
  openingStoryTurnTags: number
  closingStoryTurnTags: number
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
    openingStoryTurnTags: countLiteral(text, `<${AUTHOR_STORY_TURN_TAG}>`),
    closingStoryTurnTags: countLiteral(text, `</${AUTHOR_STORY_TURN_TAG}>`),
    characters: text.length,
  }
}
