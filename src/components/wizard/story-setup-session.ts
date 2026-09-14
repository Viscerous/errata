import { z } from 'zod/v4'
import type {
  StorySetupChecklistItem,
  StorySetupDraftFragment,
  StorySetupMessage,
  StorySetupOption,
} from '@/lib/api'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const StorySetupSessionSchema = z.object({
  contentRevision: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  checklist: z.array(z.object({
    key: z.enum(['starting-point', 'premise', 'characters', 'goal', 'setting', 'voice', 'opening']),
    status: z.enum(['missing', 'partial', 'covered']),
    note: z.string(),
  })),
  draftFragments: z.array(z.object({
    id: z.string().optional(),
    key: z.string(),
    type: z.enum(['guideline', 'knowledge', 'character', 'prose']),
    name: z.string(),
    description: z.string(),
    content: z.string(),
  })),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().optional(),
    value: z.string().optional(),
  })).optional(),
  initialGreeting: z.string().optional(),
  hasExistingMaterial: z.boolean().optional(),
})

export interface StorySetupSession {
  contentRevision?: string
  messages: StorySetupMessage[]
  checklist: StorySetupChecklistItem[]
  draftFragments: StorySetupDraftFragment[]
  options?: StorySetupOption[]
  initialGreeting?: string
  hasExistingMaterial?: boolean
}

export function computeStorySetupGreeting(params: {
  hasExistingMaterial: boolean
  workingTitle?: string
  storyDescription?: string
}): string {
  const workingTitle = params.workingTitle && params.workingTitle !== 'New Story' ? params.workingTitle : undefined
  const cleanDescription = params.storyDescription?.trim().replace(/[.\s]+$/, '')
  const hasWorkingStory = Boolean(workingTitle || cleanDescription)

  if (params.hasExistingMaterial) {
    return "Welcome to Story Setup. This story already has established characters, notes, and world details in place. You can tell me what you'd like to work on next, or we can review the foundation together to see what's settled and what still needs shaping."
  }
  if (hasWorkingStory) {
    if (workingTitle && cleanDescription) {
      return `Welcome to Story Setup for "${workingTitle}". Starting from your premise—"${cleanDescription}"—we can explore early directions and characters together, or you can tell me where you'd like to begin.`
    }
    if (workingTitle) {
      return `Welcome to Story Setup for "${workingTitle}". We can explore early directions and characters sparked by your title, or you can tell me where you'd like to begin.`
    }
    return `Welcome to Story Setup. Starting from your premise—"${cleanDescription}"—we can explore early directions and characters together, or you can tell me where you'd like to begin.`
  }
  return "Welcome to Story Setup. What kind of story would you like to tell? Share whatever is in your head—a premise, a character, a mood, or a single scene—and we'll shape the foundation together."
}

function sessionKey(storyId: string, scope: string) {
  return `errata:story-setup:${storyId}:${encodeURIComponent(scope)}`
}

export function storySetupSessionNeedsRefresh(
  session: StorySetupSession,
  contentRevision: string,
): boolean {
  return session.contentRevision !== contentRevision
}

export function readStorySetupSession(storage: StorageLike, storyId: string, scope: string): StorySetupSession | null {
  try {
    const raw = storage.getItem(sessionKey(storyId, scope))
      ?? (scope === 'main' ? storage.getItem(`errata:story-setup:${storyId}`) : null)
    if (!raw) return null
    const parsed = StorySetupSessionSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeStorySetupSession(
  storage: StorageLike,
  storyId: string,
  scope: string,
  session: StorySetupSession,
): void {
  try {
    storage.setItem(sessionKey(storyId, scope), JSON.stringify(session))
  } catch {
    // Setup remains usable if browser storage is unavailable or full.
  }
}
