import type { ContextBlock } from '../llm/context-builder'
import type { AgentBlockContext } from '../agents/agent-block-context'
import { buildBasePreviewContext } from '../agents/block-helpers'
import { instructionRegistry } from '../instructions'
import {
  buildFragmentContextLanes,
  fragmentCatalogBlock,
  fragmentFullContextBlocksBySource,
  proseWindowBlock,
} from '../llm/fragment-context-blocks'
import { selectAttentionContext } from '../llm/context-selection'
import { listStorySetupFragments } from './sync'

const isWriterOwned = (fragment: { meta: Record<string, unknown> }) =>
  typeof fragment.meta.storySetupKey !== 'string'

function writerOwnedContext(ctx: AgentBlockContext): AgentBlockContext {
  const filterGroups = (groups: AgentBlockContext['customFragmentCatalogs']) => groups
    ?.map(group => ({ ...group, fragments: group.fragments.filter(isWriterOwned) }))
    .filter(group => group.fragments.length > 0)

  return {
    ...ctx,
    proseFragments: ctx.proseFragments.filter(isWriterOwned),
    stickyGuidelines: ctx.stickyGuidelines.filter(isWriterOwned),
    stickyKnowledge: ctx.stickyKnowledge.filter(isWriterOwned),
    stickyCharacters: ctx.stickyCharacters.filter(isWriterOwned),
    stickyCustomFragments: ctx.stickyCustomFragments?.filter(isWriterOwned),
    guidelineCatalog: ctx.guidelineCatalog.filter(isWriterOwned),
    knowledgeCatalog: ctx.knowledgeCatalog.filter(isWriterOwned),
    characterCatalog: ctx.characterCatalog.filter(isWriterOwned),
    recentKnowledge: ctx.recentKnowledge?.filter(isWriterOwned),
    recentCharacters: ctx.recentCharacters?.filter(isWriterOwned),
    recentCustomFragments: filterGroups(ctx.recentCustomFragments),
    customFragmentCatalogs: filterGroups(ctx.customFragmentCatalogs),
    allKnowledge: ctx.allKnowledge?.filter(isWriterOwned),
    allCharacters: ctx.allCharacters?.filter(isWriterOwned),
    allCustomFragments: filterGroups(ctx.allCustomFragments),
  }
}

export const STORY_SETUP_SYSTEM_PROMPT = `Collaborate with the writer to discover and shape a story foundation before writing begins. Build on their answers instead of following a fixed questionnaire. Ask one focused question at a time. When offering concrete choices, directions, or archetypes for the writer to decide on, provide them consciously in the options field of updateStorySetup (up to 4 options with short, human-readable button labels like "Search the Archive" or "First-person Noir", never machine slugs or codes) so they appear as interactive buttons in the interface. In your conversational message, ask the question naturally without needing to duplicate raw bulleted lists.

Track seven concerns: starting point; premise or emotional center; central characters; goal, opposition, and stakes; setting and essential world rules; viewpoint, tense, voice, and tone; and what the opening passage should accomplish. Mark a concern partial when a meaningful decision remains, then ask about the highest-value missing or partial point. Once a concern is covered and its fragment is saved, keep its status as covered; exploring optional nuances does not regress a covered concern back to partial.

When creating or updating foundation fragments:
- Always author a specific, informative description (under 250 characters) faithful to the fragment's concrete details. Never use generic placeholder descriptions like "Core protagonist description" or "Setting details".
- Mindfully update existing fragments: as the writer reveals new details, traits, rules, or names, update the corresponding fragment's name, description, and content to incorporate that new information rather than leaving it in an incomplete or placeholder state.

Story setup creates foundation fragments (guidelines, characters, and knowledge); it does not write story scenes. Never generate narrative prose, opening passages, or roleplay here. When the seven concerns are established or the writer is ready to write, summarize the opening direction, confirm the foundation is saved, and invite them to begin writing in the manuscript editor. If the writer asks you to write the opening here, clarify that the foundation is ready and prompt them to generate or write the opening passage in the manuscript.`

export function createStorySetupBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const existingStory = ctx.story.name !== 'New Story' || Boolean(ctx.story.description.trim())
    ? `\n\nThis story currently has the working title "${ctx.story.name}"${ctx.story.description ? ` and description: ${ctx.story.description}` : ''}. Treat these as editable starting material.`
    : ''

  const setupFragments = ctx.storySetupFragments ?? []
  const existingFragments = setupFragments.length > 0
    ? `\n\nExisting story setup fragments:\n\n${setupFragments.map(fragment => [
      `### ${fragment.name}`,
      `storySetupKey: ${fragment.meta.storySetupKey}`,
      `type: ${fragment.type}`,
      `description: ${fragment.description}`,
      fragment.content,
    ].join('\n')).join('\n\n')}`
    : ''

  const toolPolicy = ctx.storySetupReadOnly
    ? '\n\nThis is a read-only assessment. Before replying, call updateStorySetup once with the seven checklist entries in order (starting-point, premise, characters, goal, setting, voice, opening) and no story or fragment changes.'
    : '\n\nBefore each reply, call updateStorySetup once with the complete checklist in order (keys: starting-point, premise, characters, goal, setting, voice, opening; statuses: missing, partial, covered), current setup-fragment snapshot, and optional interactive options. Preserve existing fragment keys, add supported material promptly, and retain uncertainty rather than inventing decisions. Include the working title and description once they are useful.'
  const materialPolicy = '\n\nTreat the writer-owned context below as read-only evidence for checklist coverage. Do not copy it into the setup-fragment snapshot.'
  const blocks: ContextBlock[] = [{
    id: 'story-setup-instructions',
    role: 'system',
    content: `${instructionRegistry.resolve('story-setup.system')}${existingStory}${materialPolicy}${existingFragments}${toolPolicy}`,
    order: 100,
    source: 'builtin',
  }]

  const writerContext = writerOwnedContext(ctx)
  const selection = selectAttentionContext(buildFragmentContextLanes(writerContext), {
    runner: 'story-setup.chat',
    catalogScope: 'available',
  })
  blocks.push(...fragmentFullContextBlocksBySource({
    selection,
    partitions: [{
      id: 'story-setup-existing-full',
      heading: 'Existing Writer-Owned Story Material',
      scope: 'all',
      order: 200,
      intro: 'Use this material to assess what the story has already established. It is read-only.',
      matches: () => true,
    }],
  }))

  const catalog = fragmentCatalogBlock({
    id: 'story-setup-existing-catalog',
    sections: selection.lanes.map(lane => ({
      type: lane.type,
      label: lane.label,
      fragments: lane.catalog,
    })),
    order: 220,
  })
  if (catalog) blocks.push(catalog)

  const prose = proseWindowBlock(writerContext.proseFragments, { order: 240 })
  if (prose) blocks.push(prose)

  return blocks
}

export async function buildStorySetupPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const context = await buildBasePreviewContext(dataDir, storyId)
  const setupFragments = await listStorySetupFragments(dataDir, storyId, context.allFragments)
  return {
    ...context,
    storySetupFragments: setupFragments,
    storySetupReadOnly: true,
  }
}
