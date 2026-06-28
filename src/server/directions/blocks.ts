import { renderContextFragment, type ContextBlock } from '../llm/context-builder'
import type { AgentBlockContext } from '../agents/agent-block-context'
import { getFragment } from '../fragments/storage'
import { getFragmentsByTag } from '../fragments/associations'
import {
  instructionsBlock,
  systemFragmentsBlock,
  buildBasePreviewContext,
  loadSystemPromptFragments,
} from '../agents/block-helpers'

export const DIRECTIONS_SYSTEM_PROMPT = `You are a creative writing assistant that suggests possible story directions. Propose distinct and compelling directions the narrative could take. Each suggestion should have a short evocative title, a brief description, and a detailed instruction prompt suitable for a writer.`

function renderFullFragment(fragment: Parameters<typeof renderContextFragment>[0]): string {
  return `[@fragment=${fragment.id}]\n${renderContextFragment(fragment)}`
}

export function createDirectionsSuggestBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []

  blocks.push(instructionsBlock('directions.system', ctx))

  const sysFrags = systemFragmentsBlock(ctx)
  if (sysFrags) blocks.push(sysFrags)

  blocks.push({
    id: 'story-summary',
    role: 'user',
    content: `## Story Summary\n${ctx.story.summary || '(No summary yet.)'}`,
    order: 100,
    source: 'builtin',
  })

  // Sticky guidelines are the story's binding rules (tone, POV, boundaries);
  // suggested directions should stay within them.
  if (ctx.stickyGuidelines.length > 0) {
    blocks.push({
      id: 'guidelines',
      role: 'user',
      content: `## Guidelines\n${ctx.stickyGuidelines.map(g => `### ${g.name}\n${g.content}`).join('\n\n')}`,
      order: 150,
      source: 'builtin',
    })
  }

  if (ctx.stickyCharacters.length > 0 || ctx.characterShortlist.length > 0) {
    const chars = [...ctx.stickyCharacters, ...ctx.characterShortlist]
    const unique = chars.filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
    if (unique.length > 0) {
      blocks.push({
        id: 'characters',
        role: 'user',
        content: `## Characters\n${unique.map(c => `### ${c.name}\n${c.content}`).join('\n\n')}`,
        order: 200,
        source: 'builtin',
      })
    }
  }

  if (ctx.stickyKnowledge.length > 0) {
    blocks.push({
      id: 'knowledge-sticky',
      role: 'user',
      content: `## Pinned Knowledge\n${ctx.stickyKnowledge.map(k => `### ${k.name}\n${k.content}`).join('\n\n')}`,
      order: 245,
      source: 'builtin',
    })
  }

  if (ctx.recentKnowledge && ctx.recentKnowledge.length > 0) {
    blocks.push({
      id: 'knowledge-recent',
      role: 'user',
      content: `## Knowledge in Recent Prose\n${ctx.recentKnowledge.map(k => `### ${k.name}\n${k.content}`).join('\n\n')}`,
      order: 248,
      source: 'builtin',
    })
  }

  if ((ctx.stickyCustomFragments ?? []).length > 0) {
    blocks.push({
      id: 'custom-sticky',
      role: 'user',
      content: [
        '## Pinned Custom Context',
        ...(ctx.stickyCustomFragments ?? []).map(renderFullFragment),
      ].join('\n\n'),
      order: 250,
      source: 'builtin',
    })
  }

  let customOrder = 255
  for (const group of ctx.recentCustomFragments ?? []) {
    blocks.push({
      id: `${group.type}-recent`,
      role: 'user',
      content: [
        `## ${group.name} in Recent Prose`,
        ...group.fragments.map(renderFullFragment),
      ].join('\n\n'),
      order: customOrder++,
      source: 'builtin',
    })
  }

  if (ctx.proseFragments.length > 0) {
    const recentProse = ctx.proseFragments.slice(-3)
    blocks.push({
      id: 'prose-recent',
      role: 'user',
      content: `## Recent Prose\n${recentProse.map(f => f.content).join('\n\n---\n\n')}`,
      order: 300,
      source: 'builtin',
    })
  }

  return blocks
}

export async function buildDirectionsPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)
  return { ...base, systemPromptFragments }
}
