import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import {
  createStory,
  createFragment,
  getFragment,
  getStory,
  listFragments,
  updateStory,
} from '@/server/fragments/storage'
import { initProseChain } from '@/server/fragments/prose-chain'
import type { StoryMeta, Fragment } from '@/server/fragments/schema'
import { coreProposalToolNames, coreReadToolNames, createFragmentTools } from '@/server/llm/tools'
import { proposeFragmentChangesSchema, sanitizeTextForToolEcho } from '@/server/fragments/change-operations'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeFragment(overrides: Partial<Fragment> = {}): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'pr-0001',
    type: 'prose',
    name: 'Test',
    description: 'A test fragment',
    content: 'Test content',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user' as const,
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    archived: false,
    version: 1,
    versions: [],
    ...overrides,
  }
}

async function execTool<T = any>(toolDef: any, args: Record<string, unknown>): Promise<T> {
  return toolDef.execute!(args, { toolCallId: 'tc-1', messages: [] })
}

describe('sanitizeTextForToolEcho', () => {
  it('removes complete reasoning-tag pairs', () => {
    expect(sanitizeTextForToolEcho('A <think>hmm, plotting</think> B')).toBe('A  B')
  })

  it('does not truncate on an unclosed reasoning tag in legitimate content', () => {
    // A stray '<thinking' inside real content must not eat everything after it
    // (the write-path schema strips aggressively; echoes must not).
    const text = 'She was <thinking about the war and everything that came after.'
    expect(sanitizeTextForToolEcho(text)).toBe(text)
  })
})

describe('LLM tools', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  const storyId = 'story-test'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, makeStory())
  })

  afterEach(async () => {
    await cleanup()
  })

  it('exposes the compact read-only surface by default', () => {
    const tools = createFragmentTools(dataDir, storyId)
    expect(Object.keys(tools)).toEqual(coreReadToolNames())
    for (const oldName of ['getFragment', 'searchFragments', 'createFragment', 'updateFragment', 'editFragment', 'deleteFragment', 'editProse']) {
      expect(tools).not.toHaveProperty(oldName)
    }
  })

  it('adds proposal/apply tools, not direct write tools, when write-enabled', () => {
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })
    expect(Object.keys(tools)).toEqual([...coreReadToolNames(), ...coreProposalToolNames()])
    for (const oldName of ['createFragment', 'updateFragment', 'editFragment', 'deleteFragment', 'editProse', 'getStorySummary', 'updateStorySummary']) {
      expect(tools).not.toHaveProperty(oldName)
    }
  })

  it('batch-reads full fragments with baseHash', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'kn-0001', type: 'knowledge', content: 'Secret lore.' }))
    const tools = createFragmentTools(dataDir, storyId)

    const result = await execTool(tools.readFragments, { fragmentIds: ['kn-0001', 'kn-missing'] })

    expect(result.fragments).toHaveLength(1)
    expect(result.fragments[0]).toMatchObject({ id: 'kn-0001', content: 'Secret lore.' })
    expect(result.fragments[0].baseHash).toMatch(/^[a-f0-9]{16}$/)
    expect(result.missing).toEqual(['kn-missing'])
  })

  it('finds and lists fragments without returning full content from listFragments', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'kn-0001', type: 'knowledge', name: 'Moon Ritual', description: 'Silver ash', content: 'Moon ritual requires river water.' }))
    const tools = createFragmentTools(dataDir, storyId)

    const found = await execTool(tools.findFragments, { query: 'river' })
    expect(found.matches[0]).toMatchObject({ id: 'kn-0001', field: 'content' })
    expect(found.matches[0].excerpt).toContain('river')

    const listed = await execTool(tools.listFragments, { type: 'knowledge' })
    expect(listed.fragments[0]).toMatchObject({ id: 'kn-0001', name: 'Moon Ritual' })
    expect(listed.fragments[0]).not.toHaveProperty('content')
  })

  it('validates and applies a create_fragment proposal', async () => {
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const proposal = await execTool(tools.proposeFragmentChanges, {
      operations: [{
        action: 'create_fragment',
        type: 'knowledge',
        name: 'Moon Ritual',
        description: 'How moon magic works',
        content: 'Moon ritual requires silver ash and river water.',
      }],
    })

    expect(proposal.ok).toBe(true)
    expect(proposal.valid).toBe(1)

    const applied = await execTool(tools.applyProposedChanges, { proposalId: proposal.proposalId })
    expect(applied.ok).toBe(true)
    const fragments = await listFragments(dataDir, storyId, 'knowledge')
    expect(fragments[0]).toMatchObject({ name: 'Moon Ritual', content: 'Moon ritual requires silver ash and river water.' })
  })

  it('rejects fragment names that copy generated IDs or id labels', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-0001', type: 'character', name: 'Alice' }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const createProposal = await execTool(tools.proposeFragmentChanges, {
      operations: [{
        action: 'create_fragment',
        type: 'character',
        name: 'ch-thorne: Elias Thorne',
        description: 'A rival patron',
        content: 'Elias Thorne is a rival patron.',
      }],
    })
    expect(createProposal.ok).toBe(false)
    expect(createProposal.operations[0].errors[0].code).toBe('fragment_name_invalid')
    await expect(proposeFragmentChangesSchema.parseAsync({
      operations: [{
        action: 'create_fragment',
        type: 'character',
        name: '   ',
        description: 'Blank name',
        content: 'This should not parse.',
      }],
    })).rejects.toThrow()

    const read = await execTool(tools.readFragments, { fragmentIds: ['ch-0001'] })
    const updateProposal = await execTool(tools.proposeFragmentChanges, {
      operations: [{
        action: 'set_fields',
        fragmentId: 'ch-0001',
        baseHash: read.fragments[0].baseHash,
        fields: { name: 'ch-alice' },
      }],
    })
    expect(updateProposal.ok).toBe(false)
    expect(updateProposal.operations[0].errors[0].code).toBe('fragment_name_invalid')
  })

  it('requires baseHash for whole-field rewrites and applies with the current hash', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-0001', type: 'character', content: 'Alice is wary.' }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const missingHash = await execTool(tools.proposeFragmentChanges, {
      operations: [{
        action: 'set_fields',
        fragmentId: 'ch-0001',
        fields: { content: 'Alice is wary and newly crowned.' },
      }],
    })
    expect(missingHash.ok).toBe(false)
    expect(missingHash.operations[0].errors[0].code).toBe('base_hash_required')
    expect(missingHash.operations[0].errors[0].nextAction).toBe('readFragments')
    expect(missingHash.readFragmentIds).toEqual(['ch-0001'])

    const read = await execTool(tools.readFragments, { fragmentIds: ['ch-0001'] })
    const proposal = await execTool(tools.proposeFragmentChanges, {
      operations: [{
        action: 'set_fields',
        fragmentId: 'ch-0001',
        baseHash: read.fragments[0].baseHash,
        fields: { description: 'New queen', content: 'Alice is wary and newly crowned.' },
      }],
    })
    expect(proposal.ok).toBe(true)

    await execTool(tools.applyProposedChanges, { proposalId: proposal.proposalId })
    const updated = await getFragment(dataDir, storyId, 'ch-0001')
    expect(updated?.description).toBe('New queen')
    expect(updated?.content).toBe('Alice is wary and newly crowned.')
    expect(updated?.version).toBe(2)
  })

  it('batches multiple exact edits against one fragment atomically', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-0001', type: 'character', content: 'Alice has blue eyes. Alice serves the guard.' }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const proposal = await execTool(tools.proposeFragmentChanges, {
      operations: [
        { action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'blue eyes', newText: 'hazel eyes' },
        { action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'serves the guard', newText: 'left the guard' },
      ],
    })
    expect(proposal.ok).toBe(true)

    const applied = await execTool(tools.applyProposedChanges, { proposalId: proposal.proposalId })
    expect(applied.ok).toBe(true)
    const updated = await getFragment(dataDir, storyId, 'ch-0001')
    expect(updated?.content).toBe('Alice has hazel eyes. Alice left the guard.')
  })

  it('strips leaked reasoning tags from model-facing diff previews', async () => {
    await createFragment(dataDir, storyId, makeFragment({
      id: 'ch-0001',
      type: 'character',
      content: '<think>previous hidden reasoning</think>Alice has blue eyes.',
    }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const read = await execTool<any>(tools.readFragments, { fragmentIds: ['ch-0001'] })
    expect(read.fragments[0].content).toBe('Alice has blue eyes.')

    const proposal = await execTool<any>(tools.proposeFragmentChanges, {
      operations: [{
        action: 'replace_text',
        fragmentId: 'ch-0001',
        field: 'content',
        oldText: 'blue eyes',
        newText: 'hazel eyes',
      }],
    })

    const diff = proposal.operations[0].diffs[0]
    expect(diff.before).toBe('Alice has blue eyes.')
    expect(diff.after).toBe('Alice has hazel eyes.')
  })

  it('supports mid-content replace and append operations in one proposal', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'kn-0001', type: 'knowledge', content: 'Opening.\nClosing.' }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const proposal = await execTool(tools.proposeFragmentChanges, {
      operations: [
        { action: 'replace_text', fragmentId: 'kn-0001', field: 'content', oldText: 'Closing.', newText: 'Middle.\nClosing.' },
        { action: 'append_paragraph', fragmentId: 'kn-0001', field: 'content', text: 'Afterword.' },
      ],
    })
    expect(proposal.ok).toBe(true)
    expect(proposal.operations[1].diffs?.[0]).toMatchObject({
      field: 'content',
      before: '',
      after: 'Afterword.',
    })

    const applied = await execTool(tools.applyProposedChanges, { proposalId: proposal.proposalId })
    expect(applied.ok).toBe(true)
    const updated = await getFragment(dataDir, storyId, 'kn-0001')
    expect(updated?.content).toBe('Opening.\nMiddle.\nClosing.\n\nAfterword.')
  })

  it('sanitizes double-escaped quotes and newlines in operations schema', async () => {
    const parsed = await proposeFragmentChangesSchema.parseAsync({
      operations: [
        {
          action: 'create_fragment',
          type: 'knowledge',
          name: '<think>draft name</think>Reinier\\\'s Protocol',
          description: 'A description with \\"quotes\\"',
          content: '<think>private reasoning</think>Authentication:\\n- Verbal: \\"Challenge\\".\\n- Reply: \\"Answer\\".',
        },
        {
          action: 'append_paragraph',
          fragmentId: 'ch-0001',
          field: 'content',
          text: '\\n\\n<thinking>hidden</thinking>Some appended text.\\n\\n',
        },
        {
          action: 'replace_text',
          fragmentId: 'ch-0001',
          field: 'content',
          oldText: '<think>literal anchor</think>',
          newText: '<reasoning>hidden</reasoning>Visible replacement.',
        }
      ]
    })

    const createOp = parsed.operations[0] as any
    expect(createOp.name).toBe("Reinier's Protocol")
    expect(createOp.description).toBe('A description with "quotes"')
    expect(createOp.content).toBe('Authentication:\n- Verbal: "Challenge".\n- Reply: "Answer".')

    const appendOp = parsed.operations[1] as any
    expect(appendOp.text).toBe('Some appended text.')

    const replaceOp = parsed.operations[2] as any
    expect(replaceOp.oldText).toBe('<think>literal anchor</think>')
    expect(replaceOp.newText).toBe('Visible replacement.')
  })

  it('rejects ambiguous exact edits unless occurrence or replaceAll is provided', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-0001', type: 'character', content: 'Alice waits. Alice listens.' }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const proposal = await execTool(tools.proposeFragmentChanges, {
      operations: [{ action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'Alice', newText: 'Alicia' }],
    })

    expect(proposal.ok).toBe(false)
    expect(proposal.operations[0].errors[0].code).toBe('old_text_ambiguous')
    expect(proposal.operations[0].errors[0].nextAction).toBe('readFragments')
    expect(proposal.readFragmentIds).toEqual(['ch-0001'])
  })

  it('supports occurrence and replaceAll for repeated replace_text anchors', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'ch-0001', type: 'character', content: 'Alice waits. Alice listens. Alice leaves.' }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const occurrenceProposal = await execTool(tools.proposeFragmentChanges, {
      operations: [{ action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'Alice', newText: 'Alicia', occurrence: 2 }],
    })
    expect(occurrenceProposal.ok).toBe(true)
    await execTool(tools.applyProposedChanges, { proposalId: occurrenceProposal.proposalId })
    expect((await getFragment(dataDir, storyId, 'ch-0001'))?.content).toBe('Alice waits. Alicia listens. Alice leaves.')

    const replaceAllProposal = await execTool(tools.proposeFragmentChanges, {
      operations: [{ action: 'replace_text', fragmentId: 'ch-0001', field: 'content', oldText: 'Alice', newText: 'Alicia', replaceAll: true }],
    })
    expect(replaceAllProposal.ok).toBe(true)
    await execTool(tools.applyProposedChanges, { proposalId: replaceAllProposal.proposalId })
    expect((await getFragment(dataDir, storyId, 'ch-0001'))?.content).toBe('Alicia waits. Alicia listens. Alicia leaves.')
  })

  it('routes prose edits through the prose-specific proposal tool', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001', type: 'prose', content: 'The Cabinet agent arrived.' }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const proposal = await execTool(tools.proposeFragmentChanges, {
      operations: [{ action: 'replace_text', fragmentId: 'pr-0001', field: 'content', oldText: 'Cabinet', newText: 'NOCTURNAL' }],
    })

    expect(proposal.ok).toBe(false)
    expect(proposal.operations[0].errors[0].code).toBe('prose_requires_prose_tool')
  })

  it('scans active prose for prose changes and applies only active fragments', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0001', type: 'prose', content: 'The Cabinet agent arrived.' }))
    await createFragment(dataDir, storyId, makeFragment({ id: 'pr-0002', type: 'prose', content: 'The Cabinet agent waited.' }))
    await initProseChain(dataDir, storyId, 'pr-0001')
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const proposal = await execTool(tools.proposeProseChanges, {
      edits: [{ oldText: 'The Cabinet agent', newText: 'The NOCTURNAL operative' }],
    })
    expect(proposal.ok).toBe(true)
    expect(proposal.valid).toBe(1)

    await execTool(tools.applyProposedChanges, { proposalId: proposal.proposalId })
    expect((await getFragment(dataDir, storyId, 'pr-0001'))?.content).toBe('The NOCTURNAL operative arrived.')
    expect((await getFragment(dataDir, storyId, 'pr-0002'))?.content).toBe('The Cabinet agent waited.')
  })

  it('archives instead of deleting fragments', async () => {
    await createFragment(dataDir, storyId, makeFragment({ id: 'kn-0001', type: 'knowledge' }))
    const tools = createFragmentTools(dataDir, storyId, { readOnly: false })

    const applied = await execTool(tools.applyProposedChanges, {
      operations: [{ action: 'archive_fragment', fragmentId: 'kn-0001' }],
    })
    expect(applied.ok).toBe(true)
    const archived = await getFragment(dataDir, storyId, 'kn-0001')
    expect(archived?.archived).toBe(true)
  })

  it('reads fragment-backed story summaries', async () => {
    await createFragment(dataDir, storyId, makeFragment({
      id: 'sm-test01',
      type: 'summary',
      name: 'Opening summary',
      content: 'The fragment summary is canonical.',
      placement: 'system',
      meta: { chapterId: null, isEraSummary: false },
    }))

    const tools = createFragmentTools(dataDir, storyId)
    const result = await execTool(tools.readStorySummary, {})

    expect(result.summary).toBe('The fragment summary is canonical.')
    expect(result.fragments[0]).toMatchObject({ id: 'sm-test01', type: 'summary' })
  })

  it('lists custom fragment types', async () => {
    const story = makeStory()
    await updateStory(dataDir, {
      ...story,
      settings: {
        ...story.settings,
        customFragmentTypes: [{
          type: 'location',
          name: 'Locations',
          description: 'Places and geography',
          icon: 'MapPin',
          showInSidebar: true,
        }],
      },
    })

    const tools = createFragmentTools(dataDir, storyId)
    const result = await execTool(tools.listFragmentTypes, {})
    expect(result.types).toContainEqual({
      type: 'location',
      prefix: 'loca',
      stickyByDefault: false,
      hiddenFromList: false,
      name: 'Locations',
      description: 'Places and geography',
      custom: true,
    })

    const storyAfter = await getStory(dataDir, storyId)
    expect(storyAfter?.settings.customFragmentTypes[0].type).toBe('location')
  })
})
