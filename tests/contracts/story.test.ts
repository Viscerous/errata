import { describe, expect, it } from 'vitest'
import {
  BranchesIndexSchema as ContractBranchesIndexSchema,
  FragmentSchema as ContractFragmentSchema,
  ProseChainResponseSchema,
  StoredProseChainSchema,
  StoryMetaSchema as ContractStoryMetaSchema,
} from '@/contracts/story'
import {
  BranchesIndexSchema,
  FragmentSchema,
  ProseChainSchema,
  StoryMetaSchema,
} from '@/server/fragments/schema'

describe('shared story contracts', () => {
  it('keeps the original server path as a direct compatibility façade', () => {
    expect(FragmentSchema).toBe(ContractFragmentSchema)
    expect(StoryMetaSchema).toBe(ContractStoryMetaSchema)
    expect(BranchesIndexSchema).toBe(ContractBranchesIndexSchema)
    expect(ProseChainSchema).toBe(StoredProseChainSchema)
  })

  it('distinguishes stored fragment IDs from the expanded API response', () => {
    const stored = {
      entries: [{ proseFragments: ['pr-a1b2'], active: 'pr-a1b2' }],
    }
    const response = {
      entries: [{
        proseFragments: [{
          id: 'pr-a1b2',
          type: 'prose',
          name: 'Opening',
          description: '',
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
        active: 'pr-a1b2',
      }],
    }

    expect(StoredProseChainSchema.safeParse(stored).success).toBe(true)
    expect(ProseChainResponseSchema.safeParse(stored).success).toBe(false)
    expect(ProseChainResponseSchema.safeParse(response).success).toBe(true)
    expect(StoredProseChainSchema.safeParse(response).success).toBe(false)
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
