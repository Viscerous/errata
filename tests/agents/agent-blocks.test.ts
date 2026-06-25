import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestSettings } from '../setup'
import { ensureCoreAgentsRegistered } from '@/server/agents'
import { agentBlockRegistry } from '@/server/agents/agent-block-registry'
import { modelRoleRegistry } from '@/server/agents/model-role-registry'
import type { AgentBlockContext } from '@/server/agents/agent-block-context'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'
import { recentCastFromFragment } from '@/server/librarian/blocks'

const now = new Date().toISOString()

function makeStory(overrides: Partial<StoryMeta> = {}): StoryMeta {
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story for block builder tests',
    coverImage: null,
    summary: 'The hero journeyed through the forest.',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
    ...overrides,
  }
}

function makeFragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: 'ch-test01',
    type: 'character',
    name: 'Hero',
    description: 'The main character',
    content: 'A brave hero who ventures into the unknown.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'system',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    archived: false,
    ...overrides,
  }
}

function makeBaseContext(overrides: Partial<AgentBlockContext> = {}): AgentBlockContext {
  return {
    story: makeStory(),
    proseFragments: [],
    stickyGuidelines: [],
    stickyKnowledge: [],
    stickyCharacters: [],
    guidelineShortlist: [],
    knowledgeShortlist: [],
    characterShortlist: [],
    systemPromptFragments: [],
    ...overrides,
  }
}

beforeEach(() => {
  ensureCoreAgentsRegistered()
})

describe('Agent Block Registry', () => {
  it('registers all 5 agents', () => {
    const agents = agentBlockRegistry.list()
    const names = agents.map(a => a.agentName)
    expect(names).toContain('librarian.analyze')
    expect(names).toContain('librarian.chat')
    expect(names).toContain('librarian.refine')
    expect(names).toContain('librarian.prose-transform')
    expect(names).toContain('character-chat.chat')
  })

  it('returns agent definitions by name', () => {
    const def = agentBlockRegistry.get('librarian.analyze')
    expect(def).toBeDefined()
    expect(def!.displayName).toBe('Librarian Analyze')
    expect(def!.availableTools).toBeDefined()
    expect(def!.availableTools!.length).toBeGreaterThan(0)
  })

  it('returns undefined for unknown agent', () => {
    expect(agentBlockRegistry.get('nonexistent')).toBeUndefined()
  })

  it('does not have modelRole on agent definitions', () => {
    const agents = agentBlockRegistry.list()
    for (const agent of agents) {
      expect(agent).not.toHaveProperty('modelRole')
    }
  })
})

describe('Model Role Registry — fallback chain derivation', () => {
  it('derives chain for a two-segment agent name', () => {
    const chain = modelRoleRegistry.getFallbackChain('librarian.chat')
    expect(chain).toEqual(['librarian.chat', 'librarian', 'generation'])
  })

  it('derives chain for generation.prewriter', () => {
    const chain = modelRoleRegistry.getFallbackChain('generation.prewriter')
    expect(chain).toEqual(['generation.prewriter', 'generation'])
  })

  it('returns just [generation] for the root role', () => {
    const chain = modelRoleRegistry.getFallbackChain('generation')
    expect(chain).toEqual(['generation'])
  })

  it('derives chain for a hyphenated two-segment agent name', () => {
    const chain = modelRoleRegistry.getFallbackChain('character-chat.chat')
    expect(chain).toEqual(['character-chat.chat', 'character-chat', 'generation'])
  })

  it('derives chain for a deeply nested key', () => {
    const chain = modelRoleRegistry.getFallbackChain('a.b.c')
    expect(chain).toEqual(['a.b.c', 'a.b', 'a', 'generation'])
  })

  it('registers namespace-level roles only (4 total)', () => {
    const roles = modelRoleRegistry.list()
    const keys = roles.map(r => r.key).sort()
    expect(keys).toEqual(['character-chat', 'directions', 'generation', 'librarian'])
  })
})

describe('Librarian Analyze Blocks', () => {
  it('produces instructions and story-summary blocks at minimum', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    const ids = blocks.map(b => b.id)
    expect(ids).toContain('instructions')
    expect(ids).toContain('story-summary')
  })

  it('includes characters block when allCharacters provided', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [makeFragment({ id: 'ch-hero01', name: 'Hero', description: 'A brave hero' })],
    }))
    const chBlock = blocks.find(b => b.id === 'characters-shortlist')
    expect(chBlock).toBeDefined()
    expect(chBlock!.content).toContain('Hero')
  })

  it('recentCastFromFragment resolves characters from the fragment writerContextIds', () => {
    const alice = makeFragment({ id: 'ch-alice', type: 'character' })
    const bob = makeFragment({ id: 'ch-bob', type: 'character' })
    const fragment = makeFragment({ id: 'pr-1', type: 'prose', meta: { writerContextIds: ['ch-alice'] } })

    expect(recentCastFromFragment([alice, bob], fragment).map(c => c.id)).toEqual(['ch-alice'])
    expect(recentCastFromFragment([alice, bob], null)).toEqual([])
  })

  it('renders recent-cast characters in full and drops them from the shortlist', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const hero = makeFragment({ id: 'ch-hero01', name: 'Hero', description: 'A brave hero', content: 'Hero full sheet body.' })
    const villain = makeFragment({ id: 'ch-vil01', name: 'Villain', description: 'The antagonist', content: 'Villain full sheet body.' })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [hero, villain],
      recentCharacters: [hero],
    }))

    const recent = blocks.find(b => b.id === 'characters-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('Hero full sheet body.')

    // The recent character is not duplicated into the summary shortlist; the
    // other character still appears there.
    const shortlist = blocks.find(b => b.id === 'characters-shortlist')
    expect(shortlist).toBeDefined()
    expect(shortlist!.content).toContain('ch-vil01')
    expect(shortlist!.content).not.toContain('ch-hero01')
  })

  it('analyze preloads pinned characters in full in a dedicated block, even when not in the recent cast', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const pinned = makeFragment({ id: 'ch-pin01', name: 'Mentor', description: 'A wise mentor', content: 'Mentor full sheet body.' })
    const other = makeFragment({ id: 'ch-oth01', name: 'Extra', description: 'A bit player', content: 'Extra full sheet body.' })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [pinned, other],
      recentCharacters: [], // pinned is NOT in the forwarded recent cast
      stickyCharacters: [pinned],
    }))

    // Pinned char is rendered in full in its own block, not duplicated into the shortlist.
    const sticky = blocks.find(b => b.id === 'characters-sticky')
    expect(sticky).toBeDefined()
    expect(sticky!.content).toContain('## Pinned Characters')
    expect(sticky!.content).toContain('Mentor full sheet body.')
    const shortlist = blocks.find(b => b.id === 'characters-shortlist')
    expect(shortlist!.content).toContain('ch-oth01')
    expect(shortlist!.content).not.toContain('ch-pin01')
  })

  it('analyze shows a pinned character once, in the pinned block, even when also in the recent cast', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const hero = makeFragment({ id: 'ch-hero01', name: 'Hero', description: 'A brave hero', content: 'Hero sheet.' })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [hero],
      recentCharacters: [hero],
      stickyCharacters: [hero], // pinned AND recent — pinned takes precedence
    }))

    expect(blocks.find(b => b.id === 'characters-sticky')!.content).toContain('Hero sheet.')
    expect(blocks.find(b => b.id === 'characters-recent')).toBeUndefined()
  })

  it('includes knowledge block when allKnowledge provided', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allKnowledge: [makeFragment({ id: 'kn-magic1', type: 'knowledge', name: 'Magic System', content: 'Elemental magic.' })],
    }))
    const knBlock = blocks.find(b => b.id === 'knowledge')
    expect(knBlock).toBeDefined()
    expect(knBlock!.content).toContain('Magic System')
    // Knowledge is delivered in full to analyze, not as a summary.
    expect(knBlock!.content).toContain('Elemental magic.')
  })

  it('includes prose-new block when newProse provided', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      newProse: { id: 'pr-test01', content: 'The hero drew their sword.' },
    }))
    const proseBlock = blocks.find(b => b.id === 'prose-new')
    expect(proseBlock).toBeDefined()
    expect(proseBlock!.content).toContain('The hero drew their sword.')
  })

  it('includes system-fragments when tagged fragments provided', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      systemPromptFragments: [makeFragment({ id: 'gl-sys01', name: 'Custom Rules', content: 'Always analyze mentions.' })],
    }))
    const sysBlock = blocks.find(b => b.id === 'system-fragments')
    expect(sysBlock).toBeDefined()
    expect(sysBlock!.role).toBe('system')
    expect(sysBlock!.content).toContain('Custom Rules')
  })

  it('maintains correct block ordering within roles', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [makeFragment()],
      allKnowledge: [makeFragment({ id: 'kn-test01', type: 'knowledge', name: 'Lore' })],
      newProse: { id: 'pr-test01', content: 'New content' },
    }))
    // User blocks should be ordered: story-summary (100) < characters (200) < knowledge (300) < prose-new (400)
    const userBlocks = blocks.filter(b => b.role === 'user')
    const summaryOrder = userBlocks.find(b => b.id === 'story-summary')!.order
    const charsOrder = userBlocks.find(b => b.id === 'characters-shortlist')!.order
    const knowledgeOrder = userBlocks.find(b => b.id === 'knowledge')!.order
    const proseOrder = userBlocks.find(b => b.id === 'prose-new')!.order
    expect(summaryOrder).toBeLessThan(charsOrder)
    expect(charsOrder).toBeLessThan(knowledgeOrder)
    expect(knowledgeOrder).toBeLessThan(proseOrder)

    // System block: instructions should exist
    const systemBlocks = blocks.filter(b => b.role === 'system')
    expect(systemBlocks.find(b => b.id === 'instructions')).toBeDefined()
  })
})

describe('Librarian Chat Blocks', () => {
  it('produces instructions and story-info blocks', () => {
    const def = agentBlockRegistry.get('librarian.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    const ids = blocks.map(b => b.id)
    expect(ids).toContain('instructions')
    expect(ids).toContain('story-info')
  })

  it('does not enumerate plugin tools in instructions (they reach the model via the SDK schema)', () => {
    const def = agentBlockRegistry.get('librarian.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      pluginToolDescriptions: [{ name: 'myTool', description: 'Does something useful' }],
    }))
    const inst = blocks.find(b => b.id === 'instructions')!
    expect(inst.content).not.toContain('myTool')
    expect(inst.content).not.toContain('Does something useful')
  })

  it('includes prose-summaries when prose fragments provided', () => {
    const def = agentBlockRegistry.get('librarian.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      proseFragments: [makeFragment({
        id: 'pr-test01',
        type: 'prose',
        name: 'Chapter 1',
        content: 'A long prose fragment content here.',
        meta: { _librarian: { summary: 'Hero begins journey' } },
      })],
    }))
    const proseBlock = blocks.find(b => b.id === 'prose-summaries')
    expect(proseBlock).toBeDefined()
    expect(proseBlock!.content).toContain('Hero begins journey')
  })

  it('includes sticky-fragments and shortlist when provided', () => {
    const def = agentBlockRegistry.get('librarian.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyGuidelines: [makeFragment({ id: 'gl-stick1', name: 'Tone', description: 'Keep it dark' })],
      guidelineShortlist: [makeFragment({ id: 'gl-other1', name: 'Style', description: 'Gothic' })],
    }))
    expect(blocks.find(b => b.id === 'sticky-fragments')).toBeDefined()
    expect(blocks.find(b => b.id === 'shortlist')).toBeDefined()
  })
})

describe('Librarian Refine Blocks', () => {
  it('produces instructions and story-info blocks', () => {
    const def = agentBlockRegistry.get('librarian.refine')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    const ids = blocks.map(b => b.id)
    expect(ids).toContain('instructions')
    expect(ids).toContain('story-info')
  })

  it('includes target block when targetFragment provided', () => {
    const def = agentBlockRegistry.get('librarian.refine')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      targetFragment: makeFragment({ id: 'ch-hero01', name: 'Hero' }),
      instructions: 'Update the backstory',
    }))
    const target = blocks.find(b => b.id === 'target')
    expect(target).toBeDefined()
    expect(target!.content).toContain('ch-hero01')
    expect(target!.content).toContain('Update the backstory')
  })

  it('includes prose block when prose fragments provided', () => {
    const def = agentBlockRegistry.get('librarian.refine')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      proseFragments: [makeFragment({ id: 'pr-test01', type: 'prose', name: 'Ch 1', content: 'Story text.' })],
    }))
    expect(blocks.find(b => b.id === 'prose-recent')).toBeDefined()
  })
})

describe('Prose Transform Blocks', () => {
  it('produces instructions and story-summary blocks', () => {
    const def = agentBlockRegistry.get('librarian.prose-transform')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    const ids = blocks.map(b => b.id)
    expect(ids).toContain('instructions')
    expect(ids).toContain('story-summary')
  })

  it('includes operation, source, and selection blocks when provided', () => {
    const def = agentBlockRegistry.get('librarian.prose-transform')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      operation: 'rewrite',
      guidance: 'Make it more dramatic',
      selectedText: 'The hero walked.',
      sourceContent: 'Full paragraph with the hero walking.',
      contextBefore: 'Before text',
      contextAfter: 'After text',
    }))
    const ids = blocks.map(b => b.id)
    expect(ids).toContain('operation')
    expect(ids).toContain('source')
    expect(ids).toContain('selection')

    const op = blocks.find(b => b.id === 'operation')!
    expect(op.content).toContain('rewrite')
    expect(op.content).toContain('Make it more dramatic')

    const sel = blocks.find(b => b.id === 'selection')!
    expect(sel.content).toContain('The hero walked.')
    expect(sel.content).toContain('Before text')
    expect(sel.content).toContain('After text')
  })
})

describe('Character Chat Blocks', () => {
  it('produces story-context block at minimum', () => {
    const def = agentBlockRegistry.get('character-chat.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    expect(blocks.find(b => b.id === 'story-context')).toBeDefined()
  })

  it('includes character block when character provided', () => {
    const def = agentBlockRegistry.get('character-chat.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      character: makeFragment({ id: 'ch-hero01', name: 'Hero', content: 'A brave hero.', description: 'Main protagonist' }),
    }))
    const charBlock = blocks.find(b => b.id === 'character')
    expect(charBlock).toBeDefined()
    expect(charBlock!.role).toBe('system')
    expect(charBlock!.content).toContain('Hero')
    expect(charBlock!.content).toContain('A brave hero.')
  })

  it('includes persona block when personaDescription provided', () => {
    const def = agentBlockRegistry.get('character-chat.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      personaDescription: 'You are speaking with the village elder.',
    }))
    const persona = blocks.find(b => b.id === 'persona')
    expect(persona).toBeDefined()
    expect(persona!.content).toContain('village elder')
  })

  it('includes prose summaries in story-context', () => {
    const def = agentBlockRegistry.get('character-chat.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      proseFragments: [makeFragment({
        id: 'pr-test01',
        type: 'prose',
        name: 'Ch 1',
        content: 'Short prose.',
        meta: { _librarian: { summary: 'Hero arrives at village' } },
      })],
    }))
    const ctx = blocks.find(b => b.id === 'story-context')!
    expect(ctx.content).toContain('Hero arrives at village')
  })
})
