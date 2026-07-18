import { z } from 'zod/v4'

export const StorySetupChecklistKeySchema = z.enum([
  'starting-point',
  'premise',
  'characters',
  'goal',
  'setting',
  'voice',
  'opening',
])

export const StorySetupChecklistItemSchema = z.object({
  key: StorySetupChecklistKeySchema,
  status: z.enum(['missing', 'partial', 'covered']),
  note: z.string().max(120),
})

export const StorySetupDraftFragmentSchema = z.object({
  key: z.string().min(1).max(50).regex(/^[a-z0-9][a-z0-9-]*$/),
  type: z.enum(['guideline', 'knowledge', 'character', 'prose']),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(50),
  content: z.string().min(1),
})

export const StorySetupSnapshotSchema = z.object({
  story: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500),
  }).nullable(),
  checklist: z.array(StorySetupChecklistItemSchema).length(7),
  fragments: z.array(StorySetupDraftFragmentSchema).max(12),
})

export type StorySetupDraftFragment = z.infer<typeof StorySetupDraftFragmentSchema>
