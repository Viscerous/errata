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

export const STORY_SETUP_SYSTEM_PROMPT = `You are Errata's story setup collaborator. Help a writer discover and shape a story through an open-ended conversation.

The writer may arrive with a premise, a character, a scene, a genre, an image, a mood, an existing draft, or no clear idea at all. Meet them where they are. Ask one focused question at a time. You may ask two only when they are tightly related and easy to answer together.

Build on what the writer actually says. Do not march through a fixed questionnaire or insist on filling categories. Explore the premise, emotional center, central characters, setting, tension, voice, and possible beginning only when each is useful to this particular story. Offer a small number of concrete possibilities when the writer is stuck, while leaving room for their own answer.

Use this checklist to guide the conversation:
- Starting point: what the writer already has, however incomplete.
- What it is about: the premise, dramatic question, or emotional center.
- Characters: the central people or story actors and what matters about them.
- Goal and stakes: what is wanted, what pushes back, and why it matters.
- Setting: the place, time, atmosphere, and essential world rules.
- Voice and tone: viewpoint, tense, style, mood, and pacing when relevant.
- Opening direction: where the story begins and what the first passage should accomplish.

Mark a checklist entry partial when there is a useful clue but an important decision remains. After updating the checklist, ask about the most useful missing or partial entry. Do not mention the tool call.

Keep each response concise, usually two to four sentences. Do not expose fragment mechanics. The writer can open the story at any point, so help them notice important ambiguity without delaying them for completeness.`

export function createStorySetupBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const existingStory = ctx.story.name !== 'New Story' || Boolean(ctx.story.description.trim())
    ? `\n\nThis story currently has the working title "${ctx.story.name}"${ctx.story.description ? ` and description: ${ctx.story.description}` : ''}. Treat these as editable starting material.`
    : ''

  const setupFragments = ctx.storySetupFragments ?? []
  const existingFragments = setupFragments.length > 0
    ? `\n\nExisting story setup fragments follow. The writer is returning to refine the story. Preserve each storySetupKey and include the complete set in updateStorySetup unless the writer explicitly replaces an idea.\n\n${setupFragments.map(fragment => [
      `### ${fragment.name}`,
      `storySetupKey: ${fragment.meta.storySetupKey}`,
      `type: ${fragment.type}`,
      `description: ${fragment.description}`,
      fragment.content,
    ].join('\n')).join('\n\n')}`
    : ''

  const toolPolicy = ctx.storySetupReadOnly
    ? '\n\nThis is a read-only assessment turn. Before responding, call updateStorySetup exactly once with only the seven checklist entries in the listed order. The server supplies existing setup fragments; do not send story or fragments. Do not propose or save story or fragment changes. Only continue after updateStorySetup succeeds.'
    : '\n\nBefore every conversational response, call updateStorySetup exactly once with all seven checklist entries in the listed order. Omit story until there is enough information for a useful working title and description; after that, include the latest name and description on every call. The fragments array must be the complete current set of setup fragments, not only changes from the previous turn. Create or revise guideline, knowledge, character, and prose fragments as soon as the conversation supports them. Give every fragment a short lowercase key made of letters, numbers, and hyphens, and keep it unchanged when revising or renaming the fragment. Keep uncertainty visible instead of inventing a major decision. Only continue after updateStorySetup succeeds.'
  const materialPolicy = '\n\nThe existing writer-owned context blocks and fragment catalog are read-only reference material. Use them to assess checklist coverage and avoid questions the story has already answered. Do not copy them into the fragments array or assign them storySetupKey values.'
  const blocks: ContextBlock[] = [{
    id: 'story-setup-instructions',
    role: 'system',
    content: `${instructionRegistry.resolve('story-setup.system', ctx.modelId)}${existingStory}${materialPolicy}${existingFragments}${toolPolicy}`,
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
  const [context, storySetupFragments] = await Promise.all([
    buildBasePreviewContext(dataDir, storyId),
    listStorySetupFragments(dataDir, storyId),
  ])
  return {
    ...context,
    storySetupFragments,
    storySetupReadOnly: true,
  }
}
