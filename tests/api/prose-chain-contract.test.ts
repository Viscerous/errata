import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProseChainResponseSchema } from '@/contracts/story'
import { createApp } from '@/server/api'
import { createTempDir } from '../setup'

let app: ReturnType<typeof createApp>
let cleanup: () => Promise<void>

beforeEach(async () => {
  const temporary = await createTempDir()
  app = createApp(temporary.path)
  cleanup = temporary.cleanup
})

afterEach(async () => cleanup())

async function request(path: string, body?: unknown) {
  return app.fetch(new Request(`http://localhost/api${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('prose-chain response contract', () => {
  it('returns expanded summaries and narrows untyped fragment metadata', async () => {
    const story = await (await request('/stories', { name: 'Story', description: '' })).json()
    const fragment = await (await request(`/stories/${story.id}/fragments`, {
      type: 'prose',
      name: 'Opening',
      description: '',
      content: 'Once upon a time.',
      meta: { generationMode: { unexpected: true } },
    })).json()
    await request(`/stories/${story.id}/prose-chain`, { fragmentId: fragment.id })

    const response = await (await request(`/stories/${story.id}/prose-chain`)).json()
    expect(ProseChainResponseSchema.parse(response)).toEqual(response)
    expect(response.entries[0].proseFragments[0]).toEqual({
      id: fragment.id,
      type: 'prose',
      name: 'Opening',
      description: '',
      createdAt: fragment.createdAt,
    })
  })
})
