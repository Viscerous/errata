import { asSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  StorySetupAssessmentSchema,
  StorySetupSnapshotSchema,
} from '@/server/story-setup/schema'

function containsUnion(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsUnion)
  const record = value as Record<string, unknown>
  if ('anyOf' in record || 'oneOf' in record) return true
  return Object.values(record).some(containsUnion)
}

describe('story setup tool schemas', () => {
  it('keeps assessment input to the checklist Errata actually consumes', async () => {
    const schema = await asSchema(StorySetupAssessmentSchema).jsonSchema
    expect(schema.properties).toEqual(expect.objectContaining({ checklist: expect.any(Object) }))
    expect(Object.keys(schema.properties ?? {})).toEqual(['checklist'])
    expect(schema.required).toEqual(['checklist'])
    expect(containsUnion(schema)).toBe(false)
  })

  it('avoids nullable unions in the writable snapshot schema', async () => {
    const schema = await asSchema(StorySetupSnapshotSchema).jsonSchema
    expect(schema.required).toEqual(['checklist', 'fragments'])
    expect(schema.properties).toEqual(expect.objectContaining({ story: expect.any(Object) }))
    expect(containsUnion(schema)).toBe(false)
  })

  it('requires the canonical checklist order and unique setup fragment keys', () => {
    const checklist = [
      'starting-point',
      'premise',
      'characters',
      'goal',
      'setting',
      'voice',
      'opening',
    ].map(key => ({ key, status: 'missing', note: '' }))

    expect(StorySetupAssessmentSchema.safeParse({ checklist }).success).toBe(true)
    expect(StorySetupAssessmentSchema.safeParse({ checklist: [...checklist].reverse() }).success).toBe(false)
    expect(StorySetupSnapshotSchema.safeParse({
      checklist,
      fragments: [
        { key: 'same', type: 'knowledge', name: 'One', description: 'One', content: 'One' },
        { key: 'same', type: 'knowledge', name: 'Two', description: 'Two', content: 'Two' },
      ],
    }).success).toBe(false)
  })

  it('normalizes common key and status aliases gracefully', () => {
    const aliasedChecklist = [
      { key: 'starting point', status: 'complete', note: 'premise set' },
      { key: 'premise or emotional center', status: 'done', note: 'satire' },
      { key: 'central characters', status: 'covered', note: 'Arthur' },
      { key: 'goal and stakes', status: 'in-progress', note: 'mild promotion' },
      { key: 'setting and essential world rules', status: 'covered', note: 'infinite beige' },
      { key: 'voice and tone', status: 'covered', note: 'deadpan' },
      { key: 'what the opening passage should accomplish', status: 'covered', note: 'scale and adequacy' },
    ]

    const parsed = StorySetupAssessmentSchema.safeParse({ checklist: aliasedChecklist })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.checklist[0].key).toBe('starting-point')
      expect(parsed.data.checklist[0].status).toBe('covered')
      expect(parsed.data.checklist[1].key).toBe('premise')
      expect(parsed.data.checklist[1].status).toBe('covered')
      expect(parsed.data.checklist[2].key).toBe('characters')
      expect(parsed.data.checklist[3].key).toBe('goal')
      expect(parsed.data.checklist[3].status).toBe('partial')
      expect(parsed.data.checklist[4].key).toBe('setting')
      expect(parsed.data.checklist[5].key).toBe('voice')
      expect(parsed.data.checklist[6].key).toBe('opening')
      expect(parsed.data.checklist[6].status).toBe('covered')
    }
  })
})
