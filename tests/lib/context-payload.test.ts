import { describe, expect, it } from 'vitest'
import { buildContextPayloadBreakdown } from '@/lib/context-payload'

describe('context payload breakdown', () => {
  it('uses exact messages and only the selected enabled tool surface', () => {
    const result = buildContextPayloadBreakdown({
      messages: [
        { role: 'system', content: '12345678' },
        { role: 'user', content: '1234' },
      ],
      blocks: [
        { id: 'instructions', name: 'Instructions', role: 'system', content: '12345678' },
        { id: 'request', name: 'Request', role: 'user', content: '1234' },
      ],
      tools: [
        { name: 'report', characters: 16, enabled: true },
        { name: 'read', characters: 40, enabled: true },
        { name: 'disabled', characters: 100, enabled: false },
      ],
      activeToolNames: ['report', 'disabled'],
    })

    expect(result).toMatchObject({
      messageCharacters: 12,
      toolCharacters: 16,
      estimatedCharacters: 28,
      estimatedTokens: 7,
    })
    expect(result.requestParts.map((part) => [part.label, part.characters])).toEqual([
      ['system messages', 8],
      ['user messages', 4],
      ['tool schemas', 16],
    ])
    expect(result.largestSources.map((part) => part.label)).toEqual([
      'report',
      'Instructions',
      'Request',
    ])
  })

  it('groups multiple exact messages by role', () => {
    const result = buildContextPayloadBreakdown({
      messages: [
        { role: 'user', content: '1234' },
        { role: 'user', content: '5678' },
      ],
    })

    expect(result.requestParts).toEqual([{
      id: 'message:user',
      label: 'user messages',
      kind: 'message',
      role: 'user',
      characters: 8,
      estimatedTokens: 2,
    }])
  })
})
