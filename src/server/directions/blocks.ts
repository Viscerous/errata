import { STORY_SUMMARY_PLACEHOLDER, type ContextBlock } from '../llm/context-builder'
import {
  buildFragmentContextLanes,
  canReadFragments,
  fragmentCatalogBlock,
  fragmentFullContextBlocksBySource,
  isBuiltinContextFragmentType,
  proseWindowBlock,
  storySummaryBlock,
} from '../llm/fragment-context-blocks'
import { selectAttentionContext } from '../llm/context-selection'
import { renderContinuity } from '../librarian/continuity-view'
import type { AgentBlockContext } from '../agents/agent-block-context'
import {
  instructionsBlock,
  buildBasePreviewContext,
} from '../agents/block-helpers'

export const DIRECTIONS_SYSTEM_PROMPT = `You are a story development editor. Propose distinct, compelling directions the narrative could take next. Give each direction a short evocative title, a brief description, and a detailed instruction prompt a prose writer could follow directly.`

export function createDirectionsSuggestBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []
  const lanes = buildFragmentContextLanes(ctx)
  const selection = selectAttentionContext(lanes, {
    runner: 'directions.suggest',
    // A direction that only ever engages what the last few passages happened to
    // mention is a direction that can never reintroduce anyone. The catalog is
    // the story's cast and lore by name — enough to propose bringing something
    // back, not enough to invent its details.
    catalogScope: 'available',
  })

  blocks.push(instructionsBlock('directions.system', ctx))

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

  // Named, not detailed: these rows exist so a direction can reach past the
  // recent window. Directions runs with no tools, so the note derived here is
  // the one that does not point at a call it cannot make.
  {
    const catalog = fragmentCatalogBlock({
      sections: orderedSelection.lanes.map((lane) => ({
        type: lane.type,
        label: lane.label,
        fragments: lane.catalog,
      })),
      order: 250,
      heading: 'Also In This Story',
      scope: 'available',
      canReadFragments: canReadFragments(ctx),
    })
    if (catalog) blocks.push(catalog)
  }

  // Directions set macro trajectory, so they must not be proposed against a
  // less-informed picture than the Writer's. Timeline 8 recorded exactly that
  // failure: a direction generated without a record the following Writer had.
  const continuity = renderContinuity(ctx, 'directions.suggest')
  if (continuity) {
    blocks.push({
      id: 'continuity-observations',
      role: 'user',
      content: continuity,
      order: 200,
      source: 'builtin',
    })
  }

  // The author's configured prose window, which is the same window the Writer
  // gets — the parity the continuity block above exists to preserve. A hardcoded
  // slice(-3) here quietly broke it in the other direction: a no-op below three
  // passages, a silent truncation above.
  {
    const prose = proseWindowBlock(ctx.proseFragments, { order: 300 })
    if (prose) blocks.push(prose)
  }

  return blocks
}

export async function buildDirectionsPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  return buildBasePreviewContext(dataDir, storyId)
}
