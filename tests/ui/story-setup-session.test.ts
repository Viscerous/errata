import { describe, expect, it } from 'vitest'
import {
  readStorySetupSession,
  storySetupSessionNeedsRefresh,
  writeStorySetupSession,
  type StorySetupSession,
} from '@/components/wizard/story-setup-session'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const session: StorySetupSession = {
  contentRevision: 'revision-1',
  messages: [
    { role: 'assistant', content: 'What are you starting with?' },
    { role: 'user', content: 'A courier carrying a stolen memory.' },
  ],
  checklist: [{ key: 'starting-point', status: 'covered', note: 'A rough premise' }],
  draftFragments: [{
    id: 'ch-mara',
    key: 'mara',
    type: 'character',
    name: 'Mara',
    description: 'Courier with a stolen memory',
    content: 'Mara is a cautious courier.',
  }],
}

describe('story setup session', () => {
  it('restores the setup conversation and working state for a story', () => {
    const storage = new MemoryStorage()

    writeStorySetupSession(storage, 'story-test', 'main', session)

    expect(readStorySetupSession(storage, 'story-test', 'main')).toEqual(session)
    expect(readStorySetupSession(storage, 'another-story', 'main')).toBeNull()
  })

  it('keeps sessions isolated between timelines', () => {
    const storage = new MemoryStorage()

    writeStorySetupSession(storage, 'story-test', 'main', session)

    expect(readStorySetupSession(storage, 'story-test', 'alternate')).toBeNull()
  })

  it('reassesses a saved checklist when story content changes', () => {
    expect(storySetupSessionNeedsRefresh(session, 'revision-1')).toBe(false)
    expect(storySetupSessionNeedsRefresh(session, 'revision-2')).toBe(true)
  })

  it('ignores malformed saved state', () => {
    const storage = new MemoryStorage()
    storage.setItem('errata:story-setup:story-test', '{"messages":"not-an-array"}')

    expect(readStorySetupSession(storage, 'story-test', 'main')).toBeNull()
  })
})
