import {
  STORY_SUMMARY_PLACEHOLDER,
  buildContextState,
  type ContextBlock,
  type CustomFragmentGroup,
} from '../llm/context-builder'
import {
  buildFragmentContextLanes,
  customContextFragmentTypes,
  fragmentCatalogBlock,
  fragmentFullContextBlocksBySource,
  isBuiltinContextFragmentType,
  markdownSection,
  fragmentSummaryLine,
  storySummaryBlock,
} from '../llm/fragment-context-blocks'
import { contextSignalMap, selectAttentionContext } from '../llm/context-selection'
import { numberSentences } from '../llm/segments'
import { baseBlockContext, type AgentBlockContext } from '../agents/agent-block-context'
import type { Fragment, StoryMeta } from '../fragments/schema'
import { getStory, getFragment, listFragments } from '../fragments/storage'
import { getActiveProseIds } from '../fragments/prose-chain'
import { getFragmentsByTag } from '../fragments/associations'
import { instructionRegistry } from '../instructions'
import { renderSummaryProjection } from './summary-projection'
import {
  instructionsBlock,
  systemFragmentsBlock,
  storyInfoBlock,
  recentProseBlock,
  proseSummariesBlock,
  targetFragmentBlock,
  compactBlocks,
  buildBasePreviewContext,
  loadSystemPromptFragments,
} from '../agents/block-helpers'
import {
  allCharactersCatalogBlock,
  fragmentSummaryCatalogBlocks,
  pinnedFragmentCatalogBlocks,
} from '../agents/fragment-summary-blocks'
import {
  fragmentCandidateIds,
  listRoutableMemoryFragments,
  mergeFragmentCandidates,
  writerProvenanceFragmentCandidates,
} from './candidates'
import { renderContinuity, type ContinuityReader } from './continuity-view'

function continuityBlock(
  ctx: AgentBlockContext,
  reader: ContinuityReader,
  id: string,
  order: number,
): ContextBlock | null {
  const content = renderContinuity(ctx, reader)
  return content ? {
    id,
    role: 'user',
    content,
    order,
    source: 'builtin',
  } : null
}

/**
 * A full sheet whose body is sentence-numbered, so `proposeRecordCorrections`
 * can name the assertion it is replacing. Asking the model to reproduce the
 * target text instead is what stops a correction staying local; here the target
 * is addressable, and the server resolves the exact span.
 */
function renderNumberedFragmentSheet(fragment: Fragment): string {
  return markdownSection(3, fragmentSummaryLine(fragment), numberSentences(fragment.content))
}

// ─── Librarian Analyze ───

export function buildAnalyzeSystemPrompt(opts?: { 
  disableDirections?: boolean; 
  disableSuggestions?: boolean;
  disabledTools?: Iterable<string>;
  enabledTools?: Iterable<string>;
}): string {
  // Keep only cross-tool workflow here. Field semantics and retry contracts
  // belong to the tool that receives them.
  const disabledTools = new Set(opts?.disabledTools ?? [])
  const enabledTools = opts?.enabledTools ? new Set(opts.enabledTools) : null
  const hasTool = (toolName: string): boolean => enabledTools
    ? enabledTools.has(toolName)
    : !disabledTools.has(toolName)
  const canReport = hasTool('reportAnalysis')
  const canMaintainRecords = opts?.disableSuggestions !== true && (
    hasTool('proposeRecordCorrections') || hasTool('proposeNewRecords')
  )
  const canSuggestDirections = opts?.disableDirections !== true && hasTool('proposeDirections')
  const guidance: string[] = []

  if (canReport) {
    guidance.push('Before calling **reportAnalysis**, use the catalog descriptions to identify reusable records whose durable claims could materially change a finding, and include their IDs in candidateFragmentIds. If the result supplies additional record bodies, revise only findings those records change.')
  } else {
    guidance.push('Review the new prose against the supplied context without inventing a replacement reporting tool.')
  }

  if (canReport && canMaintainRecords) {
    guidance.push('Report findings before making any optional record-maintenance proposals.')
  }
  if (canSuggestDirections) {
    guidance.push('Suggest next directions only after the analysis is complete.')
  }

  return `
You are the Librarian. Analyze the new prose against the supplied story context and keep its durable records accurate.

${guidance.join('\n\n')}
`
}

export const ANALYZE_SYSTEM_PROMPT = buildAnalyzeSystemPrompt()

/**
 * Build the analyze agent's block context. Single source for both a real run and
 * the context preview, so neither can drift from the other — the only difference
 * is the input: the run passes the prose being analyzed, the preview passes the
 * latest prose with a placeholder new-prose block.
 */
export async function buildAnalyzeContext(
  dataDir: string,
  storyId: string,
  _story: StoryMeta,
  input: { proseFragment: Fragment | null; newProse: { id: string; content: string } },
): Promise<AgentBlockContext> {
  const ctxState = await buildContextState(dataDir, storyId, '', {
    excludeFragmentId: input.proseFragment?.id,
    ...(input.proseFragment ? {
      proseBeforeFragmentId: input.proseFragment.id,
    } : {}),
  })
  const effectiveStory = ctxState.story
  const allCharacters = (ctxState.allFragments ?? []).filter((fragment) => fragment.type === 'character')
  const allKnowledge = (ctxState.allFragments ?? []).filter((fragment) => fragment.type === 'knowledge')
  const allCustomFragments: CustomFragmentGroup[] = []
  for (const def of customContextFragmentTypes(effectiveStory)) {
    const fragments = (ctxState.allFragments ?? []).filter((fragment) => fragment.type === def.type)
    if (fragments.length > 0) {
      allCustomFragments.push({ ...def, fragments })
    }
  }
  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)
  return {
    // Start from centralized story context so summary-fragment migration and
    // summary loading cannot drift from the writer context.
    ...baseBlockContext(ctxState, effectiveStory),
    systemPromptFragments,
    allCharacters,
    allKnowledge,
    allCustomFragments,
    newProse: input.newProse,
    // Author-pinned characters are always-relevant, so analyze loads them in full
    // independent of what the prose context receipt recorded.
    stickyCharacters: allCharacters.filter((c) => c.sticky),
    stickyKnowledge: allKnowledge.filter((k) => k.sticky),
    recentCharacters: ctxState.recentCharacters ?? [],
    recentKnowledge: ctxState.recentKnowledge ?? [],
    recentCustomFragments: ctxState.recentCustomFragments ?? [],
  }
}

export function createLibrarianAnalyzeBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []
  const pushFragmentBlock = (block: ContextBlock | null) => {
    if (block) blocks.push(block)
  }

  blocks.push({
    id: 'instructions',
    role: 'system',
    content: buildAnalyzeSystemPrompt({
      disableDirections: ctx.story.settings?.disableLibrarianDirections === true,
      disableSuggestions: ctx.story.settings?.disableLibrarianSuggestions === true,
      disabledTools: ctx.disabledTools,
      enabledTools: ctx.enabledTools,
    }).trim(),
    order: 100,
    source: 'builtin',
  })

  const sysFrags = systemFragmentsBlock(ctx)
  if (sysFrags) blocks.push(sysFrags)

  pushFragmentBlock(storySummaryBlock(renderSummaryProjection(ctx.summaryProjection, 'librarian.analyze') ?? undefined, {
    id: 'story-summary',
    order: 100,
    placeholder: STORY_SUMMARY_PLACEHOLDER,
  }))

  const continuityMemory = continuityBlock(ctx, 'librarian.analyze', 'continuity-memory', 150)
  if (continuityMemory) blocks.push(continuityMemory)

  const lanes = buildFragmentContextLanes(ctx)
  const selection = selectAttentionContext(lanes, {
    runner: 'librarian.analyze',
    catalogScope: 'all',
  },
    contextSignalMap({
      fragmentIds: ctx.attentionCandidateIds,
      signals: ctx.attentionCandidateSignals,
    }),
  )
  const contextTypeOrder = ['character', 'knowledge', ...lanes.filter((lane) => !isBuiltinContextFragmentType(lane.type)).map((lane) => lane.type)]
  const orderedSelection = {
    ...selection,
    lanes: contextTypeOrder
      .map((type) => selection.lanes.find((lane) => lane.type === type))
      .filter((lane): lane is NonNullable<typeof lane> => Boolean(lane)),
  }

  blocks.push(...fragmentFullContextBlocksBySource({
    selection: orderedSelection,
    // Analyze-only: numbering the body lets a correction address a sentence
    // instead of retyping one. Other agents keep the plain sheet.
    renderFragment: renderNumberedFragmentSheet,
    partitions: [
      {
        id: 'fragment-pinned',
        heading: 'Pinned Fragments',
        scope: 'pinned',
        order: 195,
        intro: 'These fragments are author-pinned standing context. They are not evidence that the new prose mentions them.',
        matches: (sources) => sources.includes('sticky'),
      },
      {
        id: 'fragment-writer-context',
        heading: 'Writer Context For This Passage',
        scope: 'writer-context',
        order: 200,
        intro: 'These fragments were in the writer working set for this prose passage, either preloaded or read while drafting.',
        matches: (sources) => sources.includes('writer-context'),
      },
      {
        id: 'fragment-recent',
        heading: 'Recent Fragments',
        scope: 'recent',
        order: 205,
        intro: 'These fragments are active continuity context from the recent prose window.',
        matches: (sources) => sources.includes('recent-context'),
      },
      {
        id: 'fragment-candidates',
        heading: 'Candidate Fragments',
        scope: 'candidate',
        order: 210,
        intro: 'These fragments are candidate memory targets. Treat them as relevant context, not as confirmed prose mentions.',
        matches: (sources) => sources.includes('current-observation'),
      },
    ],
  }))

  pushFragmentBlock(fragmentCatalogBlock({
    sections: orderedSelection.lanes.map((lane) => ({
      type: lane.type,
      label: lane.label,
      fragments: lane.catalog,
    })),
    order: 390,
  }))

  if (ctx.newProse) {
    // Numbered so evidence can be a citation instead of a retyped quote.
    blocks.push({
      id: 'prose-new',
      role: 'user',
      content: markdownSection(2, 'New Prose Fragment', [
        `Fragment ID: ${ctx.newProse.id}`,
        'Sentences are numbered. Cite them by number as evidence.',
        numberSentences(ctx.newProse.content),
      ]),
      order: 400,
      source: 'builtin',
    })
  }

  return blocks
}

export async function buildAnalyzePreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const story = await getStory(dataDir, storyId)
  if (!story) throw new Error(`Story ${storyId} not found`)

  // Use the latest prose as the preview stand-in; the new-prose block is a
  // placeholder until a run fills it.
  const activeProseIds = await getActiveProseIds(dataDir, storyId)
  const latestProseId = activeProseIds.at(-1)
  const latestProse = latestProseId ? await getFragment(dataDir, storyId, latestProseId) : null

  const context = await buildAnalyzeContext(dataDir, storyId, story, {
    proseFragment: latestProse,
    newProse: { id: '(the new fragment\'s ID)', content: '(the new prose passage will appear here)' },
  })
  if (latestProse) {
    const routableFragments = await listRoutableMemoryFragments(dataDir, storyId, context.story)
    const candidates = mergeFragmentCandidates(
      writerProvenanceFragmentCandidates(context.story, latestProse, routableFragments),
    )
    context.attentionCandidateIds = fragmentCandidateIds(candidates)
    context.attentionCandidateSignals = candidates.map((candidate) => ({
      fragmentId: candidate.fragmentId,
      sources: candidate.sources,
    }))
  }
  return context
}

// ─── Librarian Chat ───

export const CHAT_SYSTEM_PROMPT = `You are the Librarian, the author's story continuity assistant. Answer questions and make only edits the author requests.

The prompt contains summaries, not every fragment's full text. Read the relevant fragments before relying on details or rewriting a whole field; use readContinuity only for current state, unresolved threads, or character knowledge. Survey first for broad changes, then batch related reads or edits.

Use editProse for active prose and editFragments for story records. Use invokeAgent for its specialist workflows and inspectRun for generation debugging. Ask when a consequential request is ambiguous. After editing, briefly explain what changed and why.`

export function createLibrarianChatBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []

  // Plugin tools reach the model via the SDK schema and honor disabledTools, so
  // they aren't enumerated here.
  blocks.push({
    id: 'instructions',
    role: 'system',
    content: instructionRegistry.resolve('librarian.chat.system'),
    order: 100,
    source: 'builtin',
  })

  const sysFrags = systemFragmentsBlock(ctx)
  if (sysFrags) {
    blocks.push(sysFrags)
  }

  blocks.push(storyInfoBlock(ctx))

  const prose = proseSummariesBlock(ctx, '## Prose Fragments (use readFragments or readProseChain to inspect)')
  if (prose) blocks.push(prose)

  blocks.push(...fragmentSummaryCatalogBlocks(ctx, { includeCustomFragments: true }))

  return blocks
}

export async function buildChatPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)
  return { ...base, systemPromptFragments }
}

// ─── Librarian Refine ───

export const REFINE_SYSTEM_PROMPT = `Refine the supplied non-prose story fragment according to the author's instructions and the provided story evidence. When no instructions are given, improve consistency, clarity, and depth while preserving established facts, voice, and style.

Read additional records only when needed, then apply the change with editFragments. Do not edit prose or archive the target unless explicitly requested. Briefly explain what changed and why.`

export function createLibrarianRefineBlocks(ctx: AgentBlockContext): ContextBlock[] {
  return compactBlocks([
    instructionsBlock('librarian.refine.system', ctx),
    storyInfoBlock(ctx),
    recentProseBlock(ctx),
    continuityBlock(ctx, 'librarian.refine', 'continuity-observations', 250),
    ...pinnedFragmentCatalogBlocks(ctx),
    targetFragmentBlock(ctx,
      'fragment to refine',
      'No specific instructions provided. Improve this fragment based on recent story events for consistency, clarity, and depth.',
    ),
  ])
}

export async function buildRefinePreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  return {
    ...base,
    targetFragment: undefined,
    instructions: '(your refinement instructions will appear here)',
  }
}

// ─── Prose Transform ───

export const PROSE_TRANSFORM_SYSTEM_PROMPT = `You transform selected spans of an author's prose.

Rules:
- Follow the requested operation exactly.
- Preserve story facts, continuity, tense, and point of view.
- Return only the transformed replacement text for the selected span — no metadata, explanations, markdown, quotes, or labels.`

export function createProseTransformBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []

  blocks.push(instructionsBlock('librarian.prose-transform.system', ctx))

  if (ctx.operation) {
    blocks.push({
      id: 'operation',
      role: 'user',
      content: markdownSection(2, 'Operation', [
        ctx.operation,
        markdownSection(3, 'Guidance', ctx.guidance || '(none)'),
      ]),
      order: 100,
      source: 'builtin',
    })
  }

  const summary = storySummaryBlock(renderSummaryProjection(ctx.summaryProjection, 'editing') ?? undefined, {
    id: 'story-summary',
    order: 200,
    placeholder: STORY_SUMMARY_PLACEHOLDER,
  })
  if (summary) blocks.push(summary)

  const stickyContext = [...ctx.stickyGuidelines, ...ctx.stickyKnowledge]
  if (stickyContext.length > 0) {
    blocks.push({
      id: 'sticky-fragments',
      role: 'user',
      content: markdownSection(2, 'Pinned Guidelines and Knowledge',
        stickyContext.map(fragment => markdownSection(3, fragment.name, fragment.content))
      ),
      order: 250,
      source: 'builtin',
    })
  }

  if (ctx.sourceContent) {
    blocks.push({
      id: 'source',
      role: 'user',
      content: markdownSection(2, 'Source Prose',
        markdownSection(3, 'Current Source', ctx.sourceContent)
      ),
      order: 300,
      source: 'builtin',
    })
  }

  if (ctx.selectedText) {
    blocks.push({
      id: 'selection',
      role: 'user',
      content: markdownSection(2, 'Selected Span', [
        markdownSection(3, 'Text to Transform', ctx.selectedText),
        markdownSection(3, 'Context Before', ctx.contextBefore?.trim() || '(none)'),
        markdownSection(3, 'Context After', ctx.contextAfter?.trim() || '(none)'),
      ]),
      order: 400,
      source: 'builtin',
    })
  }

  return blocks
}

/** Load only the pinned context needed by the single-step prose transform. */
export async function loadStickyContextFragments(
  dataDir: string,
  storyId: string,
): Promise<Pick<AgentBlockContext, 'stickyGuidelines' | 'stickyKnowledge'>> {
  const sortByOrder = (a: Fragment, b: Fragment) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)
  const [guidelines, knowledge] = await Promise.all([
    listFragments(dataDir, storyId, 'guideline'),
    listFragments(dataDir, storyId, 'knowledge'),
  ])
  return {
    stickyGuidelines: guidelines.filter(fragment => fragment.sticky).sort(sortByOrder),
    stickyKnowledge: knowledge.filter(fragment => fragment.sticky).sort(sortByOrder),
  }
}

export async function buildProseTransformPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const story = await getStory(dataDir, storyId)
  if (!story) throw new Error(`Story ${storyId} not found`)

  const stickyContext = await loadStickyContextFragments(dataDir, storyId)

  return {
    ...baseBlockContext(undefined, story),
    ...stickyContext,
    systemPromptFragments: [],
    operation: 'rewrite',
    guidance: 'Rewrite the selected span for clarity and flow while preserving the original meaning and voice.',
    selectedText: '(the selected span will appear here)',
    sourceContent: '(the surrounding fragment content will appear here)',
    contextBefore: '',
    contextAfter: '',
  }
}

// ─── Optimize Character ───

export const OPTIMIZE_CHARACTER_SYSTEM_PROMPT = `Deepen the supplied character without replacing established facts or voice. Turn bare traits into causal chains connecting physiology, social formation, and psychology to present behavior. Prefer tensions, trajectories, emotional logic, and grounded contrasts over adjective lists; treat archetypes and cultural references as seeds rather than definitions.

Use the target snapshot and story evidence. Read older prose only when the recent context cannot show how the character behaves. Rewrite the complete character content with editFragments and its baseHash, leaving prose and archive state untouched. Briefly explain the dimensions and causal links you strengthened.`

export function createOptimizeCharacterBlocks(ctx: AgentBlockContext): ContextBlock[] {
  return compactBlocks([
    instructionsBlock('librarian.optimize-character.system', ctx),
    storyInfoBlock(ctx),
    recentProseBlock(ctx),
    continuityBlock(ctx, 'librarian.optimize-character', 'continuity-observations', 250),
    ...pinnedFragmentCatalogBlocks(ctx, { includeCharacters: false }),
    allCharactersCatalogBlock(ctx),
    targetFragmentBlock(ctx,
      'character to optimize',
      'No specific instructions provided. Optimize this character for depth, causality, and friction using the methodology.',
    ),
  ])
}

export async function buildOptimizeCharacterPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  const allCharacters = (base.allFragments ?? []).filter((fragment) => fragment.type === 'character')
  return {
    ...base,
    allCharacters,
    targetFragment: undefined,
    instructions: '(your optimization instructions will appear here)',
  }
}
