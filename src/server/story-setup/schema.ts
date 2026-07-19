import { z } from 'zod/v4'

const STORY_SETUP_CHECKLIST_KEYS = [
  'starting-point',
  'premise',
  'characters',
  'goal',
  'setting',
  'voice',
  'opening',
] as const

export const StorySetupChecklistKeySchema = z.enum(STORY_SETUP_CHECKLIST_KEYS)

export const StorySetupChecklistItemSchema = z.object({
  key: StorySetupChecklistKeySchema,
  status: z.enum(['missing', 'partial', 'covered']),
  note: z.string().max(120),
})

export const StorySetupDraftFragmentSchema = z.object({
  key: z.string().min(1).max(50).regex(/^[a-z0-9][a-z0-9-]*$/),
  type: z.enum(['guideline', 'knowledge', 'character', 'prose']),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(250),
  content: z.string().trim().min(1),
})

const StorySetupChecklistSchema = z.array(StorySetupChecklistItemSchema).length(7).superRefine((items, ctx) => {
  items.forEach((item, index) => {
    const expected = STORY_SETUP_CHECKLIST_KEYS[index]
    if (item.key !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'key'],
        message: `Expected checklist key ${expected}`,
      })
    }
  })
})

export const StorySetupAssessmentSchema = z.object({
  checklist: StorySetupChecklistSchema,
})

export const StorySetupSnapshotSchema = z.object({
  story: z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500),
  }).optional(),
  checklist: StorySetupChecklistSchema,
  fragments: z.array(StorySetupDraftFragmentSchema).max(12).superRefine((fragments, ctx) => {
    const seen = new Set<string>()
    fragments.forEach((fragment, index) => {
      if (seen.has(fragment.key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: `Duplicate story setup key ${fragment.key}`,
        })
      }
      seen.add(fragment.key)
    })
  }),
})

export type StorySetupDraftFragment = z.infer<typeof StorySetupDraftFragmentSchema>
