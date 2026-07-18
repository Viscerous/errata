import { generateFragmentId } from '@/lib/fragment-ids'
import { withKeyLock } from '../async-lock'
import {
  createFragment,
  getStory,
  listFragments,
  updateFragmentVersioned,
  updateStory,
} from '../fragments/storage'
import { addProseSection } from '../fragments/prose-chain'
import type { Fragment } from '../fragments/schema'
import type { StorySetupDraftFragment } from './schema'

interface SetupStoryDraft {
  name: string
  description: string
}

export interface StorySetupSyncInput {
  story: SetupStoryDraft | null
  fragments: StorySetupDraftFragment[]
}

export interface PersistedStorySetupFragment extends StorySetupDraftFragment {
  id: string
}

export async function listStorySetupFragments(dataDir: string, storyId: string): Promise<Fragment[]> {
  return (await listFragments(dataDir, storyId))
    .filter(fragment => typeof fragment.meta.storySetupKey === 'string')
}

function makeSetupFragment(draft: StorySetupDraftFragment, order: number): Fragment {
  const now = new Date().toISOString()
  return {
    id: generateFragmentId(draft.type),
    type: draft.type,
    name: draft.name,
    description: draft.description,
    content: draft.content.trim(),
    tags: [],
    refs: [],
    sticky: draft.type !== 'prose',
    placement: draft.type === 'guideline' ? 'system' : 'user',
    createdAt: now,
    updatedAt: now,
    order,
    meta: { storySetupKey: draft.key },
    archived: false,
    version: 1,
    versions: [],
  }
}

/** Persist the model's latest setup snapshot without touching writer-owned fragments. */
export async function syncStorySetupSnapshot(
  dataDir: string,
  storyId: string,
  input: StorySetupSyncInput,
): Promise<{ story: SetupStoryDraft | null; fragments: PersistedStorySetupFragment[] }> {
  return withKeyLock(`story-setup:${storyId}`, async () => {
    const story = await getStory(dataDir, storyId)
    if (!story) throw new Error(`Story ${storyId} not found`)

    if (input.story) {
      await updateStory(dataDir, {
        ...story,
        name: input.story.name.trim(),
        description: input.story.description.trim(),
        updatedAt: new Date().toISOString(),
      })
    }

    const existing = await listFragments(dataDir, storyId)
    const setupByKey = new Map(
      existing
        .filter(fragment => typeof fragment.meta.storySetupKey === 'string')
        .map(fragment => [fragment.meta.storySetupKey as string, fragment]),
    )
    let order = existing.reduce((max, fragment) => Math.max(max, fragment.order), -1) + 1
    const persisted: PersistedStorySetupFragment[] = []

    for (const draft of input.fragments) {
      const current = setupByKey.get(draft.key)
      if (current) {
        if (current.type !== draft.type) {
          throw new Error(`Story setup fragment ${draft.key} cannot change type`)
        }
        const updated = await updateFragmentVersioned(dataDir, storyId, current.id, {
          name: draft.name,
          description: draft.description,
          content: draft.content.trim(),
        }, { reason: 'story-setup' })
        if (!updated) throw new Error(`Story setup fragment ${current.id} disappeared during update`)
        persisted.push({ id: updated.id, ...draft })
        continue
      }

      const created = makeSetupFragment(draft, order++)
      await createFragment(dataDir, storyId, created)
      if (created.type === 'prose') {
        await addProseSection(dataDir, storyId, created.id)
      }
      setupByKey.set(draft.key, created)
      persisted.push({ id: created.id, ...draft })
    }

    return { story: input.story, fragments: persisted }
  })
}
