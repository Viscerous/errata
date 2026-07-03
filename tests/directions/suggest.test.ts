import { describe, expect, it } from 'vitest'
import { parseSuggestionDirectionsResponse } from '@/server/directions/suggest'

describe('parseSuggestionDirectionsResponse', () => {
  const directions = [
    { title: 'Hold the Gate', description: 'The heroes linger at the threshold.', instruction: 'Write the tense pause before anyone moves.' },
    { title: 'Follow the Smoke', description: 'A clue pulls them deeper into danger.', instruction: 'Advance the scene toward the source of the smoke.' },
  ]

  it('accepts a JSON array, including a fenced JSON response', () => {
    expect(parseSuggestionDirectionsResponse(`\`\`\`json\n${JSON.stringify(directions)}\n\`\`\``, 2))
      .toEqual(directions)
  })

  it('rejects too few directions', () => {
    expect(() => parseSuggestionDirectionsResponse(JSON.stringify(directions), 3))
      .toThrow('at least 3 directions')
  })

  it('slices extra directions instead of failing the run', () => {
    expect(parseSuggestionDirectionsResponse(JSON.stringify(directions), 1))
      .toEqual([directions[0]])
  })

  it('rejects directions missing required fields', () => {
    expect(() => parseSuggestionDirectionsResponse(JSON.stringify([{ title: 'Incomplete', description: 'No instruction.' }]), 1))
      .toThrow('title, description, and instruction')
  })

  it('rejects malformed JSON', () => {
    expect(() => parseSuggestionDirectionsResponse('not json', 1))
      .toThrow('not valid JSON')
  })
})
