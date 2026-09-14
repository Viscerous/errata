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

export const StorySetupChecklistKeySchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value
    const normalized = value.trim().toLowerCase()
    const aliases: Record<string, typeof STORY_SETUP_CHECKLIST_KEYS[number]> = {
      'starting point': 'starting-point',
      'starting-point': 'starting-point',
      premise: 'premise',
      'premise or emotional center': 'premise',
      characters: 'characters',
      'central characters': 'characters',
      goal: 'goal',
      'goal and stakes': 'goal',
      'goal, opposition, and stakes': 'goal',
      setting: 'setting',
      'setting and essential world rules': 'setting',
      voice: 'voice',
      'voice and tone': 'voice',
      'viewpoint, tense, voice, and tone': 'voice',
      opening: 'opening',
      'opening direction': 'opening',
      'what the opening passage should accomplish': 'opening',
    }
    return aliases[normalized] ?? aliases[normalized.replace(/\s+/g, '-')] ?? normalized.replace(/\s+/g, '-')
  },
  z.enum(STORY_SETUP_CHECKLIST_KEYS),
)

export const StorySetupChecklistStatusSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value
    const normalized = value.trim().toLowerCase()
    const aliases: Record<string, 'missing' | 'partial' | 'covered'> = {
      missing: 'missing',
      none: 'missing',
      uncovered: 'missing',
      not_started: 'missing',
      'not-started': 'missing',
      partial: 'partial',
      in_progress: 'partial',
      'in-progress': 'partial',
      covered: 'covered',
      complete: 'covered',
      completed: 'covered',
      done: 'covered',
    }
    return aliases[normalized] ?? normalized
  },
  z.enum(['missing', 'partial', 'covered']),
)

export const StorySetupChecklistItemSchema = z.object({
  key: StorySetupChecklistKeySchema,
  status: StorySetupChecklistStatusSchema,
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
