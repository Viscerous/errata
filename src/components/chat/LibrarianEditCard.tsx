import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { q, useActiveBranchId } from '@/lib/query-keys'
import { diffRows } from '@/lib/diff'
import { DiffRowsView } from '@/components/DiffRowsView'
import { FilePlus2, FilePenLine, Archive, Undo2, Loader2, Check, AlertCircle } from 'lucide-react'

/** Minimal shape of the operation validations echoed by the apply tool result. */
interface AppliedOperation {
  operationId?: string
  action: 'create_fragment' | 'replace_text' | 'append_paragraph' | 'set_fields' | 'archive_fragment'
  status: 'valid' | 'invalid' | 'applied' | 'skipped'
  target?: { fragmentId?: string; field?: string }
  diffs?: Array<{ field: string; before: string; after: string }>
  createdFragmentId?: string
}

interface ApplyResult {
  operations?: AppliedOperation[]
  /** Revert token: the before/after snapshot the shared revert endpoint reverses. */
  appliedChanges?: unknown[]
}

/** True when a tool result looks like an apply that actually changed storage. */
export function isAppliedEditResult(result: unknown): result is ApplyResult {
  if (!result || typeof result !== 'object') return false
  const ops = (result as ApplyResult).operations
  return Array.isArray(ops) && ops.some((op) => op?.status === 'applied')
}

type Verb = 'created' | 'edited' | 'archived'

interface FragmentChange {
  key: string
  fragmentId: string
  verb: Verb
  /** Only set for created fragments — the true inverse is a delete. */
  created: boolean
  diffs: Array<{ field: string; before: string; after: string }>
}

function verbFor(action: AppliedOperation['action']): Verb {
  if (action === 'create_fragment') return 'created'
  if (action === 'archive_fragment') return 'archived'
  return 'edited'
}

/** Collapse applied operations into one entry per touched fragment. */
export function collectChanges(operations: AppliedOperation[]): FragmentChange[] {
  const byFragment = new Map<string, FragmentChange>()
  for (const op of operations) {
    if (op.status !== 'applied') continue
    const fragmentId = op.createdFragmentId ?? op.target?.fragmentId
    if (!fragmentId) continue
    const verb = verbFor(op.action)
    const existing = byFragment.get(fragmentId)
    if (existing) {
      // A create wins over a co-located edit for verb/inverse purposes.
      if (verb === 'created') {
        existing.verb = 'created'
        existing.created = true
      }
      if (op.diffs?.length) existing.diffs.push(...op.diffs)
    } else {
      byFragment.set(fragmentId, {
        key: fragmentId,
        fragmentId,
        verb,
        created: op.action === 'create_fragment',
        diffs: op.diffs ? [...op.diffs] : [],
      })
    }
  }
  return [...byFragment.values()]
}

const VERB_ICON: Record<Verb, typeof FilePenLine> = {
  created: FilePlus2,
  edited: FilePenLine,
  archived: Archive,
}

/**
 * Renders an applied librarian fragment-change tool result as a single legible
 * card: one row per touched fragment with its diffs, plus an Undo that reverses
 * the change through existing fragment endpoints (revert edits, delete creates,
 * restore archives). Undo is session-only — chat tool calls are not persisted,
 * so after a reload per-fragment version history is the fallback.
 */
export function LibrarianEditCard({ storyId, result }: { storyId: string; result: ApplyResult }) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const [state, setState] = useState<'idle' | 'undoing' | 'done' | 'error'>('idle')

  const { data: fragments } = useQuery(q.fragments(storyId, branchId))
  const nameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const fragment of fragments ?? []) map.set(fragment.id, fragment.name)
    return map
  }, [fragments])

  const changes = useMemo(() => collectChanges(result.operations ?? []), [result])
  if (changes.length === 0) return null

  const handleUndo = async () => {
    setState('undoing')
    try {
      // Reverse through the shared, hash-guarded revert core (same path the
      // Story-tab proposal revert uses) — it refuses rather than clobbering a
      // fragment edited since this change landed.
      await api.fragments.revertApplied(storyId, result.appliedChanges ?? [])
      await queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
      setState('done')
    } catch {
      setState('error')
    }
  }

  return (
    <div className="my-1.5 rounded border border-border/40 bg-muted/20 text-[0.625rem]">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/20">
        <span className="text-muted-foreground">
          {changes.length === 1 ? '1 fragment change' : `${changes.length} fragment changes`}
        </span>
        <div className="ml-auto">
          {state === 'done' ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Check className="size-3" /> Undone
            </span>
          ) : state === 'error' ? (
            <span className="flex items-center gap-1 text-destructive">
              <AlertCircle className="size-3" /> Undo failed
            </span>
          ) : (
            <button
              onClick={handleUndo}
              disabled={state === 'undoing'}
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
            >
              {state === 'undoing' ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
              Undo
            </button>
          )}
        </div>
      </div>

      <div className={`px-2 py-1.5 space-y-2 ${state === 'done' ? 'opacity-50' : ''}`}>
        {changes.map((change) => {
          const Icon = VERB_ICON[change.verb]
          const name = nameById.get(change.fragmentId) ?? change.fragmentId
          return (
            <div key={change.key}>
              <div className="flex items-center gap-1.5">
                <Icon className="size-3 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground capitalize">{change.verb}</span>
                <span className="font-medium text-foreground truncate">{name}</span>
              </div>
              {change.diffs.length > 0 && (
                <div className="mt-1 space-y-1.5">
                  {change.diffs.map((diff, i) => (
                    <div key={`${change.key}-${i}`}>
                      <div className="text-muted-foreground/70 mb-0.5 capitalize">{diff.field}</div>
                      <div className="font-mono leading-relaxed">
                        <DiffRowsView rows={diffRows(diff.before, diff.after)} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
