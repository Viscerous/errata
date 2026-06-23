import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir } from '../setup'

// Analysis ultimately fires through invokeAgent; stub it so the real gating runs without an LLM
vi.mock('@/server/agents', () => ({
  invokeAgent: vi.fn().mockResolvedValue(undefined),
}))

import { invokeAgent } from '@/server/agents'
import { clearPending } from '@/server/librarian/scheduler'
import { createApp } from '@/server/api'

const mockedInvokeAgent = vi.mocked(invokeAgent)

let dataDir: string
let cleanup: () => Promise<void>
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  const tmp = await createTempDir()
  dataDir = tmp.path
  cleanup = tmp.cleanup
  app = createApp(dataDir)
  clearPending()
  mockedInvokeAgent.mockClear()
})

afterEach(async () => {
  clearPending()
  await cleanup()
})

async function api(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, init))
  return {
    status: res.status,
    json: async () => res.json(),
  }
}

async function apiJson(path: string, body: unknown, method = 'POST') {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createStoryAndProse() {
  const story = await (await apiJson('/stories', { name: 'Test', description: 'Test story' })).json() as { id: string }
  const fragment = await (await apiJson(`/stories/${story.id}/fragments`, {
    type: 'prose',
    name: 'Opening',
    description: 'Initial',
    content: 'Old content',
  })).json() as { id: string }
  return { storyId: story.id, fragmentId: fragment.id }
}

describe('prose edit reanalysis trigger', () => {
  it('triggers librarian on prose PUT when content changes', async () => {
    const { storyId, fragmentId } = await createStoryAndProse()

    const res = await apiJson(`/stories/${storyId}/fragments/${fragmentId}`, {
      name: 'Opening',
      description: 'Initial',
      content: 'New content',
    }, 'PUT')

    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(1))
    expect(mockedInvokeAgent).toHaveBeenCalledWith({
      dataDir,
      storyId,
      agentName: 'librarian.analyze',
      input: { fragmentId },
    })
  })

  it('does not trigger librarian on prose PUT when only sticky changes', async () => {
    const { storyId, fragmentId } = await createStoryAndProse()

    const res = await apiJson(`/stories/${storyId}/fragments/${fragmentId}`, {
      name: 'Opening',
      description: 'Initial',
      content: 'Old content',
      sticky: true,
    }, 'PUT')

    expect(res.status).toBe(200)
    expect(mockedInvokeAgent).not.toHaveBeenCalled()
  })

  it('triggers librarian on prose PATCH when text replacement changes content', async () => {
    const { storyId, fragmentId } = await createStoryAndProse()

    const res = await apiJson(`/stories/${storyId}/fragments/${fragmentId}`, {
      oldText: 'Old',
      newText: 'Updated',
    }, 'PATCH')

    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(1))
    expect(mockedInvokeAgent).toHaveBeenCalledWith({
      dataDir,
      storyId,
      agentName: 'librarian.analyze',
      input: { fragmentId },
    })
  })

  it('does not trigger librarian on prose PATCH when replacement is a no-op', async () => {
    const { storyId, fragmentId } = await createStoryAndProse()

    const res = await apiJson(`/stories/${storyId}/fragments/${fragmentId}`, {
      oldText: 'missing-text',
      newText: 'Updated',
    }, 'PATCH')

    expect(res.status).toBe(200)
    expect(mockedInvokeAgent).not.toHaveBeenCalled()
  })

  it('does not trigger librarian on non-prose PUT updates', async () => {
    const story = await (await apiJson('/stories', { name: 'Test', description: 'Test story' })).json() as { id: string }
    const fragment = await (await apiJson(`/stories/${story.id}/fragments`, {
      type: 'character',
      name: 'Alice',
      description: 'Hero',
      content: 'Old bio',
    })).json() as { id: string }

    const res = await apiJson(`/stories/${story.id}/fragments/${fragment.id}`, {
      name: 'Alice',
      description: 'Hero',
      content: 'New bio',
    }, 'PUT')

    expect(res.status).toBe(200)
    expect(mockedInvokeAgent).not.toHaveBeenCalled()
  })
})
