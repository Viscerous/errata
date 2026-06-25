import type { ContextBlock } from '../llm/context-builder'
import { fragmentSummaryBlock } from '../llm/context-builder'
import type { AgentBlockContext } from '../agents/agent-block-context'
import type { Fragment } from '../fragments/schema'
import { getStory, listFragments, getFragment } from '../fragments/storage'
import { getActiveProseIds } from '../fragments/prose-chain'
import { getFragmentsByTag } from '../fragments/associations'
import { instructionRegistry } from '../instructions'
import {
  instructionsBlock,
  systemFragmentsBlock,
  storyInfoBlock,
  stickyFragmentsBlock,
  recentProseBlock,
  proseSummariesBlock,
  targetFragmentBlock,
  allCharactersBlock,
  shortlistBlock,
  compactBlocks,
  buildBasePreviewContext,
  loadSystemPromptFragments,
} from '../agents/block-helpers'

// ─── Librarian Analyze ───

export function buildAnalyzeSystemPrompt(opts?: { disableDirections?: boolean; disableSuggestions?: boolean }): string {
  // An explicit, ordered procedure: it keeps the step-by-step robustness of a
  // checklist while leaving each tool's parameters to its schema (no catalog to
  // drift). Steps for disabled tools are omitted and the rest renumber, so the
  // prompt never names a tool the model wasn't given.
  const steps: string[] = [
    'Report every character who appears — call reportMentions with their IDs, so their names are highlighted in the prose.',
    'Summarize what happened — call updateSummary.',
    'Record contradictions with established facts (reportContradictions) and significant events (reportTimeline) when the prose has them.',
    'Update a fragment when the prose changes a lasting fact about it — a death, an injury, a change in allegiance, title, location, or relationship. The character and knowledge sheets are the record of current state and are fed into later writing, so the change must land on the sheet itself; the summary and timeline log the event but do not keep the sheet current. To change a name or description, call updateFragment with just those fields (it leaves the body untouched); to change part of the body, call editFragment with an exact span from its full sheet; to rewrite a body wholesale, call updateFragment with complete new content built from its full sheet — never from the one-line summary.',
  ]
  if (!opts?.disableSuggestions) {
    steps.push('Suggest genuinely new characters or knowledge with suggestFragment — only ones that do not exist yet.')
  }
  if (!opts?.disableDirections) {
    steps.push('Suggest 3-5 possible next directions for the story with suggestDirections.')
  }
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n')

  const alwaysCall = opts?.disableDirections
    ? 'Always call updateSummary.'
    : 'Always call updateSummary and suggestDirections.'

  return `
You are a librarian agent for a collaborative writing app.
Your job is to analyze a new prose fragment and maintain story continuity.

The characters in the recent prose are provided in full below, alongside knowledge; any other characters are one-line summaries — read one in full with getFragment before editing it.

Work through these steps in order:
${numbered}

${alwaysCall} Only call the other reporting tools when there are relevant findings.
Return 'Analysis complete' as your only final output.
`
}

export const ANALYZE_SYSTEM_PROMPT = buildAnalyzeSystemPrompt()

/**
 * The characters the writer worked from on a prose fragment, resolved to full
 * fragments from its forwarded `writerContextIds`. Shared by the analyze run and
 * its context preview so both populate the characters-recent block the same way.
 */
export function recentCastFromFragment(allCharacters: Fragment[], fragment: Fragment | null | undefined): Fragment[] {
  const ids = new Set(
    Array.isArray(fragment?.meta?.writerContextIds) ? (fragment.meta.writerContextIds as string[]) : [],
  )
  return allCharacters.filter((c) => ids.has(c.id))
}

export function createLibrarianAnalyzeBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []

  blocks.push(instructionsBlock('librarian.analyze.system', ctx))

  const sysFrags = systemFragmentsBlock(ctx)
  if (sysFrags) blocks.push(sysFrags)

  blocks.push({
    id: 'story-summary',
    role: 'user',
    content: ['## Story Summary So Far', ctx.story.summary || '(No summary yet — this may be the beginning of the story.)'].join('\n'),
    order: 100,
    source: 'builtin',
  })

  // Characters in the recent prose are preloaded in full so edits land on their
  // current sheet; the rest stay one-line summaries (getFragment reads any in full).
  const recentIds = new Set((ctx.recentCharacters ?? []).map((c) => c.id))
  if (ctx.recentCharacters && ctx.recentCharacters.length > 0) {
    blocks.push({
      id: 'characters-recent',
      role: 'user',
      content: [
        '## Characters in Recent Prose',
        ...ctx.recentCharacters.map((c) => `### ${c.id}: ${c.name}\n${c.description}\n\n${c.content}`),
      ].join('\n\n'),
      order: 200,
      source: 'builtin',
    })
  }
  const shortlistCharacters = (ctx.allCharacters ?? []).filter((c) => !recentIds.has(c.id))
  if (shortlistCharacters.length > 0) {
    blocks.push(fragmentSummaryBlock({ id: 'characters-shortlist', heading: 'Characters', items: shortlistCharacters, order: 210, editable: true }))
  }

  if (ctx.allKnowledge && ctx.allKnowledge.length > 0) {
    // Knowledge is delivered in full (bounded, read-mostly — analyze checks
    // contradictions against it).
    blocks.push({
      id: 'knowledge',
      role: 'user',
      content: [
        '## Knowledge',
        ...ctx.allKnowledge.map(k => `### ${k.id}: ${k.name}\n${k.content}`),
      ].join('\n\n'),
      order: 300,
      source: 'builtin',
    })
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

  const allCharacters = await listFragments(dataDir, storyId, 'character')
  const allKnowledge = await listFragments(dataDir, storyId, 'knowledge')
  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)

  // Show characters-recent the way a real run would: resolve the cast from the
  // latest prose fragment's forwarded writer context, the same input the run uses.
  const activeProseIds = await getActiveProseIds(dataDir, storyId)
  const latestProseId = activeProseIds.at(-1)
  const latestProse = latestProseId ? await getFragment(dataDir, storyId, latestProseId) : null
  const recentCharacters = recentCastFromFragment(allCharacters, latestProse)

  return {
    story,
    proseFragments: [],
    stickyGuidelines: [],
    stickyKnowledge: [],
    stickyCharacters: [],
    guidelineShortlist: [],
    knowledgeShortlist: [],
    characterShortlist: [],
    systemPromptFragments,
    allCharacters,
    recentCharacters,
    allKnowledge,
    newProse: { id: '(the new fragment\'s ID)', content: '(the new prose passage will appear here)' },
  }
}

// ─── Librarian Chat ───

export const CHAT_SYSTEM_PROMPT = `
You are a conversational librarian assistant for a collaborative writing app. Your job is to help the author maintain story continuity by answering questions and performing fragment edits through tools.
Important: Follow the agent configuration.

Your tools' names, parameters, and usage are described in their definitions; only the tools listed there are available to you. Reach for read tools (getFragment, listFragments, searchFragments) to gather context, and the edit/create/delete tools to change fragments.

Instructions:
1. Your context includes a story summary and fragment summaries (IDs, names, descriptions) — not full content. Use getFragment(id) to read the full content of any fragment you need.
2. For prose edits, first read the relevant prose fragment with getFragment, then use editProse(oldText, newText) — it scans active prose automatically.
3. For character/guideline/knowledge changes, use editFragment or updateFragment with the fragment ID.
3b. When the author asks to add new lore/character/rules, use createFragment.
4. When the author asks for sweeping changes (e.g. "update all characters to reflect the time skip"), use listFragments and getFragment to find relevant fragments, then update each one.
5. Explain what you changed and why after making edits.
6. Ask clarifying questions when the request is ambiguous.
7. You can make multiple tool calls in sequence to accomplish complex tasks.
8. Keep fragment descriptions within the 250 character limit.
9. Be concise but thorough in your responses.

Fragment ID prefixes: pr- (prose), ch- (character), gl- (guideline), kn- (knowledge).
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

  const prose = proseSummariesBlock(ctx, '## Prose Fragments (use getFragment to read/edit)')
  if (prose) blocks.push(prose)

  const sticky = stickyFragmentsBlock(ctx)
  if (sticky) blocks.push(sticky)

  const shortlist = shortlistBlock(ctx)
  if (shortlist) blocks.push(shortlist)

  return blocks
}

export async function buildChatPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)
  return { ...base, systemPromptFragments }
}

// ─── Librarian Refine ───

export const REFINE_SYSTEM_PROMPT = `You are a fragment refinement agent for a collaborative writing app. Your job is to improve a specific fragment (character, guideline, or knowledge) based on the story context.

Instructions:
1. First, read the target fragment using the appropriate get tool (e.g. getCharacter, getKnowledge, getGuideline).
2. Analyze the story context provided: prose, summary, and other fragments.
3. Use the updateFragment or editFragment tool to improve the target fragment.
4. Explain what you changed and why in your text response.

Guidelines for refinement:
- If the user provides specific instructions, follow them precisely.
- If no instructions are given, improve the fragment for consistency, clarity, and depth based on story events.
- Preserve the fragment's existing voice and style unless asked otherwise.
- Update descriptions to stay within the 250 character limit.
- Do NOT delete fragments unless explicitly asked.
- Do NOT modify prose fragments — only characters, guidelines, and knowledge.`

export function createLibrarianRefineBlocks(ctx: AgentBlockContext): ContextBlock[] {
  return compactBlocks([
    instructionsBlock('librarian.refine.system', ctx),
    storyInfoBlock(ctx),
    recentProseBlock(ctx),
    stickyFragmentsBlock(ctx),
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
    instructions: '(Preview — actual instructions will appear during refinement)',
  }
}

// ─── Prose Transform ───

export const PROSE_TRANSFORM_SYSTEM_PROMPT = `You transform selected prose spans for an author in a writing app.

Rules:
- Follow the requested operation exactly.
- Preserve story facts, continuity, tense, and point of view.
- Do not add metadata, explanations, markdown, quotes, or labels.
- Return only the transformed replacement text for the selected span.`

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
      ctx.story.summary || '(none)',
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
    story,
    proseFragments: [],
    stickyGuidelines: [],
    stickyKnowledge: [],
    stickyCharacters: [],
    guidelineShortlist: [],
    knowledgeShortlist: [],
    characterShortlist: [],
    systemPromptFragments: [],
    operation: 'rewrite',
    guidance: 'Rewrite the selected span for clarity and flow while preserving the original meaning and voice.',
    selectedText: '(Preview — actual selection will appear during transform)',
    sourceContent: '(Preview — actual fragment content will appear during transform)',
    contextBefore: '',
    contextAfter: '',
  }
}

// ─── Optimize Character ───

export const OPTIMIZE_CHARACTER_SYSTEM_PROMPT = `You are a character optimization agent for a collaborative writing app. Your job is to rewrite a character sheet so it has genuine depth, causality, and texture — following a specific creative writing methodology.

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

**References as sprinkles.** Archetypes, real-world references, and cultural touchstones are starting points, never destinations. "Columbo-like disarming manner" is a seed that orients the reader, not a character sheet. Use musicians instead of specific songs, directors instead of every movie — unless a specific reference carries causal weight.

## Instructions

1. Read the target character fragment using the appropriate get tool (e.g. getCharacter, getFragment).
2. Read relevant prose fragments using getFragment to understand how the character actually behaves in the story — not just how they're described on paper.
3. Analyze gaps between the current sheet and the methodology above. Where are there bare adjectives without cause? Where is friction missing? Which of Egri's dimensions are underdeveloped?
4. Rewrite the character sheet with depth and causality. Build the ramp of how this person grew up and why they think the way they do. Preserve existing voice and any details that already have depth — improve, don't replace what works.
5. Use updateFragment to save the improved version. Keep descriptions within the 250 character limit.
6. Explain what you changed and why — which dimensions you developed, what friction you introduced, what causal chains you built.

Do NOT delete the fragment. Do NOT modify prose fragments. Focus entirely on deepening the character sheet.`

export function createOptimizeCharacterBlocks(ctx: AgentBlockContext): ContextBlock[] {
  return compactBlocks([
    instructionsBlock('librarian.optimize-character.system', ctx),
    storyInfoBlock(ctx),
    recentProseBlock(ctx),
    stickyFragmentsBlock(ctx),
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
    instructions: '(Preview — actual instructions will appear during optimization)',
  }
}
