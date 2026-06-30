import type { ContextBlock } from '../llm/context-builder'
import { renderFragmentContextGroup, storyHeaderContent, STORY_SUMMARY_HEADING } from '../llm/fragment-context-blocks'
import type { AgentBlockContext } from '../agents/agent-block-context'
import { instructionRegistry } from '../instructions'
import { buildBasePreviewContext } from '../agents/block-helpers'
import { pinnedFragmentSummaryGroups } from '../agents/fragment-summary-blocks'

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
    blocks.push({
      id: 'character',
      role: 'user',
      content: [
        `## Character: ${ctx.character.name}`,
        '',
        '## Character Details',
        ctx.character.content,
        '',
        '## Character Description',
        ctx.character.description,
      ].join('\n'),
      order: 100,
      source: 'builtin',
    })
  }

  if (ctx.personaDescription) {
    blocks.push({
      id: 'persona',
      role: 'user',
      content: [
        '## Who You Are Speaking With',
        ctx.personaDescription,
      ].join('\n'),
      order: 200,
      source: 'builtin',
    })
  }

  // Story context + instructions
  const storyContextParts: string[] = []
  storyContextParts.push(storyHeaderContent(ctx.story))
  if (ctx.story.summary) {
    storyContextParts.push(`\n## ${STORY_SUMMARY_HEADING}\n${ctx.story.summary}`)
  }

  // Prose summaries (inline — character chat bundles everything into one block)
  if (ctx.proseFragments.length > 0) {
    storyContextParts.push('\n## Story Events (use readFragments or readProseChain to inspect full prose)')
    for (const p of ctx.proseFragments) {
      if ((p.meta._librarian as { summary?: string })?.summary) {
        storyContextParts.push(`- ${p.id}: ${(p.meta._librarian as { summary?: string }).summary}`)
      } else if (p.content.length < 600) {
        storyContextParts.push(`- ${p.id}: \n${p.content}`)
      } else {
        storyContextParts.push(`- ${p.id}: ${p.content.slice(0, 500).replace(/\n/g, ' ')}... [truncated]`)
      }
    }
  }

  // Pinned fragment summaries, split by type so summary indexes cannot read as full sheets.
  const pinnedSummaryGroups = pinnedFragmentSummaryGroups(ctx, {
    excludeIds: ctx.character ? [ctx.character.id] : [],
  })
  for (const group of pinnedSummaryGroups) {
    storyContextParts.push(`\n${renderFragmentContextGroup(group)}`)
  }

  blocks.push({
    id: 'story-context',
    role: 'user',
    content: [
      '## Story Context',
      storyContextParts.join('\n'),
    ].join('\n'),
    order: 300,
    source: 'builtin',
  })

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
