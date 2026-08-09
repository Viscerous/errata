import { describe, expect, it } from 'vitest'
import {
  BranchesIndexSchema as ContractBranchesIndexSchema,
  FragmentSchema as ContractFragmentSchema,
  StoryMetaSchema as ContractStoryMetaSchema,
} from '@/contracts/story'
import {
  BranchesIndexSchema,
  FragmentSchema,
  StoryMetaSchema,
} from '@/server/fragments/schema'

describe('shared story contracts', () => {
  it('keeps the original server path as a direct compatibility façade', () => {
    expect(FragmentSchema).toBe(ContractFragmentSchema)
    expect(StoryMetaSchema).toBe(ContractStoryMetaSchema)
    expect(BranchesIndexSchema).toBe(ContractBranchesIndexSchema)
  })

  it('exposes current story-setting defaults from the canonical schema', () => {
    const story = ContractStoryMetaSchema.parse({
      id: 'story-contract',
      name: 'Contract test',
      description: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(story.settings.enabledBuiltinTools).toEqual([])
    expect(story.settings.modelOverrides).toEqual({})
    expect(story.settings.contextCompact).toEqual({ type: 'proseLimit', value: 10 })
  })
})
