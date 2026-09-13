import { beforeAll, describe, expect, it } from 'vitest'
import { ensureCoreAgentsRegistered } from '@/server/agents/register-core'
import {
  auditGenerationInputSurface,
  createGenerationInputBlocks,
  createPlanningRequest,
} from '@/server/llm/generation-input-contract'
import { createWriterBriefBlocks } from '@/server/llm/prewriter'

const AUTHOR_INPUT = 'I set the glass down. "Then show me," I say.'

function planningBlock(content: string) {
  return [{ id: 'planning-request', content }]
}

describe('generation input prompt contract', () => {
  beforeAll(() => {
    ensureCoreAgentsRegistered()
  })

  it('presents Direct input once as an instruction to the standard writer', () => {
    const blocks = createGenerationInputBlocks({
      authorInput: AUTHOR_INPUT,
      inputMode: 'direct',
    })

    expect(blocks.map(block => block.id)).toEqual(['author-input'])
    expect(blocks[0].content).toBe(`## Author Direction\n\n${AUTHOR_INPUT}`)
    expect(auditGenerationInputSurface(blocks, AUTHOR_INPUT)).toMatchObject({
      authorInputOccurrences: 1,
      playOutputContractBlocks: 0,
    })
  })

  it('presents a Play turn once with one continuation contract', () => {
    const blocks = createGenerationInputBlocks({
      authorInput: AUTHOR_INPUT,
      inputMode: 'play',
    })

    expect(blocks.map(block => block.id)).toEqual(['play-output-contract', 'author-input'])
    expect(blocks.find(block => block.id === 'author-input')?.content).toBe(AUTHOR_INPUT)
    expect(auditGenerationInputSurface(blocks, AUTHOR_INPUT)).toMatchObject({
      authorInputOccurrences: 1,
      playOutputContractBlocks: 1,
    })
  })

  it('gives the planner one request without giving it the writer output contract', () => {
    const direct = planningBlock(createPlanningRequest(AUTHOR_INPUT, 'direct', 'generate'))
    const play = planningBlock(createPlanningRequest(AUTHOR_INPUT, 'play', 'generate'))

    expect(auditGenerationInputSurface(direct, AUTHOR_INPUT)).toMatchObject({
      authorInputOccurrences: 1,
      playOutputContractBlocks: 0,
    })
    expect(auditGenerationInputSurface(play, AUTHOR_INPUT)).toMatchObject({
      authorInputOccurrences: 1,
      playOutputContractBlocks: 0,
    })
    expect(play[0].content).toContain("protagonist's intended move")
  })

  it('keeps Direct input out of the brief writer while carrying Play manuscript once', () => {
    const direct = createWriterBriefBlocks([], 'Follow the author request precisely.')
    const play = createWriterBriefBlocks([], 'Continue the exchange.', AUTHOR_INPUT)

    expect(auditGenerationInputSurface(direct, AUTHOR_INPUT)).toMatchObject({
      authorInputOccurrences: 0,
      playOutputContractBlocks: 0,
    })
    expect(auditGenerationInputSurface(play, AUTHOR_INPUT)).toMatchObject({
      authorInputOccurrences: 1,
      playOutputContractBlocks: 1,
    })
  })

  it('uses identical Play framing in standard and brief writer surfaces', () => {
    const standard = createGenerationInputBlocks({
      authorInput: AUTHOR_INPUT,
      inputMode: 'play',
    })
    const brief = createWriterBriefBlocks([], 'Continue the exchange.', AUTHOR_INPUT)

    expect(brief.find(block => block.id === 'author-input')?.content)
      .toBe(standard.find(block => block.id === 'author-input')?.content)
    expect(brief.find(block => block.id === 'play-output-contract')?.content)
      .toBe(standard.find(block => block.id === 'play-output-contract')?.content)
  })

  it('frames regenerate with Play mode as protagonist move rather than author direction', () => {
    const playRegen = planningBlock(createPlanningRequest(AUTHOR_INPUT, 'play', 'regenerate'))
    expect(playRegen[0].content).toContain("protagonist's intended move")
    expect(playRegen[0].content).toContain('## Protagonist Move')
    expect(playRegen[0].content).not.toContain('Their direction:')

    const directRegen = planningBlock(createPlanningRequest(AUTHOR_INPUT, 'direct', 'regenerate'))
    expect(directRegen[0].content).toContain('Their direction:')
    expect(directRegen[0].content).not.toContain('## Protagonist Move')
  })
})
