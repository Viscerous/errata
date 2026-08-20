import {
  STORY_SUMMARY_PLACEHOLDER,
  buildContextState,
  type ContextBlock,
  type CustomFragmentGroup,
} from '../llm/context-builder'
import {
  buildFragmentContextLanes,
  canReadFragments,
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
  const canCorrectRecords = opts?.disableSuggestions !== true && hasTool('proposeRecordCorrections')
  const canCreateRecords = opts?.disableSuggestions !== true && hasTool('proposeNewRecords')
  const canSuggest = canCorrectRecords || canCreateRecords
  const canSuggestDirections = opts?.disableDirections !== true && hasTool('proposeDirections')
  const canFinish = hasTool('finishAnalysis')
  const actions: string[] = []

  // Its own step, deliberately: buried mid-paragraph in the reportAnalysis step
  // this instruction gets ignored and only the record the passage already names
  // comes back. It also comes *before* reporting, so the one batched call
  // carries the ripple IDs instead of needing a second round trip to add them.
  if (canReport) {
    actions.push('work out which existing records this passage has made inaccurate, before you report anything. Your context lists every record as `id | name | desc`. A death, departure, or reversal invalidates records the prose never names: when someone dies, the record of the person who worked under them still says they report to them, and the record of the thing they looked after still says they look after it. Read the descriptions for those ties and collect the IDs — you will pass them as candidateFragmentIds in the next step and their full text comes back numbered for correction.')
  }

  if (canReport) {
    actions.push('scan the new prose against the provided context and call **reportAnalysis** once with the prose summary, the events that make up the passage timeline, exact fragment mentions, candidateFragmentIds, temporal frame, keyed state operations, thread lifecycle and focus, explicit character knowledge changes, and other continuity signals. State memory is for conditions worth retaining after this passage leaves the recent-prose window; clear superseded keys and omit momentary pose, sensation, emotion, or completed action. A thread key names one unresolved question: resolve it when answered, never repurpose it, and let it remain dormant indefinitely when merely absent. Record character knowledge only for a fact that the prose explicitly establishes the character learned, corrected, or forgot and could later act upon; reader-visible information and a character\'s feelings are not knowledge. Reuse matching stateKey, threadKey, and knowledgeKey values from continuity memory. A genuinely new set, open, or learn operation may omit its key; the engine will derive one. Clear, advance, resolve, abandon, correct, and forget must name the existing key. A thread operation carries its own visibility; threadFocus is only for still-relevant threads this passage did not act on, cited by registry entry number. Every state, thread, or knowledge operation cites the sentence numbers in the new prose that show it — cite, never retype. A contradiction is a high-confidence conflict with a reusable non-prose record: cite the sentence numbers on both sides: in the new prose, and in the numbering of that record. A later choice, changed condition, or other chronological supersession is not a contradiction. Mentions are distinctive prose terms that identify listed fragments: direct names, nicknames, titles, roles, or key terms. Copy the exact surface text and fragment ID; first-person or third-person pronouns alone do not identify a fragment. If a surface term is ambiguous, include enough surrounding words to identify the intended fragment. This call returns the full records for anything you reported that was not already in your context, under resolvedFragments, with their sentences numbered; use them for the steps below rather than reading them again. Once is enough when the report was right: if a later step proves it wrong or incomplete, call it again with the complete corrected set rather than leaving it standing.')
  } else {
    actions.push('scan the new prose against the provided context. The reportAnalysis tool is disabled, so do not invent a replacement reporting tool.')
  }

  if (canSuggest) {
    const customTypes = opts?.customFragmentTypes ?? []
    const typeNamesList = ['characters', 'knowledge', ...customTypes.map(t => t.name.toLowerCase())].join(', ')
    const proposalActions: string[] = []
    if (canCorrectRecords) {
      proposalActions.push('Use **proposeRecordCorrections** only when accepted prose makes a specific current assertion in an existing reusable fragment inaccurate, including through ordinary story progression. Records are shown with numbered sentences: name the sentence to replace and give its corrected wording. Correct only a record you have actually been shown numbered — in your context, in a resolved report, or from **readFragments**, which numbers what it returns. Never count sentences yourself. Replace that one assertion — never restate the scene. Eligible corrections are queued even when others in the same call are rejected, so fix and resubmit only the ones reported back. Only a listed record can be corrected: a continuity memory key is not one, and changes to it belong in the reportAnalysis state, thread, or knowledge operations.')
    }
    if (canCreateRecords) {
      proposalActions.push(`Use **proposeNewRecords** only for genuinely new reusable named records in the allowed fragment types (${typeNamesList}). Cite the sentence numbers that establish it. A temporary scene label, unnamed scenery, episode recap, current condition, feeling, or interpretation is not a reusable record.`)
    }
    proposalActions.push('Each tool is optional and may be called at most once successfully. Simply do not call a tool you do not need — leave ongoing events and conditions in reportAnalysis. Only a call that failed must be retried or reported as skipped in finishAnalysis.')
    actions.push(proposalActions.join(' '))
  }
  if (canSuggestDirections) {
    actions.push('call **proposeDirections** with next directions for the story. This lane is required whenever the tool is available; when automatic directions are disabled, the tool and this instruction are both absent. Offer scene intents rather than conclusions: do not turn interpretation, temporary emotion, or an implied protagonist decision into settled psychology or canon.')
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
      customFragmentTypes: ctx.story.settings.customFragmentTypes,
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
    editable: true,
    canReadFragments: canReadFragments(ctx),
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

export const CHAT_SYSTEM_PROMPT = `
You are the Librarian, the author's story continuity assistant. Answer the author's questions and edit story fragments through tools.

## Reading

- Your context holds the story summary and fragment summaries (IDs, names, descriptions) — the full content stays on disk. Use **readFragments** to batch-read full content before relying on details or making whole-field rewrites.
- Folded current state, unresolved threads, and character knowledge stay out of the default prompt. Use **readContinuity** when the author's request actually concerns continuity.
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

1. Analyze the complete target snapshot and story context provided: prose, summary, continuity, and other fragments. Its baseHash is included with the target.
2. Batch-read any additional records you genuinely need with **readFragments**.
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

1. Analyze the complete target character snapshot provided; its baseHash is included with the target.
2. Read older relevant prose using readFragments or readProseChain only when the provided recent prose is insufficient to understand how the character actually behaves in the story — not just how they're described on paper.
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
