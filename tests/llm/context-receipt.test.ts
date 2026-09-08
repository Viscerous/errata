import { describe, expect, it } from 'vitest'
import {
  contextReceiptBridgeIds,
  contextReceiptProvenanceIds,
  createContextReceipt,
} from '../../src/server/llm/context-receipt'
import type { ContextBlock } from '../../src/server/llm/context-builder'
import type { Fragment } from '@/contracts/story'

function prose(meta: Record<string, unknown>): Fragment {
  return {
    id: 'pr-0001',
    type: 'prose',
    name: 'Passage',
    description: '',
    content: 'Text.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
    meta,
  }
}

describe('context receipts', () => {
  it('records structured full, catalog, tag, and explicit-read surfaces', () => {
    const blocks: ContextBlock[] = [
      {
        id: 'fragment-recent',
        role: 'user',
        content: 'Recent context',
        order: 1,
        source: 'builtin',
        fragmentContext: {
          mode: 'full',
          scope: 'recent',
          fragmentType: 'mixed',
          fragmentIds: ['ch-0001'],
        },
      },
      {
        id: 'fragment-catalog',
        role: 'user',
        content: 'Catalog plus <@kn-0003>',
        order: 2,
        source: 'builtin',
        fragmentContext: {
          mode: 'summary-index',
          scope: 'catalog',
          fragmentType: 'mixed',
          fragmentIds: ['kn-0002'],
        },
      },
    ]

    const receipt = createContextReceipt({
      writerBlocks: blocks,
      writerToolCalls: [{ toolName: 'readFragments', args: { fragmentIds: ['ch-0004'] } }],
      prewriterToolCalls: [{ toolName: 'readFragments', args: { fragmentIds: ['ch-0005'] } }],
    })

    expect(receipt).toEqual({
      version: 1,
      entries: [
        { fragmentId: 'ch-0001', access: 'full', actor: 'writer', reason: 'recent-context' },
        { fragmentId: 'kn-0002', access: 'catalog', actor: 'writer', reason: 'catalog' },
        { fragmentId: 'kn-0003', access: 'full', actor: 'writer', reason: 'explicit-tag' },
        { fragmentId: 'ch-0004', access: 'read', actor: 'writer', reason: 'explicit-read' },
        { fragmentId: 'ch-0005', access: 'read', actor: 'prewriter', reason: 'explicit-read' },
      ],
    })
  })

  // In prewriter mode createWriterBriefBlocks gives the writer only a brief and
  // prose, so without the planner's blocks the receipt records no full
  // presentation and the Librarian loses the records the passage came from.
  it('records fragment presentation from the prewriter when the writer only sees a brief', () => {
    const prewriterBlocks: ContextBlock[] = [
      {
        id: 'fragment-recent',
        role: 'user',
        content: 'Recent context',
        order: 1,
        source: 'builtin',
        fragmentContext: {
          mode: 'full',
          scope: 'recent',
          fragmentType: 'mixed',
          fragmentIds: ['ch-0001'],
        },
      },
    ]
    const writerBlocks: ContextBlock[] = [
      { id: 'writing-brief', role: 'user', content: '## Writing Brief', order: 2, source: 'builtin' },
    ]

    const receipt = createContextReceipt({ writerBlocks, prewriterBlocks })

    expect(receipt.entries).toEqual([
      { fragmentId: 'ch-0001', access: 'full', actor: 'prewriter', reason: 'recent-context' },
    ])
    expect(contextReceiptProvenanceIds(prose({ contextReceipt: receipt }))).toEqual(['ch-0001'])
    // Presentation to the planner is still provenance, not renewed relevance.
    expect(contextReceiptBridgeIds(prose({ contextReceipt: receipt }))).toEqual([])
  })

  it('uses reads and tags for the next-turn bridge but keeps all full context as same-passage provenance', () => {
    const fragment = prose({
      contextReceipt: {
        version: 1,
        entries: [
          { fragmentId: 'ch-0001', access: 'full', actor: 'writer', reason: 'inherited-presentation' },
          { fragmentId: 'kn-0002', access: 'catalog', actor: 'writer', reason: 'catalog' },
          { fragmentId: 'kn-0003', access: 'full', actor: 'writer', reason: 'explicit-tag' },
          { fragmentId: 'ch-0004', access: 'read', actor: 'writer', reason: 'explicit-read' },
        ],
      },
    })

    expect(contextReceiptBridgeIds(fragment)).toEqual(['kn-0003', 'ch-0004'])
    expect(contextReceiptProvenanceIds(fragment)).toEqual(['ch-0001', 'kn-0003', 'ch-0004'])
  })

  it('uses the receipt as the sole provenance source', () => {
    const fragment = prose({
      contextReceipt: {
        version: 1,
        entries: [{ fragmentId: 'ch-0001', access: 'full', actor: 'writer', reason: 'recent-context' }],
      },
    })

    expect(contextReceiptProvenanceIds(fragment)).toEqual(['ch-0001'])
  })
})
