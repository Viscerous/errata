import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { getFragment, updateFragment, updateFragmentVersioned } from '../fragments/storage'
import { checkFragmentWrite } from '../fragments/protection'
import type { LibrarianMention } from './storage'

const mentionTextSchema = z.string().trim().min(1).describe('The exact non-empty name, title, or key term used in the prose')

export const mentionInputSchema = z.union([
  z.object({
    characterId: z.string().startsWith('ch-').describe('The character fragment ID (e.g. ch-abc)'),
    text: mentionTextSchema,
  }).strict(),
  z.object({
    knowledgeId: z.string().startsWith('kn-').describe('The knowledge fragment ID (e.g. kn-xyz)'),
    text: mentionTextSchema,
  }).strict(),
])

function mentionFragmentId(mention: LibrarianMention): string {
  return 'characterId' in mention ? mention.characterId : mention.knowledgeId
}

function mentionKey(mention: LibrarianMention): string {
  return `${mentionFragmentId(mention)}\u0000${mention.text.trim().toLowerCase()}`
}

/** Map collected mentions to the prose annotation shape used for highlighting. */
export function toMentionAnnotations(mentions: LibrarianMention[]) {
  return mentions.map(m => ({ type: 'mention' as const, fragmentId: mentionFragmentId(m), text: m.text }))
}

/**
 * Write mention annotations onto the prose fragment immediately (meta-only, so it
 * creates no version). Called from reportMentions so highlights appear as soon as
 * mentions resolve, rather than waiting for the whole analysis run to finish.
 */
async function persistMentionAnnotations(
  dataDir: string,
  storyId: string,
  proseFragmentId: string,
  mentions: LibrarianMention[],
): Promise<void> {
  const prose = await getFragment(dataDir, storyId, proseFragmentId)
  if (!prose) return
  await updateFragment(dataDir, storyId, {
    ...prose,
    meta: { ...prose.meta, annotations: toMentionAnnotations(mentions) },
  })
}

// --- Collector ---

export interface AnalysisCollector {
  summaryUpdate: string
  structuredSummary: {
    events: string[]
    stateChanges: string[]
    openThreads: string[]
  }
  mentions: LibrarianMention[]
  contradictions: Array<{ description: string; fragmentIds: string[] }>
  fragmentSuggestions: Array<{
    type: 'character' | 'knowledge'
    targetFragmentId?: string
    name: string
    description: string
    content: string
  }>
  timelineEvents: Array<{ event: string; position: 'before' | 'during' | 'after' }>
  directions: Array<{ title: string; description: string; instruction: string }>
}

export function createEmptyCollector(): AnalysisCollector {
  return {
    summaryUpdate: '',
    structuredSummary: {
      events: [],
      stateChanges: [],
      openThreads: [],
    },
    mentions: [],
    contradictions: [],
    fragmentSuggestions: [],
    timelineEvents: [],
    directions: [],
  }
}

function normalizeUniqueLines(values: string[] | undefined, maxItems: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= maxItems) break
  }
  return out
}

function sentenceJoin(values: string[]): string {
  return values.map((v) => v.endsWith('.') ? v : `${v}.`).join(' ')
}

export function renderStructuredSummary(structured: {
  events: string[]
  stateChanges: string[]
  openThreads: string[]
}): string {
  const parts: string[] = []
  if (structured.events.length > 0) {
    parts.push(`Events: ${structured.events.join('; ')}.`)
  }
  if (structured.stateChanges.length > 0) {
    parts.push(`State changes: ${structured.stateChanges.join('; ')}.`)
  }
  if (structured.openThreads.length > 0) {
    parts.push(`Open threads: ${structured.openThreads.join('; ')}.`)
  }

  return sentenceJoin(parts).trim()
}

export const updateSummaryInputSchema = z.object({
  summary: z.string().max(1200).describe('A concise summary of what happened in the new prose fragment'),
  events: z.array(z.string().max(200)).max(12).optional()
    .describe('Bullet-like event statements from the prose fragment'),
  stateChanges: z.array(z.string().max(200)).max(12).optional()
    .describe('What changed in goals, relationships, world state, or character condition'),
  openThreads: z.array(z.string().max(200)).max(12).optional()
    .describe('Unresolved questions or threads introduced/advanced by this prose'),
}).superRefine((value, ctx) => {
  const hasSummary = value.summary.trim().length > 0
  const signalCount = (value.events?.length ?? 0) + (value.stateChanges?.length ?? 0) + (value.openThreads?.length ?? 0)
  if (!hasSummary && signalCount === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'Provide either summary text or at least one structured summary signal.',
    })
  }
})

// --- Tools ---

export function createAnalysisTools(collector: AnalysisCollector, opts?: { dataDir: string; storyId: string; proseFragmentId?: string; disableDirections?: boolean; disableSuggestions?: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {
    updateSummary: tool({
      description: 'Set or update the summary for this prose fragment. Describes what happened in the new prose. Last call wins.',
      inputSchema: updateSummaryInputSchema,
      execute: async ({ summary, events, stateChanges, openThreads }) => {
        const normalized = {
          events: normalizeUniqueLines(events, 8),
          stateChanges: normalizeUniqueLines(stateChanges, 8),
          openThreads: normalizeUniqueLines(openThreads, 8),
        }
        collector.structuredSummary = normalized

        const trimmedSummary = summary.trim()
        collector.summaryUpdate = trimmedSummary.length > 0
          ? trimmedSummary
          : renderStructuredSummary(normalized)
        return { ok: true }
      },
    }),

    reportMentions: tool({
      description: 'Report character and knowledge fragment mentions in the new prose — references by name, title, or key term. Call once with all mentions.',
      inputSchema: z.object({
        mentions: z.array(mentionInputSchema),
      }),
      execute: async ({ mentions }) => {
        // Deduplicate by fragment+surface text. Multiple terms can resolve to
        // the same fragment and should all highlight.
        const seen = new Set(collector.mentions.map(mentionKey))
        for (const m of mentions) {
          const key = mentionKey(m)
          if (seen.has(key)) continue
          seen.add(key)
          collector.mentions.push(m)
        }
        // Persist annotations now so the prose highlights appear as soon as
        // mentions resolve, not at the end of the run.
        if (opts?.proseFragmentId && collector.mentions.length > 0) {
          await persistMentionAnnotations(opts.dataDir, opts.storyId, opts.proseFragmentId, collector.mentions)
        }
        return { ok: true }
      },
    }),

    reportContradictions: tool({
      description: 'Report contradictions between the new prose and established facts in the summary, character descriptions, or knowledge. Only flag clear contradictions, not ambiguities.',
      inputSchema: z.object({
        contradictions: z.array(z.object({
          description: z.string().describe('What the contradiction is'),
          fragmentIds: z.array(z.string()).describe('IDs of the fragments involved'),
        })),
      }),
      execute: async ({ contradictions }) => {
        collector.contradictions.push(...contradictions)
        return { ok: true }
      },
    }),

    reportTimeline: tool({
      description: 'Report significant timeline events from the new prose.',
      inputSchema: z.object({
        events: z.array(z.object({
          event: z.string().describe('Description of the event'),
          position: z.union([z.literal('before'), z.literal('during'), z.literal('after')]).describe('"before" for flashback, "during" for concurrent, "after" for sequential'),
        })),
      }),
      execute: async ({ events }) => {
        collector.timelineEvents.push(...events)
        return { ok: true }
      },
    }),

    getFragment: tool({
      description: 'Read a character, knowledge, or guideline fragment in full by ID. The characters in the recent prose are already shown in full; use this only to read another fragment before editing it.',
      inputSchema: z.object({
        fragmentId: z.string().describe('The fragment ID to read (e.g. ch-abc, kn-xyz)'),
      }),
      execute: async ({ fragmentId }) => {
        if (!opts) return { error: 'getFragment not available in this context' }
        const frag = await getFragment(opts.dataDir, opts.storyId, fragmentId)
        if (!frag) return { error: `Fragment ${fragmentId} not found` }
        return { id: frag.id, name: frag.name, description: frag.description, content: frag.content, type: frag.type }
      },
    }),

    editFragment: tool({
      description: 'Replace an exact text span (oldText) with newText in a character, knowledge, or guideline fragment. Searches the name, description, and content, and changes only the matched span. oldText must match the current text exactly.',
      inputSchema: z.object({
        fragmentId: z.string().describe('The ID of the fragment to edit (e.g. ch-abc, kn-xyz)'),
        oldText: z.string().describe('The exact text span to find and replace, from the name, description, or content'),
        newText: z.string().describe('The replacement text'),
      }),
      execute: async ({ fragmentId, oldText, newText }) => {
        if (!opts) return { error: 'editFragment not available in this context' }
        const existing = await getFragment(opts.dataDir, opts.storyId, fragmentId)
        if (!existing) return { error: `Fragment ${fragmentId} not found` }
        if (existing.type === 'prose') return { error: 'Cannot edit prose fragments via this tool' }
        // Locate oldText across the editable fields, in priority order.
        const field = (['content', 'description', 'name'] as const).find(f => existing[f].includes(oldText))
        if (!field) {
          return { error: `Text not found in the name, description, or content of ${fragmentId}: "${oldText}". Match it exactly against the current sheet.` }
        }
        const newValue = existing[field].replace(oldText, newText)
        // Frozen-section protection only applies to content; locked applies to all.
        const protection = checkFragmentWrite(existing, field === 'content' ? { content: newValue } : {})
        if (!protection.allowed) return { error: protection.reason }
        const updated = await updateFragmentVersioned(opts.dataDir, opts.storyId, fragmentId, { [field]: newValue }, { reason: 'librarian-analysis' })
        if (!updated) return { error: `Failed to edit fragment ${fragmentId}` }
        return { ok: true, fragmentId: updated.id, field }
      },
    }),

    updateFragment: tool({
      description: 'Replace whole fields on a fragment by ID. Only the fields you pass change; the rest are left untouched. Setting content replaces the entire body, so provide complete new text built from the fragment\'s current sheet.',
      inputSchema: z.object({
        fragmentId: z.string().describe('The ID of the fragment to update (e.g. ch-abc, kn-xyz)'),
        name: z.string().optional().describe('New name for the fragment'),
        description: z.string().max(250).optional().describe('New description (max 250 chars)'),
        content: z.string().optional().describe('The complete new body; it replaces the existing content in full. Build it from the fragment\'s current text, not from the one-line summary.'),
      }),
      execute: async ({ fragmentId, name, description, content }) => {
        if (!opts) return { error: 'updateFragment not available in this context' }
        const existing = await getFragment(opts.dataDir, opts.storyId, fragmentId)
        if (!existing) return { error: `Fragment ${fragmentId} not found` }
        if (existing.type === 'prose') return { error: 'Cannot update prose fragments via this tool' }
        const protection = checkFragmentWrite(existing, { content })
        if (!protection.allowed) return { error: protection.reason }
        const updates: Record<string, string> = {}
        if (name !== undefined) updates.name = name
        if (description !== undefined) updates.description = description
        if (content !== undefined) updates.content = content
        if (Object.keys(updates).length === 0) return { error: 'No fields to update' }
        const updated = await updateFragmentVersioned(opts.dataDir, opts.storyId, fragmentId, updates, { reason: 'librarian-analysis' })
        if (!updated) return { error: `Failed to update fragment ${fragmentId}` }
        return { ok: true, fragmentId: updated.id }
      },
    }),
  }

  if (!opts?.disableSuggestions) {
    tools.suggestFragment = tool({
      description: 'Suggest creating or updating character/knowledge fragments based on new information in the prose. Each character or knowledge entry should appear only once. If updating an existing fragment, respect locked/frozen protections — locked fragments cannot be modified, and frozen sections must be preserved verbatim in the new content.',
      inputSchema: z.object({
        suggestions: z.array(z.object({
          type: z.union([z.literal('character'), z.literal('knowledge')]).describe('"character" for characters, "knowledge" for world-building, locations, items, facts'),
          targetFragmentId: z.string().optional().describe('If updating an existing fragment, its ID. Omit for new fragments.'),
          name: z.string().describe('Name of the character or knowledge entry'),
          description: z.string().describe('Short description (max 250 chars)'),
          content: z.string().describe('Full content. Retain important established facts when updating.'),
        })),
      }),
      execute: async ({ suggestions }) => {
        // Deduplicate by type+name (case-insensitive), keeping the last (most complete) entry
        const seen = new Set(
          collector.fragmentSuggestions.map(s => `${s.type}:${s.name.trim().toLowerCase()}`),
        )
        const skipped: Array<{ name: string; reason: string }> = []
        for (const s of suggestions) {
          const key = `${s.type}:${s.name.trim().toLowerCase()}`
          if (seen.has(key)) continue

          // Check protection if targeting an existing fragment
          if (s.targetFragmentId && opts) {
            const existing = await getFragment(opts.dataDir, opts.storyId, s.targetFragmentId)
            if (existing) {
              const protection = checkFragmentWrite(existing, { content: s.content })
              if (!protection.allowed) {
                skipped.push({ name: s.name, reason: protection.reason! })
                continue
              }
            }
          }

          seen.add(key)
          collector.fragmentSuggestions.push(s)
        }
        if (skipped.length > 0) {
          return {
            ok: true,
            skipped,
            message: `${skipped.length} suggestion(s) skipped due to fragment protection. Locked fragments cannot be modified and frozen sections must be preserved verbatim.`,
          }
        }
        return { ok: true }
      },
    })
  }

  if (!opts?.disableDirections) {
    tools.suggestDirections = tool({
      description: 'Suggest 3-5 possible directions the story could go next.',
      inputSchema: z.object({
        directions: z.array(z.object({
          title: z.string().describe('Short title for the direction (3-6 words)'),
          description: z.string().describe('One sentence describing what would happen'),
          instruction: z.string().describe('Instruction for the writer agent to follow this direction'),
        })).min(3).max(5),
      }),
      execute: async ({ directions }) => {
        collector.directions = directions
        return { ok: true }
      },
    })
  }

  return tools
}

/**
 * The analyze toolset. Single source for the runtime handler and the agent's
 * available-tools list, so the toggle path and the model stay in sync.
 *
 * The characters in the recent prose are preloaded into context in full, and
 * knowledge sits in context in full, so the pass edits directly against the
 * sheets it already holds. getFragment is the fallback for reading any other
 * fragment before editing it.
 */
export function createLibrarianAnalyzeTools(
  collector: AnalysisCollector,
  opts: { dataDir: string; storyId: string; proseFragmentId?: string; disableDirections?: boolean; disableSuggestions?: boolean },
): ToolSet {
  return createAnalysisTools(collector, opts)
}

/** Tool names the analyze agent exposes — drives the toggle list with no drift. */
export function listLibrarianAnalyzeToolNames(): string[] {
  return Object.keys(createLibrarianAnalyzeTools(createEmptyCollector(), { dataDir: '', storyId: '' }))
}
