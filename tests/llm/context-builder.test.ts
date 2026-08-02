import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { ensureCoreAgentsRegistered } from '@/server/agents/register-core'
import { createTempDir, makeTestSettings } from '../setup'
import {
  createStory,
  createFragment,
  getFragment,
} from '@/server/fragments/storage'
import { addProseSection } from '@/server/fragments/prose-chain'
import type { StoryMeta, Fragment } from '@/server/fragments/schema'
import { saveAnalysis } from '@/server/librarian/storage'
import { analysisSourceRevision } from '@/server/librarian/continuity-source'
import { SUMMARY_CONTRACT_VERSION } from '@/server/librarian/summary-projection'
import {
  buildContext,
  buildContextState,
  assembleMessages,
  canReadFragments,
  fragmentCatalogContent,
  createDefaultBlocks,
  compileBlocks,
  addCacheBreakpoints,
  findBlock,
  replaceBlockContent,
  removeBlock,
  insertBlockBefore,
  insertBlockAfter,
  reorderBlock,
  type ContextBlock,
  type ContextMessage,
} from '@/server/llm/context-builder'

function makeStory(overrides: Partial<StoryMeta> = {}): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
    ...overrides,
  }
}

function makeFragment(overrides: Partial<Fragment>): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'pr-0001',
    type: 'prose',
    name: 'Opening',
    description: 'The opening scene',
    content: 'Once upon a time...',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user' as const,
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    ...overrides,
  }
}

describe('context-builder', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeAll(() => {
    ensureCoreAgentsRegistered()
  })

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('builds context with user message containing story info', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const messages = await buildContext(dataDir, story.id, 'Continue the story')
    const msg = messages.find((m) => m.role === 'user')

    expect(msg).toBeDefined()
    expect(msg!.content).toContain('Test Story')
    expect(msg!.content).toContain('A test story')
  })

  it('includes recent prose fragments in context', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const prose1 = makeFragment({
      id: 'pr-0001',
      type: 'prose',
      name: 'Chapter 1',
      content: 'The adventure begins here.',
      order: 1,
    })
    const prose2 = makeFragment({
      id: 'pr-0002',
      type: 'prose',
      name: 'Chapter 2',
      content: 'The hero meets a friend.',
      order: 2,
    })
    await createFragment(dataDir, story.id, prose1)
    await createFragment(dataDir, story.id, prose2)

    const messages = await buildContext(dataDir, story.id, 'What happens next?')
    const msg = messages.find((m) => m.role === 'user')

    expect(msg!.content).toContain('The adventure begins here.')
    expect(msg!.content).toContain('The hero meets a friend.')
  })

  it('includes sticky guidelines in full', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const guideline = makeFragment({
      id: 'gl-0001',
      type: 'guideline',
      name: 'Tone',
      description: 'Writing tone rules',
      content: 'Write in a dark, gothic style.',
      sticky: true,
    })
    await createFragment(dataDir, story.id, guideline)

    const messages = await buildContext(dataDir, story.id, 'Continue')
    const msg = messages.find((m) => m.role === 'user')

    expect(msg!.content).toContain('Write in a dark, gothic style.')
  })

  it('includes sticky knowledge in full', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const knowledge = makeFragment({
      id: 'kn-0001',
      type: 'knowledge',
      name: 'Magic System',
      description: 'How magic works',
      content: 'Magic requires blood sacrifice.',
      sticky: true,
    })
    await createFragment(dataDir, story.id, knowledge)

    const messages = await buildContext(dataDir, story.id, 'Continue')
    const msg = messages.find((m) => m.role === 'user')

    expect(msg!.content).toContain('Magic requires blood sacrifice.')
  })

  it('includes non-sticky guidelines as catalog rows only', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const guideline = makeFragment({
      id: 'gl-0002',
      type: 'guideline',
      name: 'POV Rules',
      description: 'Point of view constraints',
      content: 'Always use third person limited.',
      sticky: false,
    })
    await createFragment(dataDir, story.id, guideline)

    const messages = await buildContext(dataDir, story.id, 'Continue')
    const msg = messages.find((m) => m.role === 'user')

    // Catalog should contain id and description but not full content
    expect(msg!.content).toContain('gl-0002')
    expect(msg!.content).toContain('Point of view constraints')
    expect(msg!.content).not.toContain('Always use third person limited.')
  })

  it('includes the author input as the user message', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const messages = await buildContext(dataDir, story.id, 'Make the dragon attack!')
    const user = messages.find((m) => m.role === 'user')

    expect(user).toBeDefined()
    expect(user!.content).toContain('Make the dragon attack!')
  })

  it('orders prose by order field then createdAt', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const prose1 = makeFragment({
      id: 'pr-0001',
      type: 'prose',
      name: 'Second',
      content: 'Second fragment.',
      order: 2,
      createdAt: '2025-01-01T00:00:00.000Z',
    })
    const prose2 = makeFragment({
      id: 'pr-0002',
      type: 'prose',
      name: 'First',
      content: 'First fragment.',
      order: 1,
      createdAt: '2025-01-02T00:00:00.000Z',
    })
    await createFragment(dataDir, story.id, prose1)
    await createFragment(dataDir, story.id, prose2)

    const messages = await buildContext(dataDir, story.id, 'Continue')
    const content = messages.find((m) => m.role === 'user')!.content as string

    const firstIdx = content.indexOf('First fragment.')
    const secondIdx = content.indexOf('Second fragment.')
    expect(firstIdx).toBeLessThan(secondIdx)
  })

  it('limits prose fragments to last N (default 10)', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    // Create 15 prose fragments
    for (let i = 0; i < 15; i++) {
      await createFragment(dataDir, story.id, makeFragment({
        id: `pr-${String(i).padStart(4, '0')}`,
        type: 'prose',
        name: `Prose ${i}`,
        content: `Content of prose ${i}`,
        order: i,
      }))
    }

    const messages = await buildContext(dataDir, story.id, 'Continue')
    const content = messages.find((m) => m.role === 'user')!.content as string

    // Should include the last 10 (5-14) but not the first 5 (0-4)
    expect(content).not.toContain('Content of prose 0')
    expect(content).not.toContain('Content of prose 4')
    expect(content).toContain('Content of prose 5')
    expect(content).toContain('Content of prose 14')
  })

  it('returns ContextBuildState with correct structure', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const guideline = makeFragment({
      id: 'gl-0001',
      type: 'guideline',
      name: 'Tone',
      description: 'Writing tone',
      content: 'Dark tone.',
      sticky: true,
    })
    const knowledge = makeFragment({
      id: 'kn-0001',
      type: 'knowledge',
      name: 'Lore',
      description: 'World lore',
      content: 'Ancient dragons.',
      sticky: true,
    })
    await createFragment(dataDir, story.id, guideline)
    await createFragment(dataDir, story.id, knowledge)

    const messages = await buildContext(dataDir, story.id, 'Continue')

    // Should have a system message and a user message
    expect(messages.length).toBe(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
  })

  it('includes sticky characters in full', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const character = makeFragment({
      id: 'ch-0001',
      type: 'character',
      name: 'Elena',
      description: 'The protagonist',
      content: 'Elena is a fierce warrior with red hair.',
      sticky: true,
    })
    await createFragment(dataDir, story.id, character)

    const messages = await buildContext(dataDir, story.id, 'Continue')
    const msg = messages.find((m) => m.role === 'user')

    expect(msg!.content).toContain('Elena is a fierce warrior with red hair.')
    expect(msg!.content).toContain('## User Fragments')
    expect(msg!.content).toContain('### Characters')
    expect(msg!.content).toContain('#### Elena')
  })

  it('includes non-sticky characters as catalog rows only', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const character = makeFragment({
      id: 'ch-0002',
      type: 'character',
      name: 'Villain',
      description: 'The antagonist',
      content: 'The dark lord rules with an iron fist.',
      sticky: false,
    })
    await createFragment(dataDir, story.id, character)

    const messages = await buildContext(dataDir, story.id, 'Continue')
    const msg = messages.find((m) => m.role === 'user')

    // Catalog should contain id and description but not full content
    expect(msg!.content).toContain('ch-0002')
    expect(msg!.content).toContain('The antagonist')
    expect(msg!.content).not.toContain('The dark lord rules with an iron fist.')
  })

  it('carries non-sticky characters mentioned in recent prose as full sheets, not catalog rows', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const character = makeFragment({
      id: 'ch-0002',
      type: 'character',
      name: 'Villain',
      description: 'The antagonist',
      content: 'The dark lord rules with an iron fist.',
      sticky: false,
    })
    await createFragment(dataDir, story.id, character)

    // Prose the librarian annotated as mentioning the villain.
    const prose = makeFragment({
      id: 'pr-0002',
      type: 'prose',
      name: 'Ch1',
      content: 'They marched on the keep.',
      order: 1,
      meta: { annotations: [{ type: 'mention', fragmentId: 'ch-0002', text: 'dark lord' }] },
    })
    await createFragment(dataDir, story.id, prose)

    const state = await buildContextState(dataDir, story.id, 'Continue')
    expect((state.recentCharacters ?? []).map((c) => c.id)).toContain('ch-0002')
    expect(state.characterCatalog.map((c) => c.id)).not.toContain('ch-0002')

    const blocks = createDefaultBlocks(state)
    const recent = findBlock(blocks, 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('## Recent Fragments')
    expect(recent!.content).toContain('### Characters')
    expect(recent!.content).toContain('The dark lord rules with an iron fist.')
  })

  it('uses an explicit receipt read as a one-turn bridge before librarian annotations exist', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const character = makeFragment({
      id: 'ch-0003',
      type: 'character',
      name: 'Scout',
      description: 'A cautious scout',
      content: 'The scout hides a silver compass.',
      sticky: false,
    })
    await createFragment(dataDir, story.id, character)

    const prose = makeFragment({
      id: 'pr-0003',
      type: 'prose',
      name: 'Ch1',
      content: 'The path narrowed under the old trees.',
      order: 1,
      meta: {
        contextReceipt: {
          version: 1,
          entries: [{ fragmentId: 'ch-0003', access: 'read', actor: 'writer', reason: 'explicit-read' }],
        },
      },
    })
    await createFragment(dataDir, story.id, prose)

    const state = await buildContextState(dataDir, story.id, 'Continue')
    expect((state.recentCharacters ?? []).map((c) => c.id)).toContain('ch-0003')
    expect(state.characterCatalog.map((c) => c.id)).not.toContain('ch-0003')

    const blocks = createDefaultBlocks(state)
    const recent = findBlock(blocks, 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('### Characters')
    expect(recent!.content).toContain('The scout hides a silver compass.')
  })

  it('does not let inherited full context renew itself through a receipt', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const character = makeFragment({
      id: 'ch-0003',
      type: 'character',
      name: 'Scout',
      description: 'A cautious scout',
      content: 'The scout hides a silver compass.',
      sticky: false,
    })
    await createFragment(dataDir, story.id, character)

    await createFragment(dataDir, story.id, makeFragment({
      id: 'pr-0002',
      type: 'prose',
      name: 'Earlier',
      content: 'The scout checked the path.',
      order: 1,
      meta: {
        contextReceipt: {
          version: 1,
          entries: [{
            fragmentId: 'ch-0003',
            access: 'read',
            actor: 'writer',
            reason: 'explicit-read',
          }],
        },
      },
    }))
    await createFragment(dataDir, story.id, makeFragment({
      id: 'pr-0003',
      type: 'prose',
      name: 'Latest',
      content: 'The road continued north.',
      order: 2,
      meta: {
        contextReceipt: {
          version: 1,
          entries: [{
            fragmentId: 'ch-0003',
            access: 'full',
            actor: 'writer',
            reason: 'recent-context',
          }],
        },
      },
    }))

    const state = await buildContextState(dataDir, story.id, 'Continue')
    expect((state.recentCharacters ?? []).map((c) => c.id)).not.toContain('ch-0003')
    expect(state.characterCatalog.map((c) => c.id)).toContain('ch-0003')
  })

  it('promotes recently mentioned non-sticky knowledge to recentKnowledge and formats it', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const knowledge = makeFragment({
      id: 'kn-0002',
      type: 'knowledge',
      name: 'Necronomicon',
      description: 'Ancient spellbook',
      content: 'Contains dark forbidden spells.',
      sticky: false,
    })
    await createFragment(dataDir, story.id, knowledge)

    // Prose the librarian annotated as mentioning the knowledge.
    const prose = makeFragment({
      id: 'pr-0002',
      type: 'prose',
      name: 'Ch1',
      content: 'They found the book.',
      order: 1,
      meta: { annotations: [{ type: 'mention', fragmentId: 'kn-0002', text: 'spellbook' }] },
    })
    await createFragment(dataDir, story.id, prose)

    const state = await buildContextState(dataDir, story.id, 'Continue')
    expect((state.recentKnowledge ?? []).map((k) => k.id)).toContain('kn-0002')
    expect(state.knowledgeCatalog.map((k) => k.id)).not.toContain('kn-0002')

    const blocks = createDefaultBlocks(state)
    const recent = findBlock(blocks, 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('### Knowledge')
    expect(recent!.content).toContain('Contains dark forbidden spells.')
  })

  it('injects story custom fragment types as sticky, recent, and catalog context', async () => {
    const story = makeStory({
      settings: {
        ...makeTestSettings(),
        customFragmentTypes: [
          {
            type: 'location',
            name: 'Locations',
            description: 'Places in the story',
            icon: 'MapPin',
            showInSidebar: true,
          },
        ],
      },
    })
    await createStory(dataDir, story)

    await createFragment(dataDir, story.id, makeFragment({
      id: 'loc-0001',
      type: 'location',
      name: 'Crystal Library',
      description: 'A bright archive',
      content: 'Every shelf hums with captured starlight.',
      sticky: true,
    }))
    await createFragment(dataDir, story.id, makeFragment({
      id: 'loc-0002',
      type: 'location',
      name: 'Forgotten Bridge',
      description: 'A dangerous crossing',
      content: 'The bridge stones remember every betrayal.',
      sticky: false,
    }))
    await createFragment(dataDir, story.id, makeFragment({
      id: 'loc-0003',
      type: 'location',
      name: 'Ash Market',
      description: 'A market below the city',
      content: 'The Ash Market trades in debts and sealed names.',
      sticky: false,
    }))
    await createFragment(dataDir, story.id, makeFragment({
      id: 'pr-0002',
      type: 'prose',
      name: 'Ch1',
      content: 'They descended below the city.',
      order: 1,
      meta: { annotations: [{ type: 'mention', fragmentId: 'loc-0003', text: 'market' }] },
    }))

    const state = await buildContextState(dataDir, story.id, 'Continue')
    expect((state.stickyCustomFragments ?? []).map((f) => f.id)).toContain('loc-0001')

    const recentLocations = (state.recentCustomFragments ?? []).find((group) => group.type === 'location')
    expect(recentLocations?.fragments.map((f) => f.id)).toEqual(['loc-0003'])

    const catalogLocations = (state.customFragmentCatalogs ?? []).find((group) => group.type === 'location')
    expect(catalogLocations?.fragments.map((f) => f.id)).toEqual(['loc-0002'])

    const blocks = createDefaultBlocks(state)
    const sticky = findBlock(blocks, 'user-fragments')
    expect(sticky).toBeDefined()
    expect(sticky!.content).toContain('## User Fragments')
    expect(sticky!.content).toContain('### Locations')
    expect(sticky!.content).toContain('#### Crystal Library')
    expect(sticky!.content).toContain('Every shelf hums with captured starlight.')

    const recent = findBlock(blocks, 'fragment-recent')
    expect(recent).toBeDefined()
    expect(recent!.content).toContain('### Locations')
    expect(recent!.content).toContain('The Ash Market trades in debts and sealed names.')

    const catalog = findBlock(blocks, 'fragment-catalog')
    expect(catalog).toBeDefined()
    expect(catalog!.content).toContain('## Fragment Catalog')
    expect(catalog!.content).toContain('one-line catalog row, not the full fragment')
    expect(catalog!.content).toContain('### Locations')
    expect(catalog!.content).toContain('loc-0002')
    expect(catalog!.content).toContain('A dangerous crossing')
    expect(catalog!.content).not.toContain('The bridge stones remember every betrayal.')
    expect(catalog!.fragmentContext).toEqual({
      mode: 'summary-index',
      scope: 'catalog',
      fragmentType: 'mixed',
      fragmentIds: ['loc-0002'],
    })
  })

  it('carries tool usage policy without enumerating a tool catalog', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const messages = await buildContext(dataDir, story.id, 'Continue')
    const sysMsg = messages.find((m) => m.role === 'system')!

    // Tool names/descriptions are delivered via the SDK schema, so the system
    // message holds only usage policy — never a catalog that could drift from
    // the agent's actually-enabled tools.
    expect(sysMsg.content).not.toContain('getCharacter')
    expect(sysMsg.content).not.toContain('listCharacters')
    expect(sysMsg.content).not.toContain('listFragmentTypes')
    expect(sysMsg.content).toContain('retrieve the full details')
    expect(sysMsg.content).toContain('fiction writer')
  })

  it('includes only prose before target fragment when proseBeforeFragmentId is set', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const proseIds = ['pr-0001', 'pr-0002', 'pr-0003', 'pr-0004', 'pr-0005']
    const proseContents = ['A passage', 'B passage', 'C passage', 'D passage', 'E passage']

    for (let i = 0; i < proseIds.length; i++) {
      const fragment = makeFragment({
        id: proseIds[i],
        type: 'prose',
        name: `Prose ${i + 1}`,
        content: proseContents[i],
        order: i + 1,
      })
      await createFragment(dataDir, story.id, fragment)
      await addProseSection(dataDir, story.id, fragment.id)
    }

    const state = await buildContextState(dataDir, story.id, 'Regenerate C', {
      excludeFragmentId: 'pr-0003',
      proseBeforeFragmentId: 'pr-0003',
    })

    const included = state.proseFragments.map(f => f.id)
    expect(included).toEqual(['pr-0001', 'pr-0002'])
  })

  it('omits story summary when excludeStorySummary is true', async () => {
    const story = makeStory()
    await createStory(dataDir, story)
    await createFragment(dataDir, story.id, makeFragment({
      id: 'sm-authored',
      type: 'summary',
      name: 'Author overview',
      content: 'Late events that should not leak into regenerate context.',
    }))

    const messages = await buildContext(dataDir, story.id, 'Regenerate this section', {
      excludeStorySummary: true,
    })
    const user = messages.find((m) => m.role === 'user')!

    expect(user.content).not.toContain('## Story Summary So Far')
    expect(user.content).not.toContain('Late events that should not leak into regenerate context.')
  })

  it('renders source-current analysis memory before the recent prose window', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const proseIds = ['pr-0001', 'pr-0002', 'pr-0003', 'pr-0004']
    for (let i = 0; i < proseIds.length; i++) {
      const fragment = makeFragment({
        id: proseIds[i],
        type: 'prose',
        name: `Prose ${i + 1}`,
        content: `Passage ${i + 1}`,
        order: i + 1,
      })
      await createFragment(dataDir, story.id, fragment)
      await addProseSection(dataDir, story.id, fragment.id)
    }

    const first = await getFragment(dataDir, story.id, 'pr-0001')
    await saveAnalysis(dataDir, story.id, {
      id: 'la-first',
      createdAt: new Date().toISOString(),
      fragmentId: 'pr-0001',
      sourceRevision: analysisSourceRevision(first!),
      summaryUpdate: 'By then, Summary A had happened.',
      summaryContractVersion: SUMMARY_CONTRACT_VERSION,
      mentions: [], contradictions: [], fragmentChangeProposals: [], timelineEvents: [],
    })

    const messages = await buildContext(dataDir, story.id, 'Regenerate C', {
      proseBeforeFragmentId: 'pr-0003',
      excludeFragmentId: 'pr-0003',
      contextCompact: { type: 'proseLimit', value: 1 },
    })
    const joined = messages.map(m => m.content).join('\n')

    expect(joined).toContain('By then, Summary A had happened.')
    expect(joined).toContain('## End of Story Summary')
    expect(joined).not.toContain('Passage 3')
  })

  it('excludes unscoped authored summaries from target-relative context', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const proseIds = ['pr-0001', 'pr-0002', 'pr-0003']
    for (let i = 0; i < proseIds.length; i++) {
      const fragment = makeFragment({
        id: proseIds[i],
        type: 'prose',
        name: `Prose ${i + 1}`,
        content: `Passage ${i + 1}`,
        order: i + 1,
      })
      await createFragment(dataDir, story.id, fragment)
      await addProseSection(dataDir, story.id, fragment.id)
    }

    await createFragment(dataDir, story.id, makeFragment({
      id: 'sm-era001',
      type: 'summary',
      name: 'Opening era',
      content: 'Old arc summary.',
      placement: 'system',
      meta: {},
    }))

    const messages = await buildContext(dataDir, story.id, 'Regenerate C', {
      proseBeforeFragmentId: 'pr-0003',
      excludeFragmentId: 'pr-0003',
    })
    const joined = messages.map(m => m.content).join('\n')

    expect(joined).not.toContain('Old arc summary.')
  })

  it('omits the summary block when no summary fragments exist', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    const proseA = makeFragment({ id: 'pr-0001', type: 'prose', name: 'A', content: 'A', order: 1 })
    await createFragment(dataDir, story.id, proseA)
    await addProseSection(dataDir, story.id, proseA.id)

    const messages = await buildContext(dataDir, story.id, 'Regenerate A', {
      excludeFragmentId: 'pr-0001',
    })
    const joined = messages.map(m => m.content).join('\n')

    expect(joined).not.toContain('## Story Summary So Far')
  })

  it('limits prose by maxCharacters', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    // Create 3 prose fragments with known content lengths
    // 'A'.repeat(100) = 100 chars, 'B'.repeat(100) = 100 chars, 'C'.repeat(100) = 100 chars
    for (let i = 0; i < 3; i++) {
      const letter = String.fromCharCode(65 + i) // A, B, C
      await createFragment(dataDir, story.id, makeFragment({
        id: `pr-000${i + 1}`,
        type: 'prose',
        name: `Prose ${letter}`,
        content: letter.repeat(100),
        order: i + 1,
      }))
    }

    // Budget of 150 chars should only fit 1 fragment (the last one = C)
    const state = await buildContextState(dataDir, story.id, 'Continue', {
      contextCompact: { type: 'maxCharacters', value: 150 },
    })

    expect(state.proseFragments.length).toBe(1)
    expect(state.proseFragments[0].id).toBe('pr-0003')
  })

  it('limits prose by maxTokens (chars / 4)', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    // 3 fragments, each 400 chars = 100 tokens each
    for (let i = 0; i < 3; i++) {
      const letter = String.fromCharCode(65 + i)
      await createFragment(dataDir, story.id, makeFragment({
        id: `pr-000${i + 1}`,
        type: 'prose',
        name: `Prose ${letter}`,
        content: letter.repeat(400),
        order: i + 1,
      }))
    }

    // Budget of 250 tokens should fit 2 fragments (B and C, 100+100=200, next would be 300 > 250)
    const state = await buildContextState(dataDir, story.id, 'Continue', {
      contextCompact: { type: 'maxTokens', value: 250 },
    })

    expect(state.proseFragments.length).toBe(2)
    expect(state.proseFragments[0].id).toBe('pr-0002')
    expect(state.proseFragments[1].id).toBe('pr-0003')
  })

  it('maxCharacters always includes at least one fragment even if over budget', async () => {
    const story = makeStory()
    await createStory(dataDir, story)

    await createFragment(dataDir, story.id, makeFragment({
      id: 'pr-0001',
      type: 'prose',
      name: 'Big',
      content: 'X'.repeat(10000),
      order: 1,
    }))

    // Budget is tiny but should still include the last fragment
    const state = await buildContextState(dataDir, story.id, 'Continue', {
      contextCompact: { type: 'maxCharacters', value: 1 },
    })

    expect(state.proseFragments.length).toBe(1)
    expect(state.proseFragments[0].id).toBe('pr-0001')
  })

  it('reads contextCompact from story settings when not passed via opts', async () => {
    const story = makeStory({
      settings: makeTestSettings({ contextCompact: { type: 'maxCharacters', value: 150 } }),
    })
    await createStory(dataDir, story)

    for (let i = 0; i < 3; i++) {
      const letter = String.fromCharCode(65 + i)
      await createFragment(dataDir, story.id, makeFragment({
        id: `pr-000${i + 1}`,
        type: 'prose',
        name: `Prose ${letter}`,
        content: letter.repeat(100),
        order: i + 1,
      }))
    }

    // Story setting says maxCharacters:150, should only fit 1 fragment
    const state = await buildContextState(dataDir, story.id, 'Continue')

    expect(state.proseFragments.length).toBe(1)
    expect(state.proseFragments[0].id).toBe('pr-0003')
  })
})

/**
 * A catalog row tells its reader how to expand it, and that sentence is only
 * correct if it matches the reader's toolset. Three states, not two: a call site
 * that never said is not the same claim as an agent that has no tools.
 */
describe('catalog expansion note', () => {
  const sections = [{ type: 'character', label: 'Characters', fragments: [makeFragment({ id: 'ch-a', type: 'character', name: 'Alice', description: 'A person' })] }]

  it('reads a silent call site as able to read, so no existing prompt changes', () => {
    expect(canReadFragments({})).toBeUndefined()
    expect(fragmentCatalogContent(sections, { canReadFragments: canReadFragments({}) }))
      .toContain('Use readFragments')
  })

  it('tells an agent with no tools that a row is all it gets', () => {
    expect(canReadFragments({ enabledTools: [] })).toBe(false)
    const content = fragmentCatalogContent(sections, { canReadFragments: canReadFragments({ enabledTools: [] }) })
    expect(content).not.toContain('readFragments')
    expect(content).toContain('You cannot open these rows')
  })

  // An author disabling readFragments on an agent that otherwise has tools is
  // the same situation as a toolless agent, and must read the same way.
  it('follows the resolved toolset, not merely the presence of some tool', () => {
    expect(canReadFragments({ enabledTools: ['listFragments', 'readProseChain'] })).toBe(false)
    expect(canReadFragments({ enabledTools: ['readFragments'] })).toBe(true)
    expect(fragmentCatalogContent(sections, { canReadFragments: canReadFragments({ enabledTools: ['listFragments'] }) }))
      .toContain('You cannot open these rows')
  })

  it('keeps the editing wording for a reader that both reads and edits', () => {
    expect(fragmentCatalogContent(sections, { editable: true, canReadFragments: true }))
      .toContain('Read full fragments with readFragments before editing')
  })
})

describe('context blocks', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeAll(() => {
    ensureCoreAgentsRegistered()
  })

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('createDefaultBlocks', () => {
    it('returns expected block IDs for a basic state', async () => {
      const story = makeStory()
      await createStory(dataDir, story)

      const state = await buildContextState(dataDir, story.id, 'Continue the story')
      const blocks = createDefaultBlocks(state)

      const ids = blocks.map(b => b.id)
      expect(ids).toContain('instructions')
      expect(ids).toContain('tools')
      expect(ids).toContain('story-info')
      expect(ids).not.toContain('summary')
      expect(ids).toContain('author-input')
    })

    it('assigns correct roles to blocks', async () => {
      const story = makeStory()
      await createStory(dataDir, story)

      const state = await buildContextState(dataDir, story.id, 'Continue')
      const blocks = createDefaultBlocks(state)

      const systemIds = blocks.filter(b => b.role === 'system').map(b => b.id)
      const userIds = blocks.filter(b => b.role === 'user').map(b => b.id)

      expect(systemIds).toContain('instructions')
      expect(systemIds).toContain('tools')
      expect(userIds).toContain('story-info')
      expect(userIds).toContain('author-input')
    })

    it('omits summary block when summary is empty', async () => {
      const story = makeStory()
      await createStory(dataDir, story)

      const state = await buildContextState(dataDir, story.id, 'Continue')
      const blocks = createDefaultBlocks(state)

      expect(findBlock(blocks, 'summary')).toBeUndefined()
    })

    it('omits prose block when no prose fragments', async () => {
      const story = makeStory()
      await createStory(dataDir, story)

      const state = await buildContextState(dataDir, story.id, 'Continue')
      const blocks = createDefaultBlocks(state)

      expect(findBlock(blocks, 'prose-recent')).toBeUndefined()
    })

    it('creates prose block when prose fragments exist', async () => {
      const story = makeStory()
      await createStory(dataDir, story)
      await createFragment(dataDir, story.id, makeFragment({
        id: 'pr-0001', type: 'prose', name: 'Ch1', content: 'Hello world.', order: 1,
      }))

      const state = await buildContextState(dataDir, story.id, 'Continue')
      const blocks = createDefaultBlocks(state)

      const prose = findBlock(blocks, 'prose-recent')
      expect(prose).toBeDefined()
      expect(prose!.role).toBe('user')
      expect(prose!.content).toContain('## Recent Prose\n\nHello world.\n\n## End of Recent Prose')
      expect(prose!.content).toContain('Hello world.')
      expect(prose!.content).not.toMatch(/\n{3,}/)
    })

    it('creates a fragment catalog for non-sticky fragments', async () => {
      const story = makeStory()
      await createStory(dataDir, story)
      await createFragment(dataDir, story.id, makeFragment({
        id: 'gl-0001', type: 'guideline', name: 'Tone', description: 'Tone rules',
        content: 'Write darkly.', sticky: false,
      }))
      await createFragment(dataDir, story.id, makeFragment({
        id: 'kn-0001', type: 'knowledge', name: 'Lore', description: 'World lore',
        content: 'Magic exists.', sticky: false,
      }))

      const state = await buildContextState(dataDir, story.id, 'Continue')
      const blocks = createDefaultBlocks(state)

      const catalog = findBlock(blocks, 'fragment-catalog')
      expect(catalog).toBeDefined()
      expect(catalog!.content).toContain('## Fragment Catalog')
      expect(catalog!.content).toContain('one-line catalog row, not the full fragment')
      expect(catalog!.content).toContain('### Guidelines')
      expect(catalog!.content).toContain('### Knowledge')
      expect(catalog!.content).toContain('gl-0001')
      expect(catalog!.content).toContain('kn-0001')
    })

    it('omits the fragment catalog when there are no catalog rows', async () => {
      const story = makeStory()
      await createStory(dataDir, story)

      const state = await buildContextState(dataDir, story.id, 'Continue')
      const blocks = createDefaultBlocks(state)

      expect(findBlock(blocks, 'fragment-catalog')).toBeUndefined()
    })

    it('all blocks have source "builtin"', async () => {
      const story = makeStory()
      await createStory(dataDir, story)

      const state = await buildContextState(dataDir, story.id, 'Continue')
      const blocks = createDefaultBlocks(state)

      for (const block of blocks) {
        expect(block.source).toBe('builtin')
      }
    })

  })

  describe('compileBlocks', () => {
    it('groups blocks by role and produces system + user messages', () => {
      const blocks: ContextBlock[] = [
        { id: 'a', role: 'system', content: 'System A', order: 100, source: 'builtin' },
        { id: 'b', role: 'user', content: 'User B', order: 100, source: 'builtin' },
      ]

      const messages = compileBlocks(blocks)
      expect(messages).toHaveLength(2)
      expect(messages[0].role).toBe('system')
      expect(messages[0].content).toBe('[@block=a]\nSystem A')
      expect(messages[1].role).toBe('user')
      expect(messages[1].content).toBe('[@block=b]\nUser B')
    })

    it('prepends [@block=id] marker to each block', () => {
      const blocks: ContextBlock[] = [
        { id: 'my-block', role: 'user', content: 'Hello', order: 100, source: 'builtin' },
      ]

      const messages = compileBlocks(blocks)
      expect(messages[0].content).toBe('[@block=my-block]\nHello')
    })

    it('sorts blocks by order and separates with blank lines', () => {
      const blocks: ContextBlock[] = [
        { id: 'b', role: 'user', content: 'Second', order: 200, source: 'builtin' },
        { id: 'a', role: 'user', content: 'First', order: 100, source: 'builtin' },
        { id: 'c', role: 'user', content: 'Third', order: 300, source: 'builtin' },
      ]

      const messages = compileBlocks(blocks)
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe(
        '[@block=a]\nFirst\n\n[@block=b]\nSecond\n\n[@block=c]\nThird',
      )
    })

    it('omits role when no blocks of that role exist', () => {
      const blocks: ContextBlock[] = [
        { id: 'a', role: 'user', content: 'User only', order: 100, source: 'builtin' },
      ]

      const messages = compileBlocks(blocks)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('user')
    })

    it('returns empty array for empty blocks', () => {
      expect(compileBlocks([])).toEqual([])
    })
  })

  describe('block manipulation', () => {
    const blocks: ContextBlock[] = [
      { id: 'a', role: 'system', content: 'Alpha', order: 100, source: 'builtin' },
      { id: 'b', role: 'system', content: 'Beta', order: 200, source: 'builtin' },
      { id: 'c', role: 'user', content: 'Gamma', order: 100, source: 'builtin' },
    ]

    it('findBlock returns the matching block', () => {
      expect(findBlock(blocks, 'b')).toEqual(blocks[1])
    })

    it('findBlock returns undefined for missing id', () => {
      expect(findBlock(blocks, 'missing')).toBeUndefined()
    })

    it('replaceBlockContent replaces content of target block', () => {
      const result = replaceBlockContent(blocks, 'b', 'New Beta')
      expect(findBlock(result, 'b')!.content).toBe('New Beta')
      // Original unchanged
      expect(findBlock(blocks, 'b')!.content).toBe('Beta')
    })

    it('removeBlock removes the target block', () => {
      const result = removeBlock(blocks, 'b')
      expect(result).toHaveLength(2)
      expect(findBlock(result, 'b')).toBeUndefined()
    })

    it('insertBlockBefore inserts before target', () => {
      const newBlock: ContextBlock = { id: 'x', role: 'system', content: 'X', order: 150, source: 'test' }
      const result = insertBlockBefore(blocks, 'b', newBlock)
      expect(result).toHaveLength(4)
      const ids = result.map(b => b.id)
      expect(ids).toEqual(['a', 'x', 'b', 'c'])
    })

    it('insertBlockBefore appends when target not found', () => {
      const newBlock: ContextBlock = { id: 'x', role: 'system', content: 'X', order: 150, source: 'test' }
      const result = insertBlockBefore(blocks, 'missing', newBlock)
      expect(result).toHaveLength(4)
      expect(result[result.length - 1].id).toBe('x')
    })

    it('insertBlockAfter inserts after target', () => {
      const newBlock: ContextBlock = { id: 'x', role: 'system', content: 'X', order: 150, source: 'test' }
      const result = insertBlockAfter(blocks, 'a', newBlock)
      expect(result).toHaveLength(4)
      const ids = result.map(b => b.id)
      expect(ids).toEqual(['a', 'x', 'b', 'c'])
    })

    it('insertBlockAfter appends when target not found', () => {
      const newBlock: ContextBlock = { id: 'x', role: 'system', content: 'X', order: 150, source: 'test' }
      const result = insertBlockAfter(blocks, 'missing', newBlock)
      expect(result).toHaveLength(4)
      expect(result[result.length - 1].id).toBe('x')
    })

    it('reorderBlock changes the order of target block', () => {
      const result = reorderBlock(blocks, 'a', 999)
      expect(findBlock(result, 'a')!.order).toBe(999)
      // Original unchanged
      expect(findBlock(blocks, 'a')!.order).toBe(100)
    })
  })

  describe('fidelity', () => {
    it('assembleMessages matches compileBlocks(createDefaultBlocks(...))', async () => {
      const story = makeStory()
      await createStory(dataDir, story)

      // Add some fragments for a realistic context
      await createFragment(dataDir, story.id, makeFragment({
        id: 'gl-0001', type: 'guideline', name: 'Tone', description: 'Tone rules',
        content: 'Write in a dark style.', sticky: true,
      }))
      await createFragment(dataDir, story.id, makeFragment({
        id: 'ch-0001', type: 'character', name: 'Hero', description: 'Main character',
        content: 'A brave warrior.', sticky: true,
      }))
      await createFragment(dataDir, story.id, makeFragment({
        id: 'kn-0001', type: 'knowledge', name: 'Lore', description: 'World lore',
        content: 'Dragons exist.', sticky: false,
      }))
      await createFragment(dataDir, story.id, makeFragment({
        id: 'pr-0001', type: 'prose', name: 'Ch1', content: 'The story begins.', order: 1,
      }))
      await createFragment(dataDir, story.id, makeFragment({
        id: 'pr-0002', type: 'prose', name: 'Ch2', content: 'The adventure continues.', order: 2,
      }))

      const state = await buildContextState(dataDir, story.id, 'Make the dragon appear')

      const fromAssemble = assembleMessages(state)
      const fromBlocks = compileBlocks(createDefaultBlocks(state))

      expect(fromBlocks).toEqual(fromAssemble)
    })
  })

  describe('addCacheBreakpoints', () => {
    it('adds cache control to system message', () => {
      const messages: ContextMessage[] = [
        { role: 'system', content: 'You are a writing assistant.' },
      ]

      const result = addCacheBreakpoints(messages)

      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('system')
      expect(result[0].content).toBe('You are a writing assistant.')
      expect(result[0].providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      })
    })

    it('splits user message at author-input marker', () => {
      const messages: ContextMessage[] = [
        {
          role: 'user',
          content: '[@block=story-info]\n## Story: Test\n\n[@block=author-input]\nThe author wants the following to happen next: Continue',
        },
      ]

      const result = addCacheBreakpoints(messages)

      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('user')
      expect(Array.isArray(result[0].content)).toBe(true)

      const parts = result[0].content as Array<{ type: string; text: string; providerOptions?: unknown }>
      expect(parts).toHaveLength(2)

      // Stable prefix has cache control
      expect(parts[0].type).toBe('text')
      expect(parts[0].text).toBe('[@block=story-info]\n## Story: Test')
      expect(parts[0].providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      })

      // Volatile suffix has no cache control
      expect(parts[1].type).toBe('text')
      expect(parts[1].text).toContain('[@block=author-input]')
      expect(parts[1].text).toContain('Continue')
      expect(parts[1].providerOptions).toBeUndefined()
    })

    it('falls back to single string when author-input marker not found', () => {
      const messages: ContextMessage[] = [
        { role: 'user', content: 'Some content without marker' },
      ]

      const result = addCacheBreakpoints(messages)

      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('user')
      expect(result[0].content).toBe('Some content without marker')
    })

    it('passes through assistant messages unchanged', () => {
      const messages: ContextMessage[] = [
        { role: 'assistant', content: 'Once upon a time...' },
      ]

      const result = addCacheBreakpoints(messages)

      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('assistant')
      expect(result[0].content).toBe('Once upon a time...')
    })

    it('handles full system + user message pair', () => {
      const messages: ContextMessage[] = [
        { role: 'system', content: 'System instructions here.' },
        {
          role: 'user',
          content: '[@block=story-info]\nStory info\n\n[@block=prose]\nSome prose\n\n[@block=author-input]\nThe author wants the following to happen next: Write more',
        },
      ]

      const result = addCacheBreakpoints(messages)

      expect(result).toHaveLength(2)

      // System message has cache control
      expect(result[0].providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      })

      // User message is split into parts
      const parts = result[1].content as Array<{ type: string; text: string; providerOptions?: unknown }>
      expect(parts).toHaveLength(2)
      expect(parts[0].text).toContain('Story info')
      expect(parts[0].text).toContain('Some prose')
      expect(parts[0].text).not.toContain('Write more')
      expect(parts[1].text).toContain('Write more')
    })
  })
})
