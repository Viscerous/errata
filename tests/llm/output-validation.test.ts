import { describe, expect, it } from 'vitest'
import { assessGenerationForCommit } from '@/server/generation/output-validation'

describe('generation output commit assessment', () => {
  it('accepts normally completed prose', () => {
    expect(assessGenerationForCommit('Thought settled over the room like dust.', 'stop'))
      .toEqual({ accepted: true })
  })

  it.each(['length', 'tool-calls', 'unknown', 'error'])(
    'rejects the non-terminal finish reason %s',
    (finishReason) => {
      expect(assessGenerationForCommit('Partial prose.', finishReason)).toMatchObject({
        accepted: false,
        code: 'incomplete_finish',
      })
    },
  )

  it.each([
    '.thought\nReady to write.',
    '<think>Plan the answer first.</think>',
    '<analysis>We need produce prose.</analysis>',
    '```reasoning\nFirst plan the scene.\n```',
  ])('rejects a leaked reasoning prefix', (text) => {
    expect(assessGenerationForCommit(text, 'stop')).toMatchObject({
      accepted: false,
      code: 'reasoning_leak',
    })
  })
})
