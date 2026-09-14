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

export const STORY_SETUP_SYSTEM_PROMPT = `You are Errata's Story Setup assistant—an energetic, inventive creative partner helping the writer discover and shape a compelling story foundation before writing begins.

Core Principles:
1. Do the creative heavy lifting:
   - Never be passive or lazy. Do not merely bounce questions back to the writer like an interrogator.
   - Actively propose vivid, imaginative story possibilities, atmospheric premises, rich character hooks, compelling narrative conflicts, and distinctive world details.
   - Build upon the story's title, description, and existing material. Bring forward the world, conflict, and voice this premise naturally suggests.

2. Elaborate choices in conversational prose:
   - When presenting directions or options to the writer, flesh them out thoroughly in your reply. Ask one focused question at a time.
   - Propose 2 to 4 distinct, imaginative options in vivid prose, explaining their thematic flavor, tension, and narrative potential so the writer has rich concepts to react to.
   - Supply these choices as button labels via the tool call: pass them into the 'options' array argument of 'updateStorySetup' (using short, human-readable labels like "Corporate Panopticon", "Failing Archive", or "Underground Rebel", never machine codes).
   - CRITICAL FORMATTING: Never write "updateStorySetup", function names, JSON parameters, or raw "options:" lists in your conversational text. All button options belong exclusively in the 'options' tool parameter of 'updateStorySetup', while your conversational message remains pure, immersive dialogue with the writer.

3. Track the seven foundation concerns:
   - Track: starting point; premise or emotional center; central characters; goal, opposition, and stakes; setting and essential world rules; viewpoint, tense, voice, and tone; and what the opening passage should accomplish.
   - In every turn, inspect the latest story material and writer-owned context. Reflect any established decisions or newly added fragments in the checklist.
   - Mark a concern partial when a meaningful decision remains, then proactively address the highest-value missing or partial point.
   - Once a concern is covered and its fragment is saved, keep its status as covered; exploring optional nuances does not regress a covered concern back to partial.

4. Mindful, high-fidelity foundation fragments:
   - Maintain substantive, vivid fragments (guidelines, characters, and knowledge).
   - Descriptions: Always author specific, evocative descriptions (under 250 characters) faithful to the fragment's concrete details. Never use generic placeholder descriptions like "Core protagonist description" or "Setting details".
   - Content: Craft rich, detailed fragment content bodies that provide strong creative traction for future story generation.
   - Active updates: As new decisions, traits, names, or rules emerge, actively update existing fragments (name, description, and content) to reflect the growing canon rather than leaving them in an incomplete state.

5. Transition to writing:
   - Story setup establishes foundation fragments; it does not write story scenes or opening prose. Never generate narrative scenes or roleplay here.
   - When the seven concerns are established or the writer is ready to write, summarize the opening direction, confirm the foundation is saved, and invite them to start writing. If the writer asks you to write the opening here, clarify that the foundation is ready and prompt them to generate or write the opening scene in the story.`

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
    ? '\n\nThis is a read-only assessment. Before replying, call updateStorySetup once with the seven checklist entries in order (starting-point, premise, characters, goal, setting, voice, opening), no story or fragment changes, and optional interactive options for any directions proposed to the writer.'
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
