import { describe, expect, it } from 'vitest'
import type { Fragment } from '@/server/fragments/schema'
import type { FragmentContextLane } from '@/server/llm/fragment-context-blocks'
import { selectAttentionContext } from '@/server/llm/context-selection'

function makeFragment(overrides: Partial<Fragment> = {}): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'ch-0001',
    type: 'character',
    name: 'Mara',
    description: 'A character fragment',
    content: 'Mara keeps watch over the west road.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    ...overrides,
  }
}

function makeLane(fragments: Fragment[], overrides: Partial<FragmentContextLane> = {}): FragmentContextLane {
  return {
    type: 'character',
    label: 'Characters',
    sticky: [],
    recent: [],
    available: fragments,
    all: fragments,
    ...overrides,
  }
}

describe('librarian fragment routing', () => {
  it('promotes strong attention signals to full context', () => {
    const mara = makeFragment({ id: 'ch-0001' })
    const lane = makeLane([mara])
    const signals = new Map([['ch-0001', new Set(['writer-context' as const])]])

    const selection = selectAttentionContext([lane], {
      runner: 'librarian.analyze',
      catalogScope: 'all',
      fullSignalSources: ['writer-context', 'current-observation', 'router'],
    }, signals)

    expect(selection.lanes[0].full.map((fragment) => fragment.id)).toEqual(['ch-0001'])
    expect(selection.lanes[0].catalog).toEqual([])
    expect(selection.diagnostics.promotedFull[0]).toMatchObject({
      fragmentId: 'ch-0001',
      sources: expect.arrayContaining(['writer-context']),
    })
  })

  it('keeps catalog-only fragments out of full context without an attention signal', () => {
    const mara = makeFragment({ id: 'ch-0001' })
    const lane = makeLane([mara])

    const selection = selectAttentionContext([lane], {
      runner: 'librarian.analyze',
      catalogScope: 'all',
      fullSignalSources: ['writer-context', 'current-observation', 'router'],
    })

    expect(selection.lanes[0].full).toEqual([])
    expect(selection.lanes[0].catalog.map((fragment) => fragment.id)).toEqual(['ch-0001'])
    expect(selection.diagnostics.catalogOnly[0]).toMatchObject({
      fragmentId: 'ch-0001',
      sources: expect.arrayContaining(['catalog']),
    })
  })

  it('never duplicates a full fragment into the same lane catalog', () => {
    const pinned = makeFragment({ id: 'ch-pin01', sticky: true })
    const recent = makeFragment({ id: 'ch-rec01' })
    const available = makeFragment({ id: 'ch-avl01' })
    const lane = makeLane([pinned, recent, available], {
      sticky: [pinned],
      recent: [recent],
    })

    const selection = selectAttentionContext([lane], {
      runner: 'librarian.analyze',
      catalogScope: 'all',
      fullSignalSources: ['writer-context', 'current-observation', 'router'],
    })

    expect(selection.lanes[0].full.map((fragment) => fragment.id)).toEqual(['ch-rec01', 'ch-pin01'])
    expect(selection.lanes[0].catalog.map((fragment) => fragment.id)).toEqual(['ch-avl01'])
  })
})
