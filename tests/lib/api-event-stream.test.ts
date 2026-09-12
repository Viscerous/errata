import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchEventStream } from '@/lib/api/client'

describe('fetchEventStream', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('turns a terminal agent error event into a readable failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"type":"text","text":"Partial"}\n{"type":"error","error":"socket hang up"}\n',
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    )))

    const stream = await fetchEventStream('/test', {})
    const reader = stream.getReader()
    await expect(reader.read()).resolves.toMatchObject({ value: { type: 'text', text: 'Partial' } })
    await expect(reader.read()).rejects.toThrow('socket hang up')
  })
})
