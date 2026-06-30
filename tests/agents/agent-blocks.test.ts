import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestSettings } from '../setup'
import { ensureCoreAgentsRegistered } from '@/server/agents'
import { agentBlockRegistry } from '@/server/agents/agent-block-registry'
import { modelRoleRegistry } from '@/server/agents/model-role-registry'
import type { AgentBlockContext } from '@/server/agents/agent-block-context'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'
import { buildAnalyzeSystemPrompt, recentCastFromFragment } from '@/server/librarian/blocks'

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
    const chBlock = blocks.find(b => b.id === 'character-shortlist')
    expect(chBlock).toBeDefined()
    expect(chBlock!.content).toContain('## Characters (Shortlist)')
    expect(chBlock!.content).toContain('not the full fragment')
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

    const recent = blocks.find(b => b.id === 'character-recent')
    expect(recent).toBeDefined()
    // Full sheet: the shared `id | name | desc` identity line as a heading (the
    // description is kept so proposals can target it) followed by the content.
    expect(recent!.content).toContain('### `ch-hero01` | Hero | A brave hero')
    expect(recent!.content).toContain('Hero full sheet body.')

    // The recent character is not duplicated into the summary shortlist; the
    // other character still appears there.
    const shortlist = blocks.find(b => b.id === 'character-shortlist')
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
    const sticky = blocks.find(b => b.id === 'character-sticky')
    expect(sticky).toBeDefined()
    expect(sticky!.content).toContain('## Pinned Characters')
    expect(sticky!.content).toContain('### `ch-pin01` | Mentor | A wise mentor')
    expect(sticky!.content).toContain('Mentor full sheet body.')
    const shortlist = blocks.find(b => b.id === 'character-shortlist')
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

    expect(blocks.find(b => b.id === 'character-sticky')!.content).toContain('Hero sheet.')
    expect(blocks.find(b => b.id === 'character-recent')).toBeUndefined()
  })

  it('includes knowledge block when allKnowledge provided', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allKnowledge: [makeFragment({ id: 'kn-magic1', type: 'knowledge', name: 'Magic System', content: 'Elemental magic.' })],
    }))
    const knBlock = blocks.find(b => b.id === 'knowledge')
    expect(knBlock).toBeDefined()
    expect(knBlock!.content).toContain('### `kn-magic1` | Magic System')
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
    const charsOrder = userBlocks.find(b => b.id === 'character-shortlist')!.order
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

  it('combines pinned, recent, and available fragment summaries into one index per type', () => {
    const def = agentBlockRegistry.get('librarian.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyGuidelines: [makeFragment({ id: 'gl-stick1', name: 'Tone', description: 'Keep it dark' })],
      stickyKnowledge: [makeFragment({ id: 'kn-stick1', type: 'knowledge', name: 'Treaty', description: 'Binding lore' })],
      recentKnowledge: [makeFragment({ id: 'kn-recent1', type: 'knowledge', name: 'Omen', description: 'Recently mentioned lore' })],
      stickyCustomFragments: [makeFragment({ id: 'loc-stick1', type: 'location', name: 'Library', description: 'Pinned place' })],
      guidelineShortlist: [makeFragment({ id: 'gl-other1', name: 'Style', description: 'Gothic' })],
      knowledgeShortlist: [makeFragment({ id: 'kn-other1', type: 'knowledge', name: 'Crown', description: 'Available lore' })],
      customFragmentShortlists: [
        {
          type: 'location',
          name: 'Locations',
          fragments: [makeFragment({ id: 'loc-other1', type: 'location', name: 'Bridge', description: 'Optional place' })],
        },
      ],
    }))
    expect(blocks.find(b => b.id === 'guideline-pinned-summary-index')).toBeUndefined()
    expect(blocks.find(b => b.id === 'guideline-shortlist')).toBeUndefined()
    expect(blocks.find(b => b.id === 'knowledge-pinned-summary-index')).toBeUndefined()
    expect(blocks.find(b => b.id === 'knowledge-shortlist')).toBeUndefined()

    const guideline = blocks.find(b => b.id === 'guideline-summary-index')
    expect(guideline).toBeDefined()
    expect(guideline!.content).toContain('## Guidelines (Shortlist)')
    expect(guideline!.content).toContain('not the full fragment')
    expect(guideline!.content).not.toContain('| ID | Name | Description |')
    expect(guideline!.content).toContain('`gl-stick1` | Tone (pinned) | Keep it dark')
    expect(guideline!.content).toContain('`gl-other1` | Style | Gothic')

    const knowledge = blocks.find(b => b.id === 'knowledge-summary-index')
    expect(knowledge).toBeDefined()
    expect(knowledge!.content).toContain('## Knowledge (Shortlist)')
    expect(knowledge!.content).toContain('`kn-stick1` | Treaty (pinned) | Binding lore')
    expect(knowledge!.content).toContain('`kn-recent1` | Omen (recent) | Recently mentioned lore')
    expect(knowledge!.content).toContain('`kn-other1` | Crown | Available lore')

    const locations = blocks.find(b => b.id === 'location-summary-index')
    expect(locations).toBeDefined()
    expect(locations!.content).toContain('## Locations (Shortlist)')
    expect(locations!.content).toContain('`loc-stick1` | Library (pinned) | Pinned place')
    expect(locations!.content).toContain('`loc-other1` | Bridge | Optional place')
    expect(locations!.fragmentContext).toEqual({
      mode: 'summary-index',
      scope: 'catalog',
      fragmentType: 'location',
    })
  })
})

describe('Librarian Refine Blocks', () => {
  it('produces instructions and story-info blocks', () => {
    const def = agentBlockRegistry.get('librarian.refine')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    const ids = blocks.map(b => b.id)
    expect(ids).toContain('instructions')
    expect(ids).toContain('story-info')
    const instructions = blocks.find(b => b.id === 'instructions')!
    expect(instructions.content).toContain('read the target fragment using **readFragments**')
    expect(instructions.content).not.toContain('getCharacter')
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
describe('Librarian Analyze Prompt', () => {
  it('reports named character references', () => {
    const prompt = buildAnalyzeSystemPrompt()
    expect(prompt).toContain('direct name, nickname, title, role')
    expect(prompt).toContain('Scan the new prose against every fragment')
    expect(prompt).toContain('ambiguous word refers to two entities')
  })

  it('includes custom fragment groups for mention detection', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCustomFragments: [
        {
          type: 'location',
          name: 'Locations',
          fragments: [makeFragment({ id: 'loc-0001', type: 'location', name: 'Ash Market', description: 'A market below the city' })],
        },
      ],
      newProse: { id: 'pr-0001', content: 'They crossed the Ash Market.' },
    }))

    const custom = blocks.find(b => b.id === 'location-shortlist')
    expect(custom).toBeDefined()
    expect(custom!.content).toContain('## Locations (Shortlist)')
    expect(custom!.content).toContain('loc-0001')
    expect(custom!.content).toContain('A market below the city')
  })
})

describe('Librarian Optimize Character Blocks', () => {
  it('uses the generic readFragments tool in instructions', () => {
    const def = agentBlockRegistry.get('librarian.optimize-character')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    const instructions = blocks.find(b => b.id === 'instructions')!
    expect(instructions.content).toContain('Read the target character fragment using readFragments')
    expect(instructions.content).not.toContain('getCharacter')
  })

  it('uses one all-character summary index instead of separate pinned character summaries', () => {
    const def = agentBlockRegistry.get('librarian.optimize-character')!
    const pinned = makeFragment({ id: 'ch-pin01', name: 'Mentor', description: 'Pinned mentor', sticky: true })
    const other = makeFragment({ id: 'ch-oth01', name: 'Rival', description: 'Other character' })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyCharacters: [pinned],
      allCharacters: [pinned, other],
      targetFragment: pinned,
    }))

    expect(blocks.find(b => b.id === 'character-pinned-summary-index')).toBeUndefined()
    const allCharacters = blocks.find(b => b.id === 'character-shortlist')
    expect(allCharacters).toBeDefined()
    expect(allCharacters!.content).toContain('## All Characters (Shortlist)')
    expect(allCharacters!.content).toContain('ch-pin01')
    expect(allCharacters!.content).toContain('ch-oth01')
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

describe('Directions Blocks', () => {
  it('includes knowledge-sticky and knowledge-recent blocks when provided', () => {
    const def = agentBlockRegistry.get('directions.suggest')!
    const stickyKnowledge = makeFragment({ id: 'kn-magic', type: 'knowledge', name: 'Magic System', content: 'Sticky lore', sticky: true })
    const recentKnowledge = makeFragment({ id: 'kn-sword', type: 'knowledge', name: 'Sword', content: 'Recent lore', sticky: false })

    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyKnowledge: [stickyKnowledge],
      recentKnowledge: [recentKnowledge],
    }))

    const stickyBlock = blocks.find(b => b.id === 'knowledge-sticky')
    expect(stickyBlock).toBeDefined()
    expect(stickyBlock!.content).toContain('Magic System')
    expect(stickyBlock!.content).toContain('Sticky lore')

    const recentBlock = blocks.find(b => b.id === 'knowledge-recent')
    expect(recentBlock).toBeDefined()
    expect(recentBlock!.content).toContain('Sword')
    expect(recentBlock!.content).toContain('Recent lore')
  })

  it('includes custom sticky and recent context when provided', () => {
    const def = agentBlockRegistry.get('directions.suggest')!
    const stickyLocation = makeFragment({ id: 'loc-sticky', type: 'location', name: 'Library', description: 'Pinned place', content: 'Pinned place lore', sticky: true })
    const recentLocation = makeFragment({ id: 'loc-recent', type: 'location', name: 'Market', description: 'Recent place', content: 'Recent place lore', sticky: false })
    const shortlistLocation = makeFragment({ id: 'loc-short', type: 'location', name: 'Bridge', description: 'Optional place', content: 'Shortlist full lore', sticky: false })

    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyCustomFragments: [stickyLocation],
      recentCustomFragments: [{ type: 'location', name: 'Locations', fragments: [recentLocation] }],
      customFragmentShortlists: [{ type: 'location', name: 'Locations', fragments: [shortlistLocation] }],
    }))

    const sticky = blocks.find(b => b.id === 'custom-sticky')
    expect(sticky).toBeDefined()
    expect(sticky!.content).toContain('Pinned place lore')

    const recent = blocks.find(b => b.id === 'location-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('Recent place lore')

    expect(blocks.find(b => b.id === 'location-shortlist')).toBeUndefined()
    expect(blocks.map((block) => block.content).join('\n')).not.toContain('loc-short')
  })
})

describe('Writer Blocks', () => {
  it('includes recent and shortlist blocks for built-in and custom fragments when provided', () => {
    const def = agentBlockRegistry.get('generation.writer')!
    const recentKnowledge = makeFragment({ id: 'kn-sword', type: 'knowledge', name: 'Sword', content: 'Recent lore', sticky: false })
    const knowledgeShortlist = [makeFragment({ id: 'kn-shield', type: 'knowledge', name: 'Shield', content: 'Shortlist lore', sticky: false })]
    const recentLocation = makeFragment({ id: 'loc-market', type: 'location', name: 'Market', description: 'Recent place', content: 'Recent place lore', sticky: false })
    const shortlistLocation = makeFragment({ id: 'loc-bridge', type: 'location', name: 'Bridge', description: 'Optional place', content: 'Shortlist full lore', sticky: false })

    const blocks = def.createDefaultBlocks(makeBaseContext({
      recentKnowledge: [recentKnowledge],
      knowledgeShortlist: knowledgeShortlist,
      recentCustomFragments: [{ type: 'location', name: 'Locations', fragments: [recentLocation] }],
      customFragmentShortlists: [{ type: 'location', name: 'Locations', fragments: [shortlistLocation] }],
    }))

    const recent = blocks.find(b => b.id === 'knowledge-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('Recent lore')

    const shortlist = blocks.find(b => b.id === 'knowledge-shortlist')
    expect(shortlist).toBeDefined()
    expect(shortlist!.content).toContain('## Knowledge (Shortlist)')
    expect(shortlist!.content).toContain('Shield')

    const customRecent = blocks.find(b => b.id === 'location-recent')
    expect(customRecent).toBeDefined()
    expect(customRecent!.content).toContain('Recent place lore')
    expect(customRecent!.fragmentContext).toEqual({
      mode: 'full',
      scope: 'recent',
      fragmentType: 'location',
    })

    const customShortlist = blocks.find(b => b.id === 'location-shortlist')
    expect(customShortlist).toBeDefined()
    expect(customShortlist!.content).toContain('## Locations (Shortlist)')
    expect(customShortlist!.content).toContain('loc-bridge')
    expect(customShortlist!.content).toContain('Optional place')
    expect(customShortlist!.content).not.toContain('Shortlist full lore')
    expect(customShortlist!.fragmentContext).toEqual({
      mode: 'summary-index',
      scope: 'available',
      fragmentType: 'location',
    })
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
    const instructions = blocks.find(b => b.id === 'instructions')
    expect(instructions).toBeDefined()
    expect(instructions!.role).toBe('system')
    expect(instructions!.content).not.toContain('Hero')
    const charBlock = blocks.find(b => b.id === 'character')
    expect(charBlock).toBeDefined()
    expect(charBlock!.role).toBe('user')
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
    expect(persona!.role).toBe('user')
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
    expect(ctx.role).toBe('user')
    expect(ctx.content).toContain('Hero arrives at village')
  })

  it('labels pinned story context as summaries', () => {
    const def = agentBlockRegistry.get('character-chat.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyKnowledge: [makeFragment({
        id: 'kn-test01',
        type: 'knowledge',
        name: 'Magic System',
        description: 'Rules for magic',
        content: 'Full magic details should not be in this summary list.',
      })],
    }))
    const ctx = blocks.find(b => b.id === 'story-context')!
    expect(ctx.content).toContain('## Pinned Knowledge (Shortlist)')
    expect(ctx.content).toContain('not the full fragment')
    expect(ctx.content).toContain('kn-test01')
    expect(ctx.content).toContain('Rules for magic')
    expect(ctx.content).not.toContain('Full magic details should not be in this summary list.')
  })

  it('does not duplicate the active character in pinned character summaries', () => {
    const def = agentBlockRegistry.get('character-chat.chat')!
    const hero = makeFragment({
      id: 'ch-hero01',
      type: 'character',
      name: 'Hero',
      description: 'Pinned protagonist',
      content: 'Full hero sheet.',
      sticky: true,
    })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      character: hero,
      stickyCharacters: [hero],
    }))

    const ctx = blocks.find(b => b.id === 'story-context')!
    expect(ctx.content).not.toContain('## Pinned Characters (Shortlist)')
    expect(ctx.content).not.toContain('- ch-hero01:')
  })
})
