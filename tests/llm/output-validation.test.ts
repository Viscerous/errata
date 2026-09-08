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
  it('does not judge model content after a successful stream', () => {
    expect(assessGenerationForCommit('<think>Plan the scene.</think>\nThe door opens.', 'stop'))
      .toEqual({ accepted: true })
  })
})
