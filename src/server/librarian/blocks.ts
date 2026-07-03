import {
  STORY_SUMMARY_PLACEHOLDER,
  buildContextState,
  type ContextBlock,
  type CustomFragmentGroup,
} from '../llm/context-builder'
import {
  buildFragmentContextLanes,
  customContextFragmentTypes,
  findFragmentContextLane,
  fragmentContextBlock,
  isBuiltinContextFragmentType,
  renderFullFragmentSheet,
  storySummaryBlock,
} from '../llm/fragment-context-blocks'
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
  allCharactersBlock,
  fragmentSummaryCatalogBlocks,
  pinnedFragmentSummaryBlocks,
} from '../agents/fragment-summary-blocks'

// ─── Librarian Analyze ───

export function buildAnalyzeSystemPrompt(opts?: { 
  disableDirections?: boolean; 
  disableSuggestions?: boolean;
  customFragmentTypes?: Array<{ type: string; name: string }>;
}): string {
  // An explicit, ordered procedure: it keeps the step-by-step robustness of a
  // checklist while leaving each tool's parameters to its schema (no catalog to
  // drift). Steps for disabled tools are omitted and the rest renumber, so the
  // prompt never names a tool the model wasn't given.
  const steps: string[] = [
    'Scan the new prose against every fragment in your context and call **reportAnalysis** once with everything you find. Report each mention as the fragment\'s exact ID plus the exact text used in the prose — a direct name, nickname, title, role, or distinctive key term. When an ambiguous word refers to two entities, report a longer, unique surrounding phrase for each. Never report a bare pronoun ("I", "she", "they") as mention text — an entity the passage refers to only by pronoun gets no mention.',
  ]
  if (!opts?.disableSuggestions) {
    const customTypes = opts?.customFragmentTypes ?? []
    const typeNamesList = ['characters', 'knowledge', ...customTypes.map(t => t.name.toLowerCase())].join(', ')
    steps.push(`Use **proposeFragmentChanges** to update existing fragments when the prose changes a lasting fact (state, allegiance, title, location, relationships) — keep edits minimal — and to create genuinely new ${typeNamesList} with create_fragment operations using plain fragment names; IDs are assigned by the system.`)
  }
  if (!opts?.disableDirections) {
    steps.push('Call **proposeDirections** with next directions for the story.')
  }
  steps.push('Finish with the exact text "Analysis complete" and nothing else.')
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
 * The characters the writer worked from on a prose fragment, resolved to full
 * fragments from its forwarded `writerContextIds`. Shared by the analyze run and
 * its context preview so both populate the character-recent block the same way.
 */
export function recentCastFromFragment(allCharacters: Fragment[], fragment: Fragment | null | undefined): Fragment[] {
  const ids = new Set(
    Array.isArray(fragment?.meta?.writerContextIds) ? (fragment.meta.writerContextIds as string[]) : [],
  )
  return allCharacters.filter((c) => ids.has(c.id))
}

/**
 * Build the analyze agent's block context. Single source for both a real run and
 * the context preview, so neither can drift from the other — the only difference
 * is the input: the run passes the prose being analyzed, the preview passes the
 * latest prose (for the recent cast) with a placeholder new-prose block.
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
    recentCharacters: recentCastFromFragment(allCharacters, input.proseFragment),
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

  // Pinned and recent characters are preloaded in full so edits land on the
  // current sheet; everyone else stays a one-line summary (readFragments reads any
  // in full). Each character lands in exactly one block: pinned takes precedence,
  // then recent, then the shortlist.
  const lanes = buildFragmentContextLanes(ctx)
  const characterLane = findFragmentContextLane(lanes, 'character')
  const sticky = characterLane?.sticky ?? []
  const stickyIds = new Set(sticky.map((c) => c.id))
  const recent = characterLane?.recent ?? []
  const recentIds = new Set(recent.map((c) => c.id))

  // Author-pinned, always-relevant — full and in their own block whether or not
  // they also appear in the recent prose, so a pin reliably shows up here.
  if (sticky.length > 0) {
    pushFragmentBlock(fragmentContextBlock({
      id: 'character-sticky',
      type: 'character',
      label: 'Characters',
      fragments: sticky,
      mode: 'full',
      scope: 'pinned',
      order: 195,
      heading: 'Pinned Characters',
      renderFragment: renderFullFragmentSheet,
      separator: '\n\n',
    }))
  }

  const recentNonPinned = recent.filter((c) => !stickyIds.has(c.id))
  if (recentNonPinned.length > 0) {
    pushFragmentBlock(fragmentContextBlock({
      id: 'character-recent',
      type: 'character',
      label: 'Characters',
      fragments: recentNonPinned,
      mode: 'full',
      scope: 'recent',
      order: 200,
      renderFragment: renderFullFragmentSheet,
      separator: '\n\n',
    }))
  }

  const shortlistCharacters = (characterLane?.all ?? []).filter((c) => !stickyIds.has(c.id) && !recentIds.has(c.id))
  pushFragmentBlock(fragmentContextBlock({
    id: 'character-shortlist',
    type: 'character',
    label: 'Characters',
    fragments: shortlistCharacters,
    mode: 'summary-index',
    scope: 'available',
    order: 210,
    editable: true,
  }))

  const allKnowledge = findFragmentContextLane(lanes, 'knowledge')?.all ?? []
  if (allKnowledge.length > 0) {
    // Knowledge is delivered in full (bounded, read-mostly — analyze checks
    // contradictions against it).
    pushFragmentBlock(fragmentContextBlock({
      id: 'knowledge',
      type: 'knowledge',
      label: 'Knowledge',
      fragments: allKnowledge,
      mode: 'full',
      scope: 'all',
      order: 300,
      renderFragment: renderFullFragmentSheet,
      separator: '\n\n',
    }))
  }

  let customOrder = 320
  for (const lane of lanes) {
    if (isBuiltinContextFragmentType(lane.type)) continue
    pushFragmentBlock(fragmentContextBlock({
      id: `${lane.type}-shortlist`,
      type: lane.type,
      label: lane.label,
      fragments: lane.all,
      mode: 'summary-index',
      scope: 'available',
      order: customOrder++,
      editable: true,
    }))
  }

  if (ctx.newProse) {
    blocks.push({
      id: 'prose-new',
      role: 'user',
      content: [
        '## New Prose Fragment',
        `Fragment ID: ${ctx.newProse.id}`,
        ctx.newProse.content,
      ].join('\n'),
      order: 400,
      source: 'builtin',
    })
  }

  return blocks
}

export async function buildAnalyzePreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const story = await getStory(dataDir, storyId)
  if (!story) throw new Error(`Story ${storyId} not found`)

  // Resolve the recent cast from the latest prose's forwarded writer context, the
  // same input a run uses; the new-prose block is a placeholder until a run fills it.
  const activeProseIds = await getActiveProseIds(dataDir, storyId)
  const latestProseId = activeProseIds.at(-1)
  const latestProse = latestProseId ? await getFragment(dataDir, storyId, latestProseId) : null

  return buildAnalyzeContext(dataDir, storyId, story, {
    proseFragment: latestProse,
    newProse: { id: '(the new fragment\'s ID)', content: '(the new prose passage will appear here)' },
  })
}

// ─── Librarian Chat ───

export const CHAT_SYSTEM_PROMPT = `
You are the Librarian, the author's story continuity assistant. Answer the author's questions and edit story fragments through tools.

## Reading

- Your context holds the story summary and fragment summaries (IDs, names, descriptions) — the full content stays on disk. Use **readFragments** to batch-read full content before relying on details or proposing whole-field rewrites.
- For sweeping requests (e.g., "update all characters to reflect the time skip"), survey first with **listFragments**, **findFragments**, and **readFragments**, then propose one batch.

## Editing

- Prose edits: **proposeProseChanges** — it scans active prose automatically and returns exact diffs.
- Character, guideline, knowledge, summary, or custom fragments: **proposeFragmentChanges**. ${OPERATION_GUIDANCE} A whole-field rewrite must contain the complete final field text from the fragment you read.
- New fragments: **proposeFragmentChanges** with create_fragment operations and plain fragment names; the system assigns IDs.
- Apply with **applyProposedChanges** only when the author asked for the change, and only after the proposal validates.
- Keep fragment descriptions within the 250 character limit.

## Conduct

- Batch related reads and proposals into one tool call.
- Ask a clarifying question when the request is ambiguous.
- After applying edits, tell the author what changed and why.
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
    // Chat uses a different format for system fragments (dash-list vs ## headers)
    blocks.push({
      id: 'system-fragments',
      role: 'system',
      content: ctx.systemPromptFragments.map(f => `- ${f.id}: ${f.name} — ${f.content}`).join('\n'),
      order: 200,
      source: 'builtin',
    })
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
3. Use **proposeFragmentChanges** to prepare edits. ${OPERATION_GUIDANCE} Then **applyProposedChanges** with the returned proposalId when the proposal is valid.
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
    ...pinnedFragmentSummaryBlocks(ctx),
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
      content: [
        `Operation: ${ctx.operation}`,
        ctx.guidance || '',
      ].join('\n').trim(),
      order: 100,
      source: 'builtin',
    })
  }

  blocks.push({
    id: 'story-summary',
    role: 'user',
    content: [
      'Story summary:',
      ctx.story.summary || STORY_SUMMARY_PLACEHOLDER,
    ].join('\n'),
    order: 200,
    source: 'builtin',
  })

  if (ctx.sourceContent) {
    blocks.push({
      id: 'source',
      role: 'user',
      content: [
        'Fragment context:',
        ctx.sourceContent,
      ].join('\n'),
      order: 300,
      source: 'builtin',
    })
  }

  if (ctx.selectedText) {
    blocks.push({
      id: 'selection',
      role: 'user',
      content: [
        'Selected span to transform:',
        ctx.selectedText,
        '',
        'Context before selected span:',
        ctx.contextBefore?.trim() || '(none)',
        '',
        'Context after selected span:',
        ctx.contextAfter?.trim() || '(none)',
      ].join('\n'),
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
5. Use proposeFragmentChanges with set_fields and the baseHash, then applyProposedChanges after validation. Write the full final character sheet as the content field. Keep descriptions within the 250 character limit.
6. Explain what you changed and why — which dimensions you developed, what friction you introduced, what causal chains you built.

Your scope is the character fragment alone: deepen it, leave prose fragments untouched, and keep it active (archiving is out of scope).`

export function createOptimizeCharacterBlocks(ctx: AgentBlockContext): ContextBlock[] {
  return compactBlocks([
    instructionsBlock('librarian.optimize-character.system', ctx),
    storyInfoBlock(ctx),
    recentProseBlock(ctx),
    ...pinnedFragmentSummaryBlocks(ctx, { includeCharacters: false }),
    allCharactersBlock(ctx),
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
