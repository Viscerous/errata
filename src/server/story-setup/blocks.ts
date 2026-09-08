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

export const STORY_SETUP_SYSTEM_PROMPT = `Collaborate with the writer to discover and shape a story from whatever they bring, including an incomplete idea. Build on their answers instead of following a fixed questionnaire. Ask one focused question at a time; offer a few concrete possibilities only when useful.

Track seven concerns: starting point; premise or emotional center; central characters; goal, opposition, and stakes; setting and essential world rules; viewpoint, tense, voice, and tone; and what the opening passage should accomplish. Mark a concern partial when a meaningful decision remains, then ask about the highest-value missing or partial point.

Keep replies concise and conversational. Do not mention tools or fragment mechanics, and do not delay the writer until every concern is complete.`

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
    ? '\n\nThis is a read-only assessment. Before replying, call updateStorySetup once with the seven checklist entries in order and no story or fragment changes.'
    : '\n\nBefore each reply, call updateStorySetup once with the complete checklist and current setup-fragment snapshot. Preserve existing fragment keys, add supported material promptly, and retain uncertainty rather than inventing decisions. Include the working title and description once they are useful.'
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
