import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory, listFragments } from '@/server/fragments/storage'
import { runGeneration } from '@/server/generation/run-generation'
import { listActiveAgents, requestAgentCancellation } from '@/server/agents/active-registry'
import { listAgentRuns } from '@/server/agents/traces'
import type { StoryMeta } from '@/server/fragments/schema'

describe('prose generation cancellation', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  const storyId = 'story-cancel'

  beforeEach(async () => {
    const temp = await createTempDir()
    dataDir = temp.path
    cleanup = temp.cleanup
    const now = new Date().toISOString()
    const story: StoryMeta = {
      id: storyId,
      name: 'Cancellation test',
      description: '',
      coverImage: null,
      summary: '',
      createdAt: now,
      updatedAt: now,
      settings: makeTestSettings(),
    }
    await createStory(dataDir, story)
  })

  afterEach(async () => {
    await cleanup()
  })

  it('honors Stop when cancellation arrives before the generation registers', async () => {
    const runId = 'gen-stop-before-register'
    expect(requestAgentCancellation(storyId, runId)).toBe(false)

    await expect(runGeneration(dataDir, storyId, {
      input: 'Continue the story',
      saveResult: true,
      runId,
      branchId: 'main',
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(listActiveAgents(storyId)).toEqual([])
    expect(listAgentRuns(storyId, 1)[0]).toMatchObject({ runId, status: 'aborted' })
    expect(await listFragments(dataDir, storyId, 'prose')).toEqual([])
  })
})
