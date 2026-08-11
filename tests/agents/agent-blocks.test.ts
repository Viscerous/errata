import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeCharacterKnowledge,
  makeContinuityView,
  makeLiveThread,
  makeTestSettings,
} from '../setup'
import { ensureCoreAgentsRegistered } from '@/server/agents'
import { agentBlockRegistry } from '@/server/agents/agent-block-registry'
import { modelRoleRegistry } from '@/server/agents/model-role-registry'
import type { AgentBlockContext } from '@/server/agents/agent-block-context'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'
import { buildAnalyzeSystemPrompt } from '@/server/librarian/blocks'

const now = new Date().toISOString()

function makeStory(overrides: Partial<StoryMeta> = {}): StoryMeta {
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story for block builder tests',
    coverImage: null,
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
    guidelineCatalog: [],
    knowledgeCatalog: [],
    characterCatalog: [],
    customFragmentCatalogs: [],
    systemPromptFragments: [],
    ...overrides,
  }
}

beforeEach(() => {
  ensureCoreAgentsRegistered()
})

describe('Agent Block Registry', () => {
  it('registers all 6 agents', () => {
    const agents = agentBlockRegistry.list()
    const names = agents.map(a => a.agentName)
    expect(names).toContain('librarian.analyze')
    expect(names).toContain('librarian.chat')
    expect(names).toContain('librarian.refine')
    expect(names).toContain('librarian.prose-transform')
    expect(names).toContain('character-chat.chat')
    expect(names).toContain('story-setup.chat')
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

  it('registers namespace-level roles only (5 total)', () => {
    const roles = modelRoleRegistry.list()
    const keys = roles.map(r => r.key).sort()
    expect(keys).toEqual(['character-chat', 'directions', 'generation', 'librarian', 'story-setup'])
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
    const catalog = blocks.find(b => b.id === 'fragment-catalog')
    expect(catalog).toBeDefined()
    expect(catalog!.content).toContain('## Fragment Catalog')
    expect(catalog!.content).toContain('one-line catalog row, not the full fragment')
    expect(catalog!.content).toContain('### Characters')
    expect(catalog!.content).toContain('Hero')
  })

  it('gives analyze the keyed continuity registry including dormant threads', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      continuityView: {
        currentState: [{
          sourceFragmentId: 'pr-0001',
          analysisId: 'la-1',
          narrativePosition: 1,
          stateKey: 'alice.location',
          subject: 'Alice location',
          value: 'north gate',
        }],
        liveThreads: [{
          sourceFragmentId: 'pr-0001',
          analysisId: 'la-1',
          narrativePosition: 1,
          threadKey: 'missing-key',
          label: 'The missing key',
          relatedFragmentIds: [],
          visibility: 'dormant',
        }],
        characterKnowledge: [],
        temporalFrame: { relation: 'forward' },
        staleProjectionCount: 0,
      },
    }))

    const memory = blocks.find((block) => block.id === 'continuity-memory')
    expect(memory?.content).toContain('alice.location | Alice location | north gate')
    expect(memory?.content).toContain('missing-key | The missing key | dormant')
    expect(memory?.content).toContain('Thread omission means dormancy, never resolution')
  })

  it('renders recent-context characters in full and drops them from the catalog', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const hero = makeFragment({ id: 'ch-hero01', name: 'Hero', description: 'A brave hero', content: 'Hero full sheet body.\n\n' })
    const villain = makeFragment({ id: 'ch-vil01', name: 'Villain', description: 'The antagonist', content: 'Villain full sheet body.' })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [hero, villain],
      recentCharacters: [hero],
    }))

    const recent = blocks.find(b => b.id === 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('## Recent Fragments')
    expect(recent!.content).toContain('### Characters')
    // Full sheet: the shared `id | name | desc` identity line as a heading (the
    // description is kept so proposals can target it) followed by the content.
    expect(recent!.content).toContain('#### `ch-hero01` | Hero | A brave hero')
    expect(recent!.content).toContain('Hero full sheet body.')
    expect(recent!.content).not.toMatch(/\n{3,}/)

    // The recent character is not duplicated into the catalog; the other
    // character still appears there.
    const catalog = blocks.find(b => b.id === 'fragment-catalog')
    expect(catalog).toBeDefined()
    expect(catalog!.content).toContain('ch-vil01')
    expect(catalog!.content).not.toContain('ch-hero01')
  })

  it('analyze preloads pinned characters in full in a dedicated block, even when not in recent context', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const pinned = makeFragment({ id: 'ch-pin01', name: 'Mentor', description: 'A wise mentor', content: 'Mentor full sheet body.' })
    const other = makeFragment({ id: 'ch-oth01', name: 'Extra', description: 'A bit player', content: 'Extra full sheet body.' })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [pinned, other],
      recentCharacters: [], // pinned is NOT in recent context
      stickyCharacters: [pinned],
    }))

    // Pinned char is rendered in full in the pinned-fragment block, not duplicated into the catalog.
    const pinnedBlock = blocks.find(b => b.id === 'fragment-pinned')
    expect(pinnedBlock).toBeDefined()
    expect(pinnedBlock!.content).toContain('## Pinned Fragments')
    expect(pinnedBlock!.content).toContain('### Characters')
    expect(pinnedBlock!.content).toContain('#### `ch-pin01` | Mentor | A wise mentor')
    expect(pinnedBlock!.content).toContain('Mentor full sheet body.')
    const catalog = blocks.find(b => b.id === 'fragment-catalog')
    expect(catalog!.content).toContain('ch-oth01')
    expect(catalog!.content).not.toContain('ch-pin01')
  })

  it('analyze shows a pinned character once, in the pinned block, even when also in recent context', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const hero = makeFragment({ id: 'ch-hero01', name: 'Hero', description: 'A brave hero', content: 'Hero sheet.' })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [hero],
      recentCharacters: [hero],
      stickyCharacters: [hero], // pinned AND recent — pinned takes precedence
    }))

    const pinnedBlock = blocks.find(b => b.id === 'fragment-pinned')
    expect(pinnedBlock).toBeDefined()
    expect((pinnedBlock!.content.match(/Hero sheet\./g) ?? [])).toHaveLength(1)
    expect(blocks.find(b => b.id === 'fragment-recent')).toBeUndefined()
    expect(blocks.find(b => b.id === 'character-sticky')).toBeUndefined()
    expect(blocks.find(b => b.id === 'character-recent')).toBeUndefined()
  })

  it('keeps unselected knowledge as catalog rows in online analyze', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allKnowledge: [makeFragment({ id: 'kn-magic1', type: 'knowledge', name: 'Magic System', content: 'Elemental magic.' })],
    }))
    expect(blocks.find(b => b.id === 'fragment-pinned')).toBeUndefined()
    expect(blocks.find(b => b.id === 'fragment-recent')).toBeUndefined()
    expect(blocks.find(b => b.id === 'fragment-writer-context')).toBeUndefined()
    expect(blocks.find(b => b.id === 'fragment-candidates')).toBeUndefined()
    expect(blocks.find(b => b.id === 'knowledge')).toBeUndefined()
    const catalog = blocks.find(b => b.id === 'fragment-catalog')
    expect(catalog).toBeDefined()
    expect(catalog!.content).toContain('### Knowledge')
    expect(catalog!.content).toContain('`kn-magic1` | Magic System')
    expect(catalog!.content).not.toContain('Elemental magic.')
  })

  it('does not cap sticky full knowledge bodies in online analyze', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const knowledge = Array.from({ length: 5 }, (_, i) => makeFragment({
      id: `kn-cap0${i + 1}`,
      type: 'knowledge',
      name: `Lore ${i + 1}`,
      content: `Full lore body ${i + 1}.`,
      sticky: true,
    }))
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allKnowledge: knowledge,
      stickyKnowledge: knowledge,
    }))

    const full = blocks.find(b => b.id === 'fragment-pinned')
    expect(full).toBeDefined()
    expect(full!.content).toContain('### Knowledge')
    expect((full!.content.match(/Full lore body/g) ?? [])).toHaveLength(5)
    expect(blocks.find(b => b.id === 'fragment-catalog')).toBeUndefined()
  })

  it('includes recent and sticky fragments without numeric demotion', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const stickyKnowledge = Array.from({ length: 6 }, (_, i) => makeFragment({
      id: `kn-stick${i + 1}`,
      type: 'knowledge',
      name: `Sticky ${i + 1}`,
      content: `Sticky body ${i + 1}.`,
      sticky: true,
    }))
    const recentKnowledge = makeFragment({
      id: 'kn-recent',
      type: 'knowledge',
      name: 'Recent Lore',
      content: 'Recent body.',
    })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allKnowledge: [...stickyKnowledge, recentKnowledge],
      stickyKnowledge,
      recentKnowledge: [recentKnowledge],
      attentionCandidateIds: ['kn-recent'],
    }))

    const pinnedBlock = blocks.find(b => b.id === 'fragment-pinned')
    expect(pinnedBlock).toBeDefined()
    expect(pinnedBlock!.content).toContain('### Knowledge')
    expect((pinnedBlock!.content.match(/Sticky body/g) ?? [])).toHaveLength(6)

    const recent = blocks.find(b => b.id === 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('### Knowledge')
    expect(recent!.content).toContain('Recent body.')
    expect(blocks.find(b => b.id === 'fragment-catalog')).toBeUndefined()
  })

  it('includes prose-new block when newProse provided', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      newProse: { id: 'pr-test01', content: 'The hero drew their sword.' },
    }))
    const proseBlock = blocks.find(b => b.id === 'prose-new')
    expect(proseBlock).toBeDefined()
    expect(proseBlock!.content).toContain('## New Prose Fragment\n\nFragment ID: pr-test01')
    // Numbered so evidence can cite a sentence instead of retyping it.
    expect(proseBlock!.content).toContain('[1] The hero drew their sword.')
    expect(proseBlock!.content).not.toMatch(/\n{3,}/)
  })

  it('includes system-fragments when tagged fragments provided', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      systemPromptFragments: [makeFragment({ id: 'gl-sys01', name: 'Custom Rules', content: 'Always analyze mentions.' })],
    }))
    const sysBlock = blocks.find(b => b.id === 'system-fragments')
    expect(sysBlock).toBeDefined()
    expect(sysBlock!.role).toBe('system')
    expect(sysBlock!.content).toContain('## System Prompt Fragments\n\n### Custom Rules\n\nAlways analyze mentions.')
    expect(sysBlock!.content).toContain('Custom Rules')
    expect(sysBlock!.content).not.toMatch(/\n{3,}/)
  })

  it('maintains correct block ordering within roles', () => {
    const def = agentBlockRegistry.get('librarian.analyze')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      allCharacters: [makeFragment()],
      allKnowledge: [makeFragment({ id: 'kn-test01', type: 'knowledge', name: 'Lore' })],
      newProse: { id: 'pr-test01', content: 'New content' },
    }))
    // User blocks should be ordered: story-summary (100) < fragment catalog (390) < prose-new (400)
    const userBlocks = blocks.filter(b => b.role === 'user')
    const summaryOrder = userBlocks.find(b => b.id === 'story-summary')!.order
    const catalogOrder = userBlocks.find(b => b.id === 'fragment-catalog')!.order
    const proseOrder = userBlocks.find(b => b.id === 'prose-new')!.order
    expect(summaryOrder).toBeLessThan(catalogOrder)
    expect(catalogOrder).toBeLessThan(proseOrder)

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
      })],
    }))
    const proseBlock = blocks.find(b => b.id === 'prose-summaries')
    expect(proseBlock).toBeDefined()
    expect(proseBlock!.content).toContain('A long prose fragment content here.')
  })

  it('combines pinned, recent, and available fragment summaries into one catalog', () => {
    const def = agentBlockRegistry.get('librarian.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyGuidelines: [makeFragment({ id: 'gl-stick1', name: 'Tone', description: 'Keep it dark' })],
      stickyKnowledge: [makeFragment({ id: 'kn-stick1', type: 'knowledge', name: 'Treaty', description: 'Binding lore' })],
      recentKnowledge: [makeFragment({ id: 'kn-recent1', type: 'knowledge', name: 'Omen', description: 'Recently mentioned lore' })],
      stickyCustomFragments: [makeFragment({ id: 'loc-stick1', type: 'location', name: 'Library', description: 'Pinned place' })],
      guidelineCatalog: [makeFragment({ id: 'gl-other1', name: 'Style', description: 'Gothic' })],
      knowledgeCatalog: [makeFragment({ id: 'kn-other1', type: 'knowledge', name: 'Crown', description: 'Available lore' })],
      customFragmentCatalogs: [
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

    const catalog = blocks.find(b => b.id === 'fragment-catalog')
    expect(catalog).toBeDefined()
    expect(catalog!.content).toContain('## Fragment Catalog')
    expect(catalog!.content).toContain('one-line catalog row, not the full fragment')
    expect(catalog!.content).not.toContain('| ID | Name | Description |')
    expect(catalog!.content).toContain('### Guidelines')
    expect(catalog!.content).toContain('`gl-stick1` | Tone (pinned) | Keep it dark')
    expect(catalog!.content).toContain('`gl-other1` | Style | Gothic')
    expect(catalog!.content).toContain('### Knowledge')
    expect(catalog!.content).toContain('`kn-stick1` | Treaty (pinned) | Binding lore')
    expect(catalog!.content).toContain('`kn-recent1` | Omen (recent) | Recently mentioned lore')
    expect(catalog!.content).toContain('`kn-other1` | Crown | Available lore')
    expect(catalog!.content).toContain('### Locations')
    expect(catalog!.content).toContain('`loc-stick1` | Library (pinned) | Pinned place')
    expect(catalog!.content).toContain('`loc-other1` | Bridge | Optional place')
    expect(catalog!.fragmentContext).toEqual({
      mode: 'summary-index',
      scope: 'catalog',
      fragmentType: 'mixed',
      fragmentIds: ['gl-stick1', 'gl-other1', 'kn-stick1', 'kn-recent1', 'kn-other1', 'loc-stick1', 'loc-other1'],
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
    expect(instructions.content).toContain('complete target snapshot')
    expect(instructions.content).not.toContain('getCharacter')
  })

  it('includes target block when targetFragment provided', () => {
    const def = agentBlockRegistry.get('librarian.refine')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      targetFragment: makeFragment({ id: 'ch-hero01', name: 'Hero', content: 'Current hero sheet.' }),
      instructions: 'Update the backstory',
    }))
    const target = blocks.find(b => b.id === 'target')
    expect(target).toBeDefined()
    expect(target!.content).toContain('## Target fragment to refine\n\nID: ch-hero01')
    expect(target!.content).toContain('### User Instructions\n\nUpdate the backstory')
    expect(target!.content).toContain('### Current Content\n\nCurrent hero sheet.')
    expect(target!.content).toMatch(/Base hash: [a-f0-9]{16}/)
    expect(target!.content).toContain('ch-hero01')
    expect(target!.content).toContain('Update the backstory')
    expect(target!.content).not.toMatch(/\n{3,}/)
  })

  it('includes prose block when prose fragments provided', () => {
    const def = agentBlockRegistry.get('librarian.refine')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      proseFragments: [makeFragment({ id: 'pr-test01', type: 'prose', name: 'Ch 1', content: 'Story text.' })],
    }))
    const prose = blocks.find(b => b.id === 'prose-recent')
    expect(prose).toBeDefined()
    expect(prose!.content).toContain('## Recent Prose\n\n### Ch 1 (pr-test01)\n\nStory text.')
    expect(prose!.content).not.toMatch(/\n{3,}/)
  })

  it('includes folded continuity and scopes character knowledge to its target', () => {
    const target = makeFragment({ id: 'ch-target', type: 'character', name: 'Mara' })
    const blocks = agentBlockRegistry.get('librarian.refine')!.createDefaultBlocks(makeBaseContext({
      targetFragment: target,
      continuityView: makeContinuityView({
        characterKnowledge: [makeCharacterKnowledge({
          characterId: target.id,
          fact: 'Mara knows the gate is watched.',
        })],
      }),
    }))
    const continuity = blocks.find((block) => block.id === 'continuity-observations')!
    expect(continuity.content).toContain('Mara knows or believes:')
    expect(continuity.content).toContain('Mara knows the gate is watched.')
    expect(continuity.content).toContain('Respect it as evidence while editing')
  })

  it('aggregates pinned fragment summaries into one pinned catalog', () => {
    const def = agentBlockRegistry.get('librarian.refine')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyGuidelines: [makeFragment({ id: 'gl-pin01', type: 'guideline', name: 'Tone', description: 'Keep the prose sharp' })],
      stickyKnowledge: [makeFragment({ id: 'kn-pin01', type: 'knowledge', name: 'Accord', description: 'A binding treaty' })],
      stickyCharacters: [makeFragment({ id: 'ch-pin01', type: 'character', name: 'Mentor', description: 'Pinned mentor' })],
    }))

    expect(blocks.find(b => b.id === 'guideline-pinned-summary-index')).toBeUndefined()
    expect(blocks.find(b => b.id === 'knowledge-pinned-summary-index')).toBeUndefined()
    expect(blocks.find(b => b.id === 'character-pinned-summary-index')).toBeUndefined()

    const catalog = blocks.find(b => b.id === 'fragment-pinned-catalog')
    expect(catalog).toBeDefined()
    expect(catalog!.content).toContain('## Pinned Fragment Catalog')
    expect(catalog!.content).toContain('one-line catalog row, not the full fragment')
    expect(catalog!.content).toContain('### Guidelines')
    expect(catalog!.content).toContain('`gl-pin01` | Tone | Keep the prose sharp')
    expect(catalog!.content).toContain('### Knowledge')
    expect(catalog!.content).toContain('`kn-pin01` | Accord | A binding treaty')
    expect(catalog!.content).toContain('### Characters')
    expect(catalog!.content).toContain('`ch-pin01` | Mentor | Pinned mentor')
    expect(catalog!.fragmentContext).toEqual({
      mode: 'summary-index',
      scope: 'pinned',
      fragmentType: 'mixed',
      fragmentIds: ['gl-pin01', 'kn-pin01', 'ch-pin01'],
    })
  })
})
// The fold runs inside buildContextState for nearly every agent, so an agent
// that decides what a passage does must render it rather than silently drop it.
describe('Continuity reaches the agents that decide what happens next', () => {
  const viewFixture = makeContinuityView({
    currentState: [{
      sourceFragmentId: 'pr-0001',
      analysisId: 'la-1',
      narrativePosition: 1,
      stateKey: 'alice_location',
      subject: 'Alice location',
      value: 'north gate',
    }],
    liveThreads: [],
    characterKnowledge: [],
    temporalFrame: { relation: 'forward' },
  })

  it('renders a continuity block for the writer, the planner, and directions', () => {
    for (const agentName of ['generation.writer', 'generation.prewriter', 'directions.suggest']) {
      const def = agentBlockRegistry.get(agentName)!
      const blocks = def.createDefaultBlocks(makeBaseContext({ continuityView: viewFixture }))
      const block = blocks.find((b) => b.id === 'continuity-observations')
      expect(block, `${agentName} should render continuity`).toBeDefined()
      expect(block!.content).toContain('Alice location: north gate')
    }
  })

  it('omits the block entirely when there is nothing folded yet', () => {
    for (const agentName of ['generation.writer', 'generation.prewriter', 'directions.suggest']) {
      const def = agentBlockRegistry.get(agentName)!
      const blocks = def.createDefaultBlocks(makeBaseContext())
      expect(blocks.some((b) => b.id === 'continuity-observations'), agentName).toBe(false)
    }
  })

  it('presents character names rather than internal IDs to every authorial generator', () => {
    const zinozi = makeFragment({ id: 'ch-zinozi', type: 'character', name: 'Zinozi' })
    const continuityView = makeContinuityView({
      characterKnowledge: [makeCharacterKnowledge({
        characterId: zinozi.id,
        fact: 'Zinozi knows the bell was moved.',
      })],
    })

    for (const agentName of ['generation.writer', 'generation.prewriter', 'directions.suggest']) {
      const continuity = agentBlockRegistry.get(agentName)!
        .createDefaultBlocks(makeBaseContext({ continuityView, stickyCharacters: [zinozi] }))
        .find((block) => block.id === 'continuity-observations')!
      expect(continuity.content, agentName).toContain('Zinozi knows or believes:')
      expect(continuity.content, agentName).not.toContain('ch-zinozi knows or believes:')
    }
  })
})

describe('Librarian Analyze Prompt', () => {
  it('reports named character references', () => {
    const prompt = buildAnalyzeSystemPrompt()
    expect(prompt).toContain('direct names, nicknames, titles, roles')
    expect(prompt).toContain('let it remain dormant indefinitely')
    expect(prompt).toContain('cite, never retype')
    expect(prompt).toContain('2. Scan the new prose against the provided context')
    expect(prompt).toContain('resolvedFragments')
    expect(prompt).toContain('4. Call **proposeDirections**')
    expect(prompt).toContain('5. Finally, call **finishAnalysis**')
    expect(prompt).toContain('candidateFragmentIds')
    // The two questions are named against each other, because asking only what
    // the passage mentions left records it invalidated without ever naming.
    expect(prompt).toContain('which existing records this passage has made inaccurate')
    expect(prompt).toContain('If a surface term is ambiguous')
    expect(prompt).not.toContain('final assistant text')
    expect(prompt).not.toContain('Analysis complete')
  })

  it('makes the last enabled analyze action explicit without naming disabled tools', () => {
    const noDirections = buildAnalyzeSystemPrompt({ disableDirections: true })
    expect(noDirections).toContain('3. Use **proposeRecordCorrections**')
    expect(noDirections).toContain('4. Finally, call **finishAnalysis**')
    expect(noDirections).not.toContain('proposeDirections')

    const noSuggestions = buildAnalyzeSystemPrompt({ disableSuggestions: true })
    expect(noSuggestions).toContain('3. Call **proposeDirections**')
    expect(noSuggestions).toContain('4. Finally, call **finishAnalysis**')
    expect(noSuggestions).not.toContain('proposeRecordCorrections')
    expect(noSuggestions).not.toContain('proposeNewRecords')

    const noOptionalTools = buildAnalyzeSystemPrompt({
      disabledTools: ['proposeDirections', 'proposeRecordCorrections', 'proposeNewRecords'],
    })
    expect(noOptionalTools).toContain('2. Scan the new prose')
    expect(noOptionalTools).toContain('3. Finally, call **finishAnalysis**')
    expect(noOptionalTools).not.toContain('proposeDirections')
    expect(noOptionalTools).not.toContain('proposeRecordCorrections')
    expect(noOptionalTools).not.toContain('proposeNewRecords')

    const noFinishTool = buildAnalyzeSystemPrompt({
      disabledTools: ['proposeDirections', 'proposeRecordCorrections', 'proposeNewRecords', 'finishAnalysis'],
    })
    expect(noFinishTool).toContain('2. Finally, scan the new prose')
    expect(noFinishTool).not.toContain('finishAnalysis')
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

    const custom = blocks.find(b => b.id === 'fragment-catalog')
    expect(custom).toBeDefined()
    expect(custom!.content).toContain('## Fragment Catalog')
    expect(custom!.content).toContain('### Locations')
    expect(custom!.content).toContain('loc-0001')
    expect(custom!.content).toContain('A market below the city')
  })
})

describe('Librarian Optimize Character Blocks', () => {
  it('uses the generic readFragments tool in instructions', () => {
    const def = agentBlockRegistry.get('librarian.optimize-character')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    const instructions = blocks.find(b => b.id === 'instructions')!
    expect(instructions.content).toContain('complete target character snapshot')
    expect(instructions.content).not.toContain('getCharacter')
  })

  it('uses aggregate pinned support catalog and one all-character summary index', () => {
    const def = agentBlockRegistry.get('librarian.optimize-character')!
    const guideline = makeFragment({ id: 'gl-pin01', type: 'guideline', name: 'Tone', description: 'Pinned tone', sticky: true })
    const knowledge = makeFragment({ id: 'kn-pin01', type: 'knowledge', name: 'Accord', description: 'Pinned lore', sticky: true })
    const pinned = makeFragment({ id: 'ch-pin01', name: 'Mentor', description: 'Pinned mentor', sticky: true })
    const other = makeFragment({ id: 'ch-oth01', name: 'Rival', description: 'Other character' })
    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyGuidelines: [guideline],
      stickyKnowledge: [knowledge],
      stickyCharacters: [pinned],
      allCharacters: [pinned, other],
      targetFragment: pinned,
    }))

    expect(blocks.find(b => b.id === 'guideline-pinned-summary-index')).toBeUndefined()
    expect(blocks.find(b => b.id === 'knowledge-pinned-summary-index')).toBeUndefined()
    expect(blocks.find(b => b.id === 'character-pinned-summary-index')).toBeUndefined()

    const pinnedCatalog = blocks.find(b => b.id === 'fragment-pinned-catalog')
    expect(pinnedCatalog).toBeDefined()
    expect(pinnedCatalog!.content).toContain('## Pinned Fragment Catalog')
    expect(pinnedCatalog!.content).toContain('### Guidelines')
    expect(pinnedCatalog!.content).toContain('`gl-pin01` | Tone | Pinned tone')
    expect(pinnedCatalog!.content).toContain('### Knowledge')
    expect(pinnedCatalog!.content).toContain('`kn-pin01` | Accord | Pinned lore')
    expect(pinnedCatalog!.content).not.toContain('ch-pin01')

    const allCharacters = blocks.find(b => b.id === 'character-catalog')
    expect(allCharacters).toBeDefined()
    expect(allCharacters!.content).toContain('## All Characters Catalog')
    expect(allCharacters!.content).toContain('ch-pin01')
    expect(allCharacters!.content).toContain('ch-oth01')
  })

  it('includes the target character\'s folded continuity even when they are not active', () => {
    const target = makeFragment({ id: 'ch-target', type: 'character', name: 'Mara' })
    const blocks = agentBlockRegistry.get('librarian.optimize-character')!.createDefaultBlocks(makeBaseContext({
      targetFragment: target,
      continuityView: makeContinuityView({
        characterKnowledge: [makeCharacterKnowledge({
          characterId: target.id,
          fact: 'Mara knows the gate is watched.',
        })],
      }),
    }))
    const continuity = blocks.find((block) => block.id === 'continuity-observations')!
    expect(continuity.content).toContain('Mara knows or believes:')
    expect(continuity.content).toContain('Mara knows the gate is watched.')
    expect(continuity.content).toContain('Respect it as evidence while editing')
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
    expect(op.content).toContain('## Operation\n\nrewrite\n\n### Guidance\n\nMake it more dramatic')
    expect(op.content).toContain('## Operation')
    expect(op.content).toContain('rewrite')
    expect(op.content).toContain('### Guidance')
    expect(op.content).toContain('Make it more dramatic')

    const source = blocks.find(b => b.id === 'source')!
    expect(source.content).toContain('## Source Prose\n\n### Current Source\n\nFull paragraph with the hero walking.')
    expect(source.content).toContain('## Source Prose')
    expect(source.content).toContain('### Current Source')
    expect(source.content).toContain('Full paragraph with the hero walking.')

    const sel = blocks.find(b => b.id === 'selection')!
    expect(sel.content).toContain('## Selected Span\n\n### Text to Transform\n\nThe hero walked.')
    expect(sel.content).toContain('## Selected Span')
    expect(sel.content).toContain('### Text to Transform')
    expect(sel.content).toContain('The hero walked.')
    expect(sel.content).toContain('### Context Before')
    expect(sel.content).toContain('Before text')
    expect(sel.content).toContain('### Context After')
    expect(sel.content).toContain('After text')
    expect(sel.content).not.toMatch(/\n{3,}/)
  })
})

describe('Directions Blocks', () => {
  it('uses pinned and recent knowledge in full without broad catalog rows', () => {
    const def = agentBlockRegistry.get('directions.suggest')!
    const stickyKnowledge = makeFragment({ id: 'kn-magic', type: 'knowledge', name: 'Magic System', content: 'Sticky lore', sticky: true })
    const recentKnowledge = makeFragment({ id: 'kn-sword', type: 'knowledge', name: 'Sword', content: 'Recent lore\n', sticky: false })

    const blocks = def.createDefaultBlocks(makeBaseContext({
      stickyKnowledge: [stickyKnowledge],
      recentKnowledge: [recentKnowledge],
    }))

    const pinnedBlock = blocks.find(b => b.id === 'fragment-pinned')
    expect(pinnedBlock).toBeDefined()
    expect(pinnedBlock!.content).toContain('## Pinned Fragments')
    expect(pinnedBlock!.content).toContain('### Knowledge')
    expect(pinnedBlock!.content).toContain('Magic System')
    expect(pinnedBlock!.content).toContain('Sticky lore')

    const recent = blocks.find(b => b.id === 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('## Recent Fragments')
    expect(recent!.content).toContain('Sword')
    expect(recent!.content).toContain('Recent lore')

    expect(blocks.find(b => b.id === 'knowledge-shortlist')).toBeUndefined()
    expect(blocks.find(b => b.id === 'knowledge-sticky')).toBeUndefined()
    expect(blocks.find(b => b.id === 'knowledge-recent')).toBeUndefined()
  })

  // A direction may reintroduce material the recent window dropped, so the rest
  // of the story has to be nameable — by name only, since Directions runs with
  // no tools and cannot open anything it is shown a row for.
  it('names the rest of the story in a catalog it is told it cannot open', () => {
    const def = agentBlockRegistry.get('directions.suggest')!
    const stickyLocation = makeFragment({ id: 'loc-sticky', type: 'location', name: 'Library', description: 'Pinned place', content: 'Pinned place lore', sticky: true })
    const recentLocation = makeFragment({ id: 'loc-recent', type: 'location', name: 'Market', description: 'Recent place', content: 'Recent place lore', sticky: false })
    const catalogLocation = makeFragment({ id: 'loc-short', type: 'location', name: 'Bridge', description: 'Optional place', content: 'Catalog row full lore', sticky: false })

    // Declared empty at registration, which is what makes both real paths — the
    // runtime toolset and the preview fallback — resolve to no tools. The
    // enabledTools below is that fact, not a convenient fiction.
    expect(def.availableTools).toEqual([])

    const blocks = def.createDefaultBlocks(makeBaseContext({
      enabledTools: [],
      stickyCustomFragments: [stickyLocation],
      recentCustomFragments: [{ type: 'location', name: 'Locations', fragments: [recentLocation] }],
      customFragmentCatalogs: [{ type: 'location', name: 'Locations', fragments: [catalogLocation] }],
    }))

    const pinnedBlock = blocks.find(b => b.id === 'fragment-pinned')
    expect(pinnedBlock).toBeDefined()
    expect(pinnedBlock!.content).toContain('### Locations')
    expect(pinnedBlock!.content).toContain('Pinned place lore')

    const recent = blocks.find(b => b.id === 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('### Locations')
    expect(recent!.content).toContain('Recent place lore')

    const catalog = blocks.find(b => b.id === 'fragment-catalog')
    expect(catalog).toBeDefined()
    expect(catalog!.content).toContain('## Also In This Story')
    expect(catalog!.content).toContain('loc-short')
    expect(catalog!.content).toContain('Optional place')
    // Names, not bodies: the catalog is a reach, not a second full-context lane.
    expect(catalog!.content).not.toContain('Catalog row full lore')
    // A toolless agent told to call readFragments either fabricates or stalls.
    expect(catalog!.content).not.toContain('readFragments')
    expect(catalog!.content).toContain('You cannot open these rows')
    // Fragments already presented in full are not repeated as rows.
    expect(catalog!.content).not.toContain('loc-recent')
    expect(catalog!.content).not.toContain('loc-sticky')

    expect(blocks.find(b => b.id === 'custom-sticky')).toBeUndefined()
    expect(blocks.find(b => b.id === 'location-recent')).toBeUndefined()
  })

  // The Writer must not drag a dormant thread into the present scene, so its
  // render drops them. Directions is the opposite case: a question the story
  // raised and let go is its richest source of a next move.
  it('offers dormant threads as candidates where the writer is not shown them', () => {
    const dormantView = makeContinuityView({
      currentState: [],
      characterKnowledge: [],
      liveThreads: [makeLiveThread({
        threadKey: 'who_sent_the_letter',
        label: 'Who sent the letter',
        visibility: 'dormant',
      })],
    })

    const directions = agentBlockRegistry.get('directions.suggest')!
      .createDefaultBlocks(makeBaseContext({ continuityView: dormantView }))
      .find((b) => b.id === 'continuity-observations')
    expect(directions!.content).toContain('Who sent the letter')
    expect(directions!.content).toContain('deliberately picking one up is a legitimate direction')

    const writer = agentBlockRegistry.get('generation.writer')!
      .createDefaultBlocks(makeBaseContext({ continuityView: dormantView }))
      .find((b) => b.id === 'continuity-observations')
    expect(writer!.content).not.toContain('Who sent the letter')
  })

  // Directions set macro trajectory against the same passages the Writer will
  // continue from. A window of its own means proposing from a shorter story.
  it('reads the author-configured prose window, not a window of its own', () => {
    const prose = Array.from({ length: 5 }, (_, i) => makeFragment({
      id: `pr-000${i + 1}`,
      type: 'prose',
      name: `Passage ${i + 1}`,
      content: `Passage ${i + 1} body`,
      order: i + 1,
    }))
    const blocks = agentBlockRegistry.get('directions.suggest')!
      .createDefaultBlocks(makeBaseContext({ proseFragments: prose }))
    const window = blocks.find((b) => b.id === 'prose-recent')!
    for (const fragment of prose) {
      expect(window.content, fragment.id).toContain(`${fragment.name} body`)
    }
  })
})

describe('Writer Blocks', () => {
  it('separates omniscient reference context from character knowledge', () => {
    const def = agentBlockRegistry.get('generation.writer')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    const instructions = blocks.find((block) => block.id === 'instructions')
    expect(instructions?.content).toContain('not knowledge automatically possessed by characters')
    expect(instructions?.content).toContain('Character awareness boundaries')
  })

  it('includes recent full blocks and one catalog for built-in and custom fragments when provided', () => {
    const def = agentBlockRegistry.get('generation.writer')!
    const recentKnowledge = makeFragment({ id: 'kn-sword', type: 'knowledge', name: 'Sword', content: 'Recent lore', sticky: false })
    const knowledgeCatalog = [makeFragment({ id: 'kn-shield', type: 'knowledge', name: 'Shield', content: 'Catalog row lore', sticky: false })]
    const recentLocation = makeFragment({ id: 'loc-market', type: 'location', name: 'Market', description: 'Recent place', content: 'Recent place lore\n\n', sticky: false })
    const catalogLocation = makeFragment({ id: 'loc-bridge', type: 'location', name: 'Bridge', description: 'Optional place', content: 'Catalog row full lore', sticky: false })

    const blocks = def.createDefaultBlocks(makeBaseContext({
      recentKnowledge: [recentKnowledge],
      knowledgeCatalog: knowledgeCatalog,
      recentCustomFragments: [{ type: 'location', name: 'Locations', fragments: [recentLocation] }],
      customFragmentCatalogs: [{ type: 'location', name: 'Locations', fragments: [catalogLocation] }],
    }))

    const recent = blocks.find(b => b.id === 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('## Recent Fragments')
    expect(recent!.content).toContain('### Knowledge')
    expect(recent!.content).toContain('Recent lore')

    const catalog = blocks.find(b => b.id === 'fragment-catalog')
    expect(catalog).toBeDefined()
    expect(catalog!.content).toContain('## Fragment Catalog')
    expect(catalog!.content).toContain('### Knowledge')
    expect(catalog!.content).toContain('Shield')

    expect(recent!.content).toContain('### Locations')
    expect(recent!.content).toContain('Recent place lore')
    expect(recent!.content).not.toMatch(/\n{3,}/)
    expect(recent!.fragmentContext).toEqual({
      mode: 'full',
      scope: 'recent',
      fragmentType: 'mixed',
      fragmentIds: ['kn-sword', 'loc-market'],
    })

    expect(catalog!.content).toContain('### Locations')
    expect(catalog!.content).toContain('loc-bridge')
    expect(catalog!.content).toContain('Optional place')
    expect(catalog!.content).not.toContain('Catalog row full lore')
    expect(catalog!.fragmentContext).toEqual({
      mode: 'summary-index',
      scope: 'catalog',
      fragmentType: 'mixed',
      fragmentIds: ['kn-shield', 'loc-bridge'],
    })
  })
})

describe('Character Chat Blocks', () => {
  it('does not preload authorial story context without a character', () => {
    const def = agentBlockRegistry.get('character-chat.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext())
    expect(blocks.map((block) => block.id)).toEqual(['instructions'])
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
    expect(charBlock!.content).toContain('## Character')
    expect(charBlock!.content).toContain('### Character')
    expect(charBlock!.content).toContain('#### `ch-hero01` | Hero | Main protagonist')
    expect(charBlock!.content).toContain('A brave hero.')
    expect(charBlock!.content).not.toContain('## Character Details')
    expect(charBlock!.content).not.toContain('## Character Description')
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

  it('does not expose global prose summaries to the character', () => {
    const def = agentBlockRegistry.get('character-chat.chat')!
    const blocks = def.createDefaultBlocks(makeBaseContext({
      proseFragments: [makeFragment({
        id: 'pr-test01',
        type: 'prose',
        name: 'Ch 1',
        content: 'Short prose.',
      })],
    }))
    expect(blocks.some((block) => block.content.includes('Hero arrives at village'))).toBe(false)
  })

  it('does not expose pinned authorial memory to the character', () => {
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
    expect(blocks.some((block) => block.content.includes('Magic System'))).toBe(false)
  })

  it('shows the active character only in its full sheet', () => {
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

    expect(blocks.filter((block) => block.content.includes('ch-hero01'))).toHaveLength(1)
    expect(blocks.find(b => b.id === 'fragment-pinned-catalog')).toBeUndefined()
  })

  // The fold already knows what each character learned and how, and character
  // chat was building that view and throwing it away — so the character answered
  // from the story summary sitting in the same prompt.
  describe('awareness boundary', () => {
    const hero = makeFragment({ id: 'ch-hero01', type: 'character', name: 'Hero', content: 'A brave hero.' })
    const knowledgeView = makeContinuityView({
      characterKnowledge: [
        makeCharacterKnowledge({
          characterId: 'ch-hero01',
          knowledgeKey: 'key_missing',
          fact: 'The key is missing.',
        }),
        makeCharacterKnowledge({
          characterId: 'ch-other1',
          knowledgeKey: 'hero_lied',
          fact: 'The hero lied about the key.',
          acquisition: 'told',
        }),
      ],
    })

    it('tells the character what it knows and what is only the author\'s to know', () => {
      const blocks = agentBlockRegistry.get('character-chat.chat')!
        .createDefaultBlocks(makeBaseContext({ character: hero, continuityView: knowledgeView }))
      const awareness = blocks.find(b => b.id === 'character-awareness')!
      expect(awareness).toBeDefined()
      expect(awareness.content).toContain('The key is missing. (witnessed)')
      // Another character's knowledge is not this one's.
      expect(awareness.content).not.toContain('The hero lied')
      // Durable state and open threads are authorial records; a character given
      // them starts acting on offstage facts.
      expect(awareness.content).not.toContain('north tower')
      expect(awareness.content).not.toContain('Who sent the letter')
      // The boundary has to be stated, not implied by omission.
      expect(awareness.content).toContain('you have not learned it')
    })

    it('still draws the boundary for a character the fold recorded nothing for', () => {
      const blocks = agentBlockRegistry.get('character-chat.chat')!
        .createDefaultBlocks(makeBaseContext({
          character: makeFragment({ id: 'ch-newcomer', type: 'character', name: 'Newcomer' }),
          continuityView: knowledgeView,
        }))
      const awareness = blocks.find(b => b.id === 'character-awareness')!
      expect(awareness.content).toContain('you have not learned it')
      expect(awareness.content).toContain('nothing beyond your character sheet')
      expect(awareness.content).not.toContain('The key is missing')
    })

    it('omits the block with no character but keeps the boundary before anything is folded', () => {
      const noCharacter = agentBlockRegistry.get('character-chat.chat')!
        .createDefaultBlocks(makeBaseContext({ continuityView: knowledgeView }))
      expect(noCharacter.some(b => b.id === 'character-awareness')).toBe(false)

      const noView = agentBlockRegistry.get('character-chat.chat')!
        .createDefaultBlocks(makeBaseContext({ character: hero }))
      const awareness = noView.find(b => b.id === 'character-awareness')!
      expect(awareness.content).toContain('you have not learned it')
      expect(awareness.content).toContain('nothing beyond your character sheet')
    })

    it('comes after the character and persona it qualifies', () => {
      const blocks = agentBlockRegistry.get('character-chat.chat')!
        .createDefaultBlocks(makeBaseContext({ character: hero, continuityView: knowledgeView }))
      const awareness = blocks.find(b => b.id === 'character-awareness')!
      for (const id of ['character', 'persona']) {
        const earlier = blocks.find(b => b.id === id)
        if (earlier) expect(awareness.order, id).toBeGreaterThan(earlier.order)
      }
    })
  })
})
