import { describe, expect, it } from 'vitest'
import {
  AgentBlockConfigSchema,
  ImportConfigsPayloadSchema,
} from '@/contracts/block-config'
import { BlockConfigSchema } from '@/server/blocks/schema'

describe('shared block configuration contracts', () => {
  it('uses the shared block schema on the server', () => {
    expect(BlockConfigSchema).toBeDefined()
    expect(AgentBlockConfigSchema.parse({})).toEqual({
      customBlocks: [],
      overrides: {},
      blockOrder: [],
      disabledTools: [],
      disableAutoAnalysis: false,
    })
  })

  it('rejects malformed imported agent configurations before persistence', () => {
    const result = ImportConfigsPayloadSchema.safeParse({
      agentBlockConfigs: {
        writer: { customBlocks: [{ id: 'not-a-block' }] },
      },
    })
    expect(result.success).toBe(false)
  })
})
