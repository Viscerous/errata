import type { ContextBlock } from '../llm/context-builder'
import {
  fragmentFullContextBlock,
  joinMarkdownBlocks,
  markdownSection,
  renderFullFragmentSheet,
  STORY_SUMMARY_HEADING,
} from '../llm/fragment-context-blocks'
import type { AgentBlockContext } from '../agents/agent-block-context'
import { instructionRegistry } from '../instructions'
import { buildBasePreviewContext, renderProseSummariesText } from '../agents/block-helpers'
import { pinnedFragmentCatalogBlocks } from '../agents/fragment-summary-blocks'

export function createCharacterChatBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []
  const characterName = ctx.character?.name ?? 'the character'
  const systemTemplate = instructionRegistry.resolve('character-chat.system', ctx.modelId)
  const instructionsTemplate = instructionRegistry.resolve('character-chat.instructions', ctx.modelId)

  blocks.push({
    id: 'instructions',
    role: 'system',
    content: [
      systemTemplate.replace(/\{\{characterName\}\}/g, characterName),
      '',
      instructionsTemplate.replace(/\{\{characterName\}\}/g, characterName),
    ].join('\n'),
    order: 100,
    source: 'builtin',
  })

  if (ctx.character) {
    const characterBlock = fragmentFullContextBlock({
      id: 'character',
      heading: 'Character',
      sections: [{
        type: 'character',
        label: 'Character',
        fragments: [ctx.character],
      }],
      scope: 'all',
      order: 100,
      intro: 'This is the full character sheet for the person you are roleplaying.',
      renderFragment: renderFullFragmentSheet,
    })
    if (characterBlock) blocks.push(characterBlock)
  }

  if (ctx.personaDescription) {
    blocks.push({
      id: 'persona',
      role: 'user',
      content: markdownSection(2, 'Who You Are Speaking With', ctx.personaDescription),
      order: 200,
      source: 'builtin',
    })
  }

  const storyParts = [`Name: ${ctx.story.name}`]
  if (ctx.story.description.trim()) {
    storyParts.push(`Description: ${ctx.story.description}`)
  }
  const storyContextParts: string[] = [
    markdownSection(3, 'Story', storyParts.join('\n')),
  ]
  if (ctx.story.summary) {
    storyContextParts.push(markdownSection(3, STORY_SUMMARY_HEADING, ctx.story.summary))
  }

  if (ctx.proseFragments.length > 0) {
    const content = renderProseSummariesText(ctx.proseFragments, 'Use readFragments or readProseChain to inspect full prose.')
    storyContextParts.push(markdownSection(3, 'Story Events', content))
  }

  blocks.push({
    id: 'story-context',
    role: 'user',
    content: markdownSection(2, 'Story Context', joinMarkdownBlocks(storyContextParts)),
    order: 300,
    source: 'builtin',
  })

  blocks.push(...pinnedFragmentCatalogBlocks(ctx, {
    excludeIds: ctx.character ? [ctx.character.id] : [],
  }))

  return blocks
}

export async function buildCharacterChatPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  return {
    ...base,
    character: undefined,
    personaDescription: 'You are speaking with a stranger you have just met. You do not know who they are.',
  }
}
