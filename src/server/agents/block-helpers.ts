/**
 * Composable block builder helpers.
 *
 * These extract the repeated block patterns from agent block builders
 * so each agent can compose its context from reusable pieces.
 */

import type { ContextBlock } from '../llm/context-builder'
import { type AgentBlockContext, baseBlockContext } from './agent-block-context'
import type { Fragment } from '../fragments/schema'
import { buildContextState, fragmentSummaryBlock } from '../llm/context-builder'
import { instructionRegistry } from '../instructions'

// ─── Block helpers ───

/** System instructions block resolved from the instruction registry. */
export function instructionsBlock(key: string, ctx: AgentBlockContext): ContextBlock {
  return {
    id: 'instructions',
    role: 'system',
    content: instructionRegistry.resolve(key, ctx.modelId),
    order: 100,
    source: 'builtin',
  }
}

/** System fragments tagged for inclusion in the system prompt. */
export function systemFragmentsBlock(ctx: AgentBlockContext): ContextBlock | null {
  if (ctx.systemPromptFragments.length === 0) return null
  return {
    id: 'system-fragments',
    role: 'system',
    content: ctx.systemPromptFragments.map(frag => `## ${frag.name}\n${frag.content}`).join('\n\n'),
    order: 200,
    source: 'builtin',
  }
}

/** Story name, description, and summary. */
export function storyInfoBlock(ctx: AgentBlockContext): ContextBlock {
  const parts = [`## Story: ${ctx.story.name}`, ctx.story.description]
  if (ctx.story.summary) {
    parts.push(`\n## Story Summary\n${ctx.story.summary}`)
  }
  return {
    id: 'story-info',
    role: 'user',
    content: parts.join('\n'),
    order: 100,
    source: 'builtin',
  }
}

/** Sticky guidelines, knowledge, characters, and custom fragments. */
export function stickyFragmentsBlock(ctx: AgentBlockContext): ContextBlock | null {
  const all = [
    ...ctx.stickyGuidelines,
    ...ctx.stickyKnowledge,
    ...ctx.stickyCharacters,
    ...(ctx.stickyCustomFragments ?? []),
  ]
  if (all.length === 0) return null
  return fragmentSummaryBlock({ id: 'sticky-fragments', heading: 'Active Context', items: all, order: 300 })
}

/** Full content of recent prose fragments. */
export function recentProseBlock(ctx: AgentBlockContext): ContextBlock | null {
  if (ctx.proseFragments.length === 0) return null
  return {
    id: 'prose-recent',
    role: 'user',
    content: [
      '## Recent Prose',
      ...ctx.proseFragments.map(p => `### ${p.name} (${p.id})\n${p.content}`),
    ].join('\n'),
    order: 200,
    source: 'builtin',
  }
}

/** Prose summaries with librarian-summary fallback (for chat-style contexts). */
export function proseSummariesBlock(ctx: AgentBlockContext, header: string): ContextBlock | null {
  if (ctx.proseFragments.length === 0) return null
  const parts = [header]
  for (const p of ctx.proseFragments) {
    if ((p.meta._librarian as { summary?: string })?.summary) {
      parts.push(`- ${p.id}: ${(p.meta._librarian as { summary?: string }).summary ?? 'No summary available'}`)
    } else if (p.content.length < 600) {
      parts.push(`- ${p.id}: \n${p.content}`)
    } else {
      parts.push(`- ${p.id}: ${p.content.slice(0, 500).replace(/\n/g, ' ')}... [truncated]`)
    }
  }
  return {
    id: 'prose-summaries',
    role: 'user',
    content: parts.join('\n'),
    order: 200,
    source: 'builtin',
  }
}

/** Target fragment + optional user instructions. */
export function targetFragmentBlock(
  ctx: AgentBlockContext,
  label: string,
  defaultGuidance: string,
): ContextBlock | null {
  if (!ctx.targetFragment) return null
  const parts = [`Target ${label}: ${ctx.targetFragment.id} (type: ${ctx.targetFragment.type}, name: "${ctx.targetFragment.name}")`]
  if (ctx.instructions) {
    parts.push(`\nUser instructions: ${ctx.instructions}`)
  } else {
    parts.push(`\n${defaultGuidance}`)
  }
  return {
    id: 'target',
    role: 'user',
    content: parts.join('\n'),
    order: 400,
    source: 'builtin',
  }
}

/** All characters list for cross-reference. */
export function allCharactersBlock(ctx: AgentBlockContext): ContextBlock | null {
  if (!ctx.allCharacters || ctx.allCharacters.length === 0) return null
  return fragmentSummaryBlock({ id: 'characters-shortlist', heading: 'Characters', items: ctx.allCharacters, order: 350 })
}

export interface ShortlistBlockOptions {
  includeCustomFragments?: boolean
}

/** Shortlist fragments not already pinned or promoted to full recent context. */
export function shortlistBlock(ctx: AgentBlockContext, options: ShortlistBlockOptions = {}): ContextBlock | null {
  const all = [
    ...ctx.guidelineShortlist,
    ...ctx.knowledgeShortlist,
    ...ctx.characterShortlist,
    ...(options.includeCustomFragments
      ? (ctx.customFragmentShortlists ?? []).flatMap((group) => group.fragments)
      : []),
  ]
  if (all.length === 0) return null
  return fragmentSummaryBlock({ id: 'shortlist', heading: 'Other Available Fragments', items: all, order: 400 })
}

// ─── Utilities ───

/** Filter nulls from a block array. Use with conditional block helpers. */
export function compactBlocks(blocks: (ContextBlock | null)[]): ContextBlock[] {
  return blocks.filter((b): b is ContextBlock => b !== null)
}

// ─── Preview context helpers ───

/**
 * Build a base AgentBlockContext from story context state.
 * Covers the 8 common fields every preview context needs.
 * Spread the result and add agent-specific extras.
 */
export async function buildBasePreviewContext(
  dataDir: string,
  storyId: string,
): Promise<AgentBlockContext> {
  const ctxState = await buildContextState(dataDir, storyId, '')
  return {
    ...baseBlockContext(ctxState, ctxState.story),
    systemPromptFragments: [],
  }
}

/**
 * Load fragments tagged 'pass-to-librarian-system-prompt' for a story.
 * Used by analyze, chat, and directions preview contexts.
 */
export async function loadSystemPromptFragments(
  dataDir: string,
  storyId: string,
  getFragmentsByTag: (dataDir: string, storyId: string, tag: string) => Promise<string[]>,
  getFragment: (dataDir: string, storyId: string, id: string) => Promise<Fragment | null>,
): Promise<Fragment[]> {
  const ids = await getFragmentsByTag(dataDir, storyId, 'pass-to-librarian-system-prompt')
  const fragments: Fragment[] = []
  for (const id of ids) {
    const frag = await getFragment(dataDir, storyId, id)
    if (frag) fragments.push(frag)
  }
  return fragments
}
