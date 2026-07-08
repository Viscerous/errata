import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import {
  getFragment,
  getStory,
  listFragments,
  migrateStoryToSummaryFragments,
} from '../fragments/storage'
import { getActiveProseIds } from '../fragments/prose-chain'
import { registry } from '../fragments/registry'
import { createLogger } from '../logging'
import type { Fragment } from '../fragments/schema'
import { reanalyzeAfterProseChange } from '../librarian/scheduler'
import {
  MAX_BATCH_OPERATIONS,
  OPERATION_GUIDANCE,
  type EditableField,
  type FragmentChangeOperation,
  type OperationValidation,
  editableFieldSchema,
  excerptAround,
  findOccurrences,
  fragmentBaseHash,
  proposeFragmentChangesSchema,
  recommendedReadFragmentIds,
  sanitizeOperationValidationsForTool,
  sanitizeTextForToolEcho,
  truncateText,
} from '../fragments/change-operations'
import { applyOperationsWithSnapshot, type AppliedChange } from '../fragments/change-apply'
import { loadSummaryContent, STORY_SUMMARY_PLACEHOLDER } from './context-builder'

export {
  BASE_HASH_DESCRIPTION,
  FRAGMENT_CONTENT_DESCRIPTION,
  FRAGMENT_DESCRIPTION_DESCRIPTION,
  FRAGMENT_NAME_DESCRIPTION,
  SET_FIELDS_DESCRIPTION,
  fragmentBaseHash,
  fragmentChangeOperationSchema,
  fragmentNameError,
} from '../fragments/change-operations'

const logger = createLogger('llm-tools')
const TOOL_LOG_MAX_CHARS = 1200
const MAX_READ_FRAGMENTS = 30
const MAX_LIST_LIMIT = 100

function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val as object)) return '[Circular]'
        seen.add(val)
      }
      return val
    })
  } catch {
    return String(value)
  }
}

function truncateForLog(value: unknown): string {
  const text = safeStringify(value)
  if (text.length <= TOOL_LOG_MAX_CHARS) return text
  return `${text.slice(0, TOOL_LOG_MAX_CHARS)}... [truncated ${text.length - TOOL_LOG_MAX_CHARS} chars]`
}

function withToolLogging<TInput, TResult>(
  toolName: string,
  storyId: string,
  handler: (input: TInput) => Promise<TResult>,
) {
  return async (input: TInput): Promise<TResult> => {
    const startTime = Date.now()
    logger.debug(`Tool call: ${toolName} (input)`, {
      storyId,
      input: truncateForLog(input),
    })

    try {
      const result = await handler(input)
      const durationMs = Date.now() - startTime
      logger.debug(`Tool call: ${toolName} (output)`, {
        storyId,
        durationMs,
        output: truncateForLog(result),
      })
      return result
    } catch (error) {
      const durationMs = Date.now() - startTime
      logger.error(`Tool call: ${toolName} failed`, {
        storyId,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

const proseReplaceSchema = z.object({
  oldText: z.string().min(1).describe('Required exact text to find in active prose fragments.'),
  newText: z.string().describe('Required replacement text. Use an empty string only to delete oldText.'),
  replaceAll: z.boolean().default(true).describe('Replace all matches in each affected active prose fragment. Defaults to true for prose-wide search/replace.'),
  occurrence: z.number().int().positive().optional().describe('1-based occurrence for each affected fragment when `replaceAll` is false and `oldText` appears multiple times.'),
  reason: z.string().max(500).optional(),
})

export interface FragmentToolsOptions {
  /** true: read tools only. false: add the direct edit tools. Defaults to true. */
  readOnly?: boolean
}

function summarizeFragment(fragment: Fragment) {
  return {
    id: fragment.id,
    type: fragment.type,
    name: sanitizeTextForToolEcho(fragment.name),
    description: sanitizeTextForToolEcho(fragment.description),
    archived: fragment.archived ?? false,
    sticky: fragment.sticky,
    tags: fragment.tags,
    refs: fragment.refs,
    version: fragment.version ?? 1,
    baseHash: fragmentBaseHash(fragment),
  }
}

function fullFragmentForTool(fragment: Fragment) {
  return {
    ...summarizeFragment(fragment),
    content: sanitizeTextForToolEcho(fragment.content),
    meta: fragment.meta,
  }
}

async function loadActiveProseFragments(dataDir: string, storyId: string): Promise<Fragment[]> {
  const activeIds = await getActiveProseIds(dataDir, storyId)
  if (activeIds.length > 0) {
    const fragments: Fragment[] = []
    for (const id of activeIds) {
      const fragment = await getFragment(dataDir, storyId, id)
      if (fragment && !fragment.archived && fragment.type === 'prose') {
        fragments.push(fragment)
      }
    }
    return fragments
  }
  const allProse = await listFragments(dataDir, storyId, 'prose')
  return allProse.filter((fragment) => !fragment.archived)
}

/**
 * Common shape for the direct edit tools: what applied, what was skipped, the
 * per-operation diffs the model (and the chat card) render, and the
 * `appliedChanges` revert token the Undo button reverses through the shared core.
 */
function editResponse(
  appliedResults: OperationValidation[],
  appliedChanges: AppliedChange[],
  extra: Record<string, unknown> = {},
) {
  return {
    ok: appliedResults.length > 0 && appliedResults.every((result) => result.status === 'applied'),
    applied: appliedResults.filter((result) => result.status === 'applied').length,
    skipped: appliedResults.filter((result) => result.status !== 'applied').length,
    readFragmentIds: recommendedReadFragmentIds(appliedResults),
    operations: sanitizeOperationValidationsForTool(appliedResults),
    appliedChanges,
    ...extra,
  }
}

export function coreReadToolNames(): string[] {
  return ['readFragments', 'findFragments', 'listFragments', 'readProseChain', 'listFragmentTypes', 'readStorySummary']
}

export function coreProposalToolNames(): string[] {
  return ['editFragments', 'editProse']
}

/**
 * Creates the standard LLM tool definitions for story data.
 *
 * Read-only mode exposes a compact batch read/search/list surface. Write-enabled
 * mode adds proposal and application tools; it does not expose direct create,
 * update, edit, delete, or prose-edit tools.
 */
export function createFragmentTools(
  dataDir: string,
  storyId: string,
  opts: FragmentToolsOptions = {},
) {
  const { readOnly = true } = opts
  const tools: ToolSet = {}

  tools.readFragments = tool({
    description: 'Read one or more fragments by ID. Returns full editable fields and `baseHash`. Use `baseHash` when applying `set_fields` whole-field rewrites.',
    inputSchema: z.object({
      fragmentIds: z.array(z.string()).min(1).max(MAX_READ_FRAGMENTS).describe('Fragment IDs to read. Batch related reads in one call.'),
    }),
    execute: withToolLogging('readFragments', storyId, async ({ fragmentIds }: { fragmentIds: string[] }) => {
      const fragments = []
      const missing = []
      for (const id of [...new Set(fragmentIds)]) {
        const fragment = await getFragment(dataDir, storyId, id)
        if (!fragment) {
          missing.push(id)
          continue
        }
        fragments.push(fullFragmentForTool(fragment))
      }
      return { fragments, missing }
    }),
  })

  tools.findFragments = tool({
    description: 'Search fragments by case-insensitive substring. Returns matching IDs and excerpts; call `readFragments` before relying on details or editing.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Case-insensitive text to search for in name, description, or content.'),
      types: z.array(z.string()).optional().describe('Optional fragment types to include. Omit to search all textual fragment types.'),
      fields: z.array(editableFieldSchema).optional().describe('Fields to search. Defaults to name, description, and content.'),
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(25),
    }),
    execute: withToolLogging('findFragments', storyId, async ({ query, types, fields, includeArchived, limit }: {
      query: string
      types?: string[]
      fields?: EditableField[]
      includeArchived?: boolean
      limit?: number
    }) => {
      const selectedFields = fields?.length ? fields : ['name', 'description', 'content'] as EditableField[]
      const typeSet = types?.length ? new Set(types) : null
      const lowerQuery = query.toLowerCase()
      const fragments = await listFragments(dataDir, storyId, undefined, { includeArchived: includeArchived ?? false })
      const matches: Array<{ id: string; type: string; name: string; field: EditableField; excerpt: string; baseHash: string }> = []
      for (const fragment of fragments) {
        if (typeSet && !typeSet.has(fragment.type)) continue
        if (!typeSet && (fragment.type === 'image' || fragment.type === 'icon')) continue
        for (const field of selectedFields) {
          const value = fragment[field]
          const index = value.toLowerCase().indexOf(lowerQuery)
          if (index === -1) continue
          matches.push({
            id: fragment.id,
            type: fragment.type,
            name: sanitizeTextForToolEcho(fragment.name),
            field,
            excerpt: sanitizeTextForToolEcho(excerptAround(value, index, query.length)),
            baseHash: fragmentBaseHash(fragment),
          })
          break
        }
        if (matches.length >= (limit ?? 25)) break
      }
      return { matches, total: matches.length }
    }),
  })

  tools.listFragments = tool({
    description: 'List fragments with optional filters. Returns summaries only; use `readFragments` for full content before editing or citing details.',
    inputSchema: z.object({
      type: z.string().optional().describe('Optional fragment type filter.'),
      query: z.string().optional().describe('Optional case-insensitive filter over name and description.'),
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(50),
    }),
    execute: withToolLogging('listFragments', storyId, async ({ type, query, includeArchived, limit }: {
      type?: string
      query?: string
      includeArchived?: boolean
      limit?: number
    }) => {
      let fragments = await listFragments(dataDir, storyId, type, { includeArchived: includeArchived ?? false })
      if (query?.trim()) {
        const lower = query.trim().toLowerCase()
        fragments = fragments.filter((fragment) =>
          fragment.name.toLowerCase().includes(lower) ||
          fragment.description.toLowerCase().includes(lower),
        )
      }
      const total = fragments.length
      return {
        fragments: fragments.slice(0, limit ?? 50).map(summarizeFragment),
        total,
        truncated: total > (limit ?? 50),
      }
    }),
  })

  tools.readProseChain = tool({
    description: 'Read the active prose chain in order. Use this for continuity and for scoping prose edits to active prose only.',
    inputSchema: z.object({
      includeContent: z.boolean().default(false).describe('When true, include full content. Otherwise returns summaries and `baseHash` only.'),
      limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(50),
    }),
    execute: withToolLogging('readProseChain', storyId, async ({ includeContent, limit }: { includeContent?: boolean; limit?: number }) => {
      const active = await loadActiveProseFragments(dataDir, storyId)
      const selected = active.slice(0, limit ?? 50)
      return {
        fragments: selected.map((fragment, index) => ({
          index,
          ...summarizeFragment(fragment),
          ...(includeContent ? { content: sanitizeTextForToolEcho(fragment.content) } : {}),
        })),
        total: active.length,
        truncated: active.length > (limit ?? 50),
      }
    }),
  })

  tools.listFragmentTypes = tool({
    description: 'List all available built-in and custom fragment types.',
    inputSchema: z.object({}),
    execute: withToolLogging('listFragmentTypes', storyId, async () => {
      const story = await getStory(dataDir, storyId)
      const customTypes = story?.settings.customFragmentTypes ?? []
      return {
        types: [
          ...registry.listTypes().map((t) => ({
            type: t.type,
            prefix: t.prefix,
            stickyByDefault: t.stickyByDefault,
            hiddenFromList: t.hiddenFromList ?? false,
            custom: false,
          })),
          ...customTypes.map((t) => ({
            type: t.type,
            prefix: t.type.slice(0, 4).toLowerCase(),
            stickyByDefault: false,
            hiddenFromList: false,
            name: t.name,
            description: t.description,
            custom: true,
          })),
        ],
      }
    }),
  })

  tools.readStorySummary = tool({
    description: 'Read the current rolling story summary. Summary fragments are still editable through `readFragments` and the edit tools.',
    inputSchema: z.object({}),
    execute: withToolLogging('readStorySummary', storyId, async () => {
      const story = await getStory(dataDir, storyId)
      if (!story) return { error: 'Story not found' }
      await migrateStoryToSummaryFragments(dataDir, storyId)
      const summary = await loadSummaryContent(dataDir, storyId)
      const summaryFragments = await listFragments(dataDir, storyId, 'summary')
      return {
        summary: summary || STORY_SUMMARY_PLACEHOLDER,
        fragments: summaryFragments.map(summarizeFragment),
      }
    }),
  })

  if (!readOnly) {
    tools.editFragments = tool({
      description: `Create, edit, append to, whole-field rewrite, or archive memory fragments via \`operations\`. ${OPERATION_GUIDANCE} Applies atomically per target fragment and returns per-operation diffs; invalid targets are skipped and reported. Not for prose — use editProse.`,
      inputSchema: proposeFragmentChangesSchema,
      execute: withToolLogging('editFragments', storyId, async ({ title, rationale, operations }) => {
        const { appliedResults, appliedChanges } = await applyOperationsWithSnapshot(dataDir, storyId, operations, {
          onFragmentUpdated: reanalyzeAfterProseChange.bind(null, dataDir, storyId),
        })
        return editResponse(appliedResults, appliedChanges, {
          ...(title?.trim() ? { title: title.trim() } : {}),
          ...(rationale?.trim() ? { rationale: rationale.trim() } : {}),
        })
      }),
    })

    tools.editProse = tool({
      description: 'Apply exact search/replace edits across active prose only. Scans active prose, expands each match into fragment-specific edits, applies them atomically, and returns diffs. Edits whose oldText matches no active prose are reported as unmatched.',
      inputSchema: z.object({
        edits: z.array(proseReplaceSchema).min(1).max(MAX_BATCH_OPERATIONS),
      }),
      execute: withToolLogging('editProse', storyId, async ({ edits }) => {
        const active = await loadActiveProseFragments(dataDir, storyId)
        const operations: FragmentChangeOperation[] = []
        const unmatched: Array<{ oldText: string; reason: string }> = []
        for (const edit of edits) {
          let matchCount = 0
          for (const fragment of active) {
            const count = findOccurrences(fragment.content, edit.oldText).length
            if (count === 0) continue
            matchCount += count
            operations.push({
              action: 'replace_text',
              fragmentId: fragment.id,
              field: 'content',
              oldText: edit.oldText,
              newText: edit.newText,
              replaceAll: edit.replaceAll,
              occurrence: edit.occurrence,
              reason: edit.reason,
            })
          }
          if (matchCount === 0) {
            unmatched.push({ oldText: truncateText(edit.oldText, 120), reason: 'No active prose fragment contains oldText.' })
          }
        }

        if (operations.length === 0) {
          return { ok: false, applied: 0, skipped: 0, operations: [], appliedChanges: [], unmatched, error: 'No active prose matches found.' }
        }

        const { appliedResults, appliedChanges } = await applyOperationsWithSnapshot(dataDir, storyId, operations, {
          allowProseEdits: true,
          onFragmentUpdated: reanalyzeAfterProseChange.bind(null, dataDir, storyId),
        })
        return editResponse(appliedResults, appliedChanges, unmatched.length > 0 ? { unmatched } : {})
      }),
    })
  }

  return tools
}
