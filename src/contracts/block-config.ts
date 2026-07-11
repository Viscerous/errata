import { z } from 'zod/v4'

export const BlockOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  order: z.number().optional(),
  contentMode: z.enum(['override', 'prepend', 'append']).nullable().optional(),
  customContent: z.string().optional(),
})

export const CustomBlockDefinitionSchema = z.object({
  id: z.string().regex(/^cb-[a-z0-9]{4,12}$/),
  name: z.string().min(1).max(100),
  role: z.enum(['system', 'user']),
  order: z.number().default(0),
  enabled: z.boolean().default(true),
  type: z.enum(['simple', 'script']),
  content: z.string(),
})

export const BlockConfigSchema = z.object({
  customBlocks: z.array(CustomBlockDefinitionSchema).default([]),
  overrides: z.record(z.string(), BlockOverrideSchema).default({}),
  blockOrder: z.array(z.string()).default([]),
})

export const AgentBlockConfigSchema = BlockConfigSchema.extend({
  disabledTools: z.array(z.string()).default([]),
  disableAutoAnalysis: z.boolean().default(false),
})

export const ImportConfigsPayloadSchema = z.object({
  // Accepted only so old exports can be diagnosed and ignored explicitly.
  blockConfig: BlockConfigSchema.optional(),
  agentBlockConfigs: z.record(z.string(), AgentBlockConfigSchema).optional(),
})

export type BlockOverride = z.infer<typeof BlockOverrideSchema>
export type CustomBlockDefinition = z.infer<typeof CustomBlockDefinitionSchema>
export type BlockConfig = z.infer<typeof BlockConfigSchema>
export type AgentBlockConfig = z.infer<typeof AgentBlockConfigSchema>
export type AgentBlockConfigInput = z.input<typeof AgentBlockConfigSchema>
export type ImportConfigsPayload = z.input<typeof ImportConfigsPayloadSchema>
