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
  renderFullFragmentSheet,
  storySummaryBlock,
} from '../llm/fragment-context-blocks'
import { contextSignalMap, selectAttentionContext } from '../llm/context-selection'
import { baseBlockContext, type AgentBlockContext } from '../agents/agent-block-context'
import type { Fragment, StoryMeta } from '../fragments/schema'
import { getStory, listFragments, getFragment } from '../fragments/storage'
import { getActiveProseIds } from '../fragments/prose-chain'
import { getFragmentsByTag } from '../fragments/associations'
import { instructionRegistry } from '../instructions'
import { OPERATION_GUIDANCE } from '../fragments/change-operations'
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

// ─── Librarian Analyze ───

export function buildAnalyzeSystemPrompt(opts?: { 
  disableDirections?: boolean; 
  disableSuggestions?: boolean;
  disabledTools?: Iterable<string>;
  enabledTools?: Iterable<string>;
  customFragmentTypes?: Array<{ type: string; name: string }>;
}): string {
  // An explicit, ordered procedure: it keeps the step-by-step robustness of a
  // checklist while leaving each tool's parameters to its schema (no catalog to
  // drift). Steps for disabled tools are omitted and the rest are worded as an
  // ordered sequence, so the final enabled action is semantically terminal
  // without adding a separate "say nothing" instruction.
  const disabledTools = new Set(opts?.disabledTools ?? [])
  const enabledTools = opts?.enabledTools ? new Set(opts.enabledTools) : null
  const hasTool = (toolName: string): boolean => enabledTools
    ? enabledTools.has(toolName)
    : !disabledTools.has(toolName)
  const canReport = hasTool('reportAnalysis')
  const canSuggest = opts?.disableSuggestions !== true && hasTool('proposeFragmentChanges')
  const canReadFragments = canSuggest && hasTool('readFragments')
  const canSuggestDirections = opts?.disableDirections !== true && hasTool('proposeDirections')
  const canFinish = hasTool('finishAnalysis')
  const actions: string[] = []

  actions.push(canReport
    ? 'scan the new prose against the provided context and call **reportAnalysis** once with the prose summary, exact fragment mentions, durable-memory candidateFragmentIds, and continuity signals. Mentions must use the fragment\'s exact ID plus exact prose text: a direct name, nickname, title, role, or distinctive key term; never a bare pronoun ("I", "she", "they"). If a surface term is ambiguous, include enough surrounding words to identify the intended fragment.'
    : 'scan the new prose against the provided context. The reportAnalysis tool is disabled, so do not invent a replacement reporting tool.')

  if (canSuggest) {
    const customTypes = opts?.customFragmentTypes ?? []
    const typeNamesList = ['characters', 'knowledge', ...customTypes.map(t => t.name.toLowerCase())].join(', ')
    const readGuidance = canReadFragments
      ? 'read any fragment that is not already shown in full before proposing edits, or when validation asks for current content/baseHash.'
      : 'use only fragments already shown in full when proposing edits; readFragments is disabled.'
    actions.push(`${readGuidance} Use **proposeFragmentChanges** to update existing fragments when the prose changes a lasting fact (such as changes to state, location, relationships, allegiances, or titles) — keep edits minimal — and to create genuinely new ${typeNamesList}.`)
  }
  if (canSuggestDirections) {
    actions.push('call **proposeDirections** with next directions for the story.')
  }
  if (canFinish) {
    actions.push('call **finishAnalysis** upon completion of all steps.')
  }

  const sentenceCase = (action: string): string => action.charAt(0).toUpperCase() + action.slice(1)
  const steps = actions.map((action, index) => {
    if (index === actions.length - 1) return `Finally, ${action}`
    return sentenceCase(action)
  })
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n')

  return `
You are the Librarian: you keep the records of an ongoing story accurate and its continuity intact. Analyze the new prose fragment against the story context provided.

## Steps

Work through these steps in order:
${numbered}
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
  })
  const effectiveStory = ctxState.story
  const allCharacters = await listFragments(dataDir, storyId, 'character')
  const allKnowledge = await listFragments(dataDir, storyId, 'knowledge')
  const allCustomFragments: CustomFragmentGroup[] = []
  for (const def of customContextFragmentTypes(effectiveStory)) {
    const fragments = await listFragments(dataDir, storyId, def.type)
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
    // independent of what the prose forwarded (writerContextIds).
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
      customFragmentTypes: ctx.story.settings.customFragmentTypes,
    }).trim(),
    order: 100,
    source: 'builtin',
  })

  const sysFrags = systemFragmentsBlock(ctx)
  if (sysFrags) blocks.push(sysFrags)

  pushFragmentBlock(storySummaryBlock(ctx.story.summary, {
    id: 'story-summary',
    order: 100,
    placeholder: STORY_SUMMARY_PLACEHOLDER,
  }))

  const lanes = buildFragmentContextLanes(ctx)
  const selection = selectAttentionContext(lanes, {
    runner: 'librarian.analyze',
    catalogScope: 'all',
    fullSignalSources: ['writer-context', 'current-observation', 'router'],
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
    renderFragment: renderFullFragmentSheet,
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
        matches: (sources) => sources.includes('current-observation') || sources.includes('router'),
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
    editable: true,
  }))

  if (ctx.newProse) {
    blocks.push({
      id: 'prose-new',
      role: 'user',
      content: markdownSection(2, 'New Prose Fragment', [
        `Fragment ID: ${ctx.newProse.id}`,
        ctx.newProse.content,
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

export const CHAT_SYSTEM_PROMPT = `
You are the Librarian, the author's story continuity assistant. Answer the author's questions and edit story fragments through tools.

## Reading

- Your context holds the story summary and fragment summaries (IDs, names, descriptions) — the full content stays on disk. Use **readFragments** to batch-read full content before relying on details or making whole-field rewrites.
- For sweeping requests (e.g., "update all characters to reflect the time skip"), survey first with **listFragments**, **findFragments**, and **readFragments**, then edit in one batch.

## Editing

Edits apply immediately, so make them only when the author asked for the change.

- Prose edits: **editProse** — it scans active prose automatically, applies exact diffs, and returns them.
- Character, guideline, knowledge, summary, or custom fragments: **editFragments**. ${OPERATION_GUIDANCE} A whole-field rewrite must contain the complete final field text from the fragment you read.
- New fragments: **editFragments** with create_fragment operations and plain fragment names; the system assigns IDs.
- Keep fragment descriptions within the 250 character limit.

## Conduct

- Batch related reads and edits into one tool call.
- Ask a clarifying question when the request is ambiguous.
- After editing, tell the author what changed and why — they can undo it.
- For specialist workflows use **invokeAgent**; for generation debugging use **inspectRun**.

`

export function createLibrarianChatBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []

  // Plugin tools reach the model via the SDK schema and honor disabledTools, so
  // they aren't enumerated here.
  blocks.push({
    id: 'instructions',
    role: 'system',
    content: instructionRegistry.resolve('librarian.chat.system', ctx.modelId),
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

export const REFINE_SYSTEM_PROMPT = `You are a story editor refining a single fragment of an ongoing story. Improve the target fragment based on the story context. Your scope is character, guideline, knowledge, and custom fragments only — prose fragments stay untouched, and archiving requires an explicit request from the author.

## Instructions

1. First, read the target fragment using **readFragments** so you have its baseHash.
2. Analyze the story context provided: prose, summary, and other fragments.
3. Use **editFragments** to apply your edits. ${OPERATION_GUIDANCE}
4. Explain what you changed and why in your text response.

## Guidelines for Refinement

- When the author gives specific instructions, follow them precisely.
- When no instructions are given, improve the fragment for consistency, clarity, and depth based on story events.
- Preserve the fragment's existing voice and style unless asked otherwise.
- Keep descriptions within the 250 character limit.
- For set_fields, include baseHash and write each changed field as the complete final value. Prefer localized operations for specific sentences, paragraphs, insertions, or end appends.`

export function createLibrarianRefineBlocks(ctx: AgentBlockContext): ContextBlock[] {
  return compactBlocks([
    instructionsBlock('librarian.refine.system', ctx),
    storyInfoBlock(ctx),
    recentProseBlock(ctx),
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

  const summary = storySummaryBlock(ctx.story.summary, {
    id: 'story-summary',
    order: 200,
    placeholder: STORY_SUMMARY_PLACEHOLDER,
  })
  if (summary) blocks.push(summary)

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

export async function buildProseTransformPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const story = await getStory(dataDir, storyId)
  if (!story) throw new Error(`Story ${storyId} not found`)

  return {
    ...baseBlockContext(undefined, story),
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

export const OPTIMIZE_CHARACTER_SYSTEM_PROMPT = `You are a character development specialist. Rewrite the target character fragment so it has genuine depth, causality, and texture, following the methodology below.

## Methodology

**Causality over traits.** Every trait must have a WHY — upbringing, trauma, formative events. "Brave" becomes "reckless courage born from watching her mother die doing nothing." Traits without cause are lumber on the ground; traits with cause are architecture.

**Egri's three dimensions.** A complete character lives across three layers:
- Physiological: Body, appearance, health, mannerisms shaped by physicality. "Because he is tall, he's used to ducking through doors and looking down at people, which makes him feel subconsciously dominant."
- Sociological: Class, education, culture, family, profession — the soil the person grew in. Being a nerd from Detroit dictates taste in cars and music. The environment shapes vocabulary, values, and blind spots.
- Psychological: Drives, fears, moral code, coping mechanisms — the engine that makes choices. A character who is "kind" but grew up "poor and bullied" will be kind in a very specific, perhaps defensive or over-compensatory way.

**Friction and tension.** Internal contradictions make characters feel alive. A pacifist with a violent temper. A healer who enjoys others' pain. Someone who forces a bubbly personality to hide deep discomfort with emotional closeness. The mask versus the truth creates ongoing dramatic potential.

**Vectors, not adjectives.** Express traits as trajectories with momentum — "becoming disillusioned with authority" rather than "rebellious." Characters are in motion, not frozen snapshots. Write the launch pad the story builds from.

**Irrational choices.** Real people make decisions rooted in emotion, trauma, pride — not optimal strategy. Document the emotional logic behind bad decisions. A man who hates a specific band because one album reminds him of a terrible restaurant job — people are irrational like that, and those reasons create texture.

**Contrast.** Unexpected combinations that create texture — gentle giant, eloquent thug, cowardly genius. The gap between expectation and reality is where interesting writing lives. Multiple dimensions make a character more stable, not less.

**References as sprinkles.** Archetypes, real-world references, and cultural touchstones are starting points, never destinations. "Columbo-like disarming manner" is a seed that orients the reader, not a character definition. Use musicians instead of specific songs, directors instead of every movie — unless a specific reference carries causal weight.

## Instructions

1. Read the target character fragment using readFragments so you have its baseHash.
2. Read relevant prose fragments using readFragments or readProseChain to understand how the character actually behaves in the story — not just how they're described on paper.
3. Analyze gaps between the current fragment and the methodology above. Where are there bare adjectives without cause? Where is friction missing? Which of Egri's dimensions are underdeveloped?
4. Rewrite the character fragment with depth and causality. Build the ramp of how this person grew up and why they think the way they do. Preserve existing voice and any details that already have depth — improve, don't replace what works.
5. Use editFragments with set_fields and the baseHash to apply the rewrite. Write the full final character sheet as the content field. Keep descriptions within the 250 character limit.
6. Explain what you changed and why — which dimensions you developed, what friction you introduced, what causal chains you built.

Your scope is the character fragment alone: deepen it, leave prose fragments untouched, and keep it active (archiving is out of scope).`

export function createOptimizeCharacterBlocks(ctx: AgentBlockContext): ContextBlock[] {
  return compactBlocks([
    instructionsBlock('librarian.optimize-character.system', ctx),
    storyInfoBlock(ctx),
    recentProseBlock(ctx),
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
  const allCharacters = await listFragments(dataDir, storyId, 'character')
  return {
    ...base,
    allCharacters,
    targetFragment: undefined,
    instructions: '(your optimization instructions will appear here)',
  }
}
