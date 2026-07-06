import { STORY_SUMMARY_PLACEHOLDER, type ContextBlock } from '../llm/context-builder'
import {
  buildFragmentContextLanes,
  fragmentFullContextBlocksBySource,
  isBuiltinContextFragmentType,
  proseWindowBlock,
  storySummaryBlock,
} from '../llm/fragment-context-blocks'
import { selectAttentionContext } from '../llm/context-selection'
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
  const selection = selectAttentionContext(lanes, {
    runner: 'directions.suggest',
    catalogScope: 'none',
  })

  blocks.push(instructionsBlock('directions.system', ctx))

  const sysFrags = systemFragmentsBlock(ctx)
  if (sysFrags) blocks.push(sysFrags)

  blocks.push(storySummaryBlock(ctx.story.summary, {
    id: 'story-summary',
    order: 100,
    placeholder: STORY_SUMMARY_PLACEHOLDER,
  })!)

  const customLanes = lanes.filter((lane) => !isBuiltinContextFragmentType(lane.type))
  const contextTypeOrder = ['guideline', 'character', 'knowledge', ...customLanes.map((lane) => lane.type)]
  const orderedSelection = {
    ...selection,
    lanes: contextTypeOrder
      .map((type) => selection.lanes.find((lane) => lane.type === type))
      .filter((lane): lane is NonNullable<typeof lane> => Boolean(lane)),
  }

  blocks.push(...fragmentFullContextBlocksBySource({
    selection: orderedSelection,
    partitions: [
      {
        id: 'fragment-pinned',
        heading: 'Pinned Fragments',
        scope: 'pinned',
        order: 150,
        intro: 'These fragments are author-pinned standing context for any direction.',
        matches: (sources) => sources.includes('sticky'),
      },
      {
        id: 'fragment-recent',
        heading: 'Recent Fragments',
        scope: 'recent',
        order: 160,
        intro: 'These fragments are active continuity context from recent prose.',
        matches: (sources) => sources.includes('recent-context'),
      },
    ],
  }))

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
