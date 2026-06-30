import { STORY_SUMMARY_PLACEHOLDER, type ContextBlock } from '../llm/context-builder'
import {
  buildFragmentContextLanes,
  findFragmentContextLane,
  isBuiltinContextFragmentType,
  proseWindowBlock,
  renderContextFragment,
  storySummaryBlock,
} from '../llm/fragment-context-blocks'
import type { AgentBlockContext } from '../agents/agent-block-context'
import { getFragment } from '../fragments/storage'
import { getFragmentsByTag } from '../fragments/associations'
import {
  instructionsBlock,
  systemFragmentsBlock,
  buildBasePreviewContext,
  loadSystemPromptFragments,
} from '../agents/block-helpers'

export const DIRECTIONS_SYSTEM_PROMPT = `You are a story development editor. Propose distinct, compelling directions the narrative could take next. Give each direction a short evocative title, a brief description, and a detailed instruction prompt a prose writer could follow directly.`

export function createDirectionsSuggestBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []
  const lanes = buildFragmentContextLanes(ctx)
  const knowledgeLane = findFragmentContextLane(lanes, 'knowledge')
  const characterLane = findFragmentContextLane(lanes, 'character')

  blocks.push(instructionsBlock('directions.system', ctx))

  const sysFrags = systemFragmentsBlock(ctx)
  if (sysFrags) blocks.push(sysFrags)

  blocks.push(storySummaryBlock(ctx.story.summary, {
    id: 'story-summary',
    order: 100,
    placeholder: STORY_SUMMARY_PLACEHOLDER,
  })!)

  // Sticky guidelines are the story's binding rules (tone, POV, boundaries);
  // suggested directions should stay within them.
  if (ctx.stickyGuidelines.length > 0) {
    blocks.push({
      id: 'guidelines',
      role: 'user',
      content: ['## Guidelines', ...ctx.stickyGuidelines.map(renderContextFragment)].join('\n\n'),
      order: 150,
      source: 'builtin',
    })
  }

  if ((characterLane?.sticky.length ?? 0) > 0 || (characterLane?.available.length ?? 0) > 0) {
    const chars = [...(characterLane?.sticky ?? []), ...(characterLane?.available ?? [])]
    const unique = chars.filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
    if (unique.length > 0) {
      blocks.push({
        id: 'characters',
        role: 'user',
        content: ['## Characters', ...unique.map(renderContextFragment)].join('\n\n'),
        order: 200,
        source: 'builtin',
      })
    }
  }

  if ((knowledgeLane?.sticky.length ?? 0) > 0) {
    blocks.push({
      id: 'knowledge-sticky',
      role: 'user',
      content: ['## Pinned Knowledge', ...knowledgeLane!.sticky.map(renderContextFragment)].join('\n\n'),
      order: 245,
      source: 'builtin',
    })
  }

  if ((knowledgeLane?.recent.length ?? 0) > 0) {
    blocks.push({
      id: 'knowledge-recent',
      role: 'user',
      content: ['## Knowledge in Recent Prose', ...knowledgeLane!.recent.map(renderContextFragment)].join('\n\n'),
      order: 248,
      source: 'builtin',
    })
  }

  const customLanes = lanes.filter((lane) => !isBuiltinContextFragmentType(lane.type))
  const stickyCustomFragments = customLanes.flatMap((lane) => lane.sticky)
  if (stickyCustomFragments.length > 0) {
    blocks.push({
      id: 'custom-sticky',
      role: 'user',
      content: [
        '## Pinned Custom Context',
        ...stickyCustomFragments.map(renderContextFragment),
      ].join('\n\n'),
      order: 250,
      source: 'builtin',
    })
  }

  let customOrder = 255
  for (const lane of customLanes) {
    if (lane.recent.length === 0) continue
    blocks.push({
      id: `${lane.type}-recent`,
      role: 'user',
      content: [
        `## ${lane.label} in Recent Prose`,
        ...lane.recent.map(renderContextFragment),
      ].join('\n\n'),
      order: customOrder++,
      source: 'builtin',
    })
  }

  {
    const prose = proseWindowBlock(ctx.proseFragments.slice(-3), { order: 300 })
    if (prose) blocks.push(prose)
  }

  return blocks
}

export async function buildDirectionsPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)
  return { ...base, systemPromptFragments }
}
