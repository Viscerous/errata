import { generateFragmentId } from '@/lib/fragment-ids'
import { withKeyLock } from '../async-lock'
import {
  createFragment,
  archiveFragment,
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
    name: draft.name.trim(),
    description: draft.description.trim(),
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

    const existing = await listFragments(dataDir, storyId)
    const setupByKey = new Map(
      existing
        .filter(fragment => typeof fragment.meta.storySetupKey === 'string')
        .map(fragment => [fragment.meta.storySetupKey as string, fragment]),
    )
    let order = existing.reduce((max, fragment) => Math.max(max, fragment.order), -1) + 1
    const persisted: PersistedStorySetupFragment[] = []
    const incomingKeys = new Set(input.fragments.map(fragment => fragment.key))

    for (const draft of input.fragments) {
      const current = setupByKey.get(draft.key)
      if (current && current.type !== draft.type) {
        throw new Error(`Story setup fragment ${draft.key} cannot change type from ${current.type} to ${draft.type}`)
      }
    }

    if (input.story && (
      story.name !== input.story.name.trim()
      || story.description !== input.story.description.trim()
    )) {
      await updateStory(dataDir, {
        ...story,
        name: input.story.name.trim(),
        description: input.story.description.trim(),
        updatedAt: new Date().toISOString(),
      })
    }

    for (const [key, fragment] of setupByKey) {
      if (!incomingKeys.has(key)) {
        await archiveFragment(dataDir, storyId, fragment.id)
      }
    }

    for (const draft of input.fragments) {
      const current = setupByKey.get(draft.key)
      if (current) {
        const normalized = {
          ...draft,
          name: draft.name.trim(),
          description: draft.description.trim(),
          content: draft.content.trim(),
        }
        const trimmedContent = draft.content.trim()
        const changed = current.name !== normalized.name
          || current.description !== normalized.description
          || current.content !== trimmedContent
        const updated = changed
          ? await updateFragmentVersioned(dataDir, storyId, current.id, {
              name: normalized.name,
              description: normalized.description,
              content: trimmedContent,
            }, { reason: 'story-setup' })
          : current
        if (!updated) throw new Error(`Story setup fragment ${current.id} disappeared during update`)
        persisted.push({ id: updated.id, ...normalized })
        continue
      }

      const normalized = {
        ...draft,
        name: draft.name.trim(),
        description: draft.description.trim(),
        content: draft.content.trim(),
      }
      const created = makeSetupFragment(normalized, order++)
      await createFragment(dataDir, storyId, created)
      if (created.type === 'prose') {
        await addProseSection(dataDir, storyId, created.id)
      }
      setupByKey.set(draft.key, created)
      persisted.push({ id: created.id, ...normalized })
    }

    return { story: input.story, fragments: persisted }
  })
}
