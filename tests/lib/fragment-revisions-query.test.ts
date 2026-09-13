import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { qk } from '@/lib/query-keys'

describe('fragment revision query', () => {
  it('follows all-fragment invalidations without colliding with the full list', async () => {
    const client = new QueryClient()
    const key = qk.fragmentRevisions('story-one', 'main')
    client.setQueryData(key, [{ id: 'pr-one', version: 2, updatedAt: '2026-01-01' }])
    client.setQueryData(qk.fragments('story-one', 'main'), [])

    expect(client.getQueryData(key)).toHaveLength(1)
    expect(client.getQueryData(qk.fragments('story-one', 'main'))).toEqual([])
    await client.invalidateQueries({
      queryKey: ['fragments', 'story-one'],
      predicate: (query) => query.queryKey[3] === undefined,
    })

    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })
})
