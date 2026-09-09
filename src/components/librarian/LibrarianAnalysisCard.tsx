import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight, MessageSquare, Trash2, X } from 'lucide-react'
import {
  api,
  type CustomFragmentType,
  type Fragment,
  type LibrarianAnalysis,
  type LibrarianAnalysisProgress,
  type LibrarianAnalysisSummary,
} from '@/lib/api'
import { continuityKeyLabel } from '@/lib/continuity-keys'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { buildMentionGroups, type MentionEntry } from './librarian-mention-groups'
import { LibrarianSuggestionList } from './LibrarianSuggestionList'
import { LibrarianTraceViewer } from './LibrarianTraceViewer'

interface LibrarianAnalysisCardProps {
  storyId: string
  summary: LibrarianAnalysisSummary
  expanded: boolean
  analysis: LibrarianAnalysis | null
  onToggle: () => void
  onOpenChat?: (message: string) => void
  charName: (id: string) => string
  fragmentById: Map<string, Fragment>
  customTypeByType: Map<string, CustomFragmentType>
  provisionalStage?: LibrarianAnalysisProgress['stage']
}

export function LibrarianAnalysisCard({
  storyId,
  summary,
  expanded,
  analysis,
  onToggle,
  onOpenChat,
  charName,
  fragmentById,
  customTypeByType,
  provisionalStage,
}: LibrarianAnalysisCardProps) {
  const queryClient = useQueryClient()
  const [editingSummary, setEditingSummary] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState('')
  const time = new Date(summary.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  useEffect(() => setSummaryDraft(analysis?.summaryUpdate ?? ''), [analysis?.summaryUpdate])

  const invalidateAnalysis = () => {
    queryClient.invalidateQueries({ queryKey: ['librarian-analyses', storyId] })
    queryClient.invalidateQueries({ queryKey: ['librarian-analysis', storyId, summary.id] })
  }
  const deleteAnalysis = useMutation({
    mutationFn: () => api.librarian.deleteAnalysis(storyId, summary.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['librarian-analyses', storyId] }),
  })
  const updateSummary = useMutation({
    mutationFn: (summaryUpdate: string) => api.librarian.updateAnalysis(storyId, summary.id, { summaryUpdate }),
    onSuccess: () => {
      invalidateAnalysis()
      queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
      queryClient.invalidateQueries({ queryKey: ['story', storyId] })
      setEditingSummary(false)
    },
  })
  const dismissContradiction = useMutation({
    mutationFn: (index: number) => api.librarian.dismissContradiction(storyId, summary.id, index),
    onSuccess: invalidateAnalysis,
  })

  const mentionGroups = useMemo(
    () => buildMentionGroups(
      [...new Set((analysis?.mentions ?? []).map(mention => mention.fragmentId))]
        .map(fragmentId => [fragmentId, []] as MentionEntry),
      fragmentById,
      customTypeByType,
    ),
    [analysis?.mentions, fragmentById, customTypeByType],
  )
  const provisionalLabel = provisionalStage === 'inspection'
    ? 'Checking records'
    : provisionalStage === 'record-maintenance'
      ? 'Reviewing memory'
      : provisionalStage === 'directions'
        ? 'Adding directions'
        : 'Analyzing'

  return (
    <article
      className={cn(
        'overflow-hidden rounded-md border',
        provisionalStage ? 'border-blue-400/25 bg-blue-400/[0.03]' : 'border-border/25',
      )}
      data-component-id="librarian-analysis-card"
    >
      <div className="flex w-full items-center gap-1.5 px-2.5 py-2 text-ui-label transition-colors hover:bg-accent/30">
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
          <span className="truncate font-mono text-foreground/60">{summary.fragmentId}</span>
          {provisionalStage ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-blue-500/80">
              <span className="size-1.5 animate-pulse rounded-full bg-blue-400" />
              {provisionalLabel}
            </span>
          ) : <span className="shrink-0 text-muted-foreground">{time}</span>}
          <AnalysisCounts summary={summary} />
        </button>
        {!provisionalStage && (
          <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => deleteAnalysis.mutate()} disabled={deleteAnalysis.isPending} title="Delete analysis">
            <Trash2 />
          </Button>
        )}
      </div>

      {expanded && analysis && (
        <div className="space-y-2.5 border-t border-border/15 bg-muted/10 px-3 py-2.5 text-ui-label">
          <SummaryEditor
            value={analysis.summaryUpdate}
            draft={summaryDraft}
            editing={editingSummary}
            provisional={!!provisionalStage}
            saving={updateSummary.isPending}
            onDraftChange={setSummaryDraft}
            onEdit={() => setEditingSummary(true)}
            onCancel={() => { setSummaryDraft(analysis.summaryUpdate); setEditingSummary(false) }}
            onSave={() => updateSummary.mutate(summaryDraft.trim())}
          />

          {analysis.continuityProjection && (
            <ContinuityNotes
              projection={analysis.continuityProjection}
              stale={!!summary.continuityStale}
              charName={charName}
            />
          )}

          {mentionGroups.map(group => (
            <div key={group.type} className="flex flex-wrap items-center gap-1">
              <span className="mr-1"><FieldLabel>{group.visual.label}</FieldLabel></span>
              {group.entries.map(([id]) => <Badge key={id} variant="outline" className="h-4 px-1.5 text-ui-label">{charName(id)}</Badge>)}
            </div>
          ))}

          <Contradictions
            analysis={analysis}
            fragmentId={summary.fragmentId}
            provisional={!!provisionalStage}
            pending={dismissContradiction.isPending}
            onDismiss={index => dismissContradiction.mutate(index)}
            onOpenChat={onOpenChat}
          />

          {analysis.fragmentChangeProposals.length > 0 && (
            <LibrarianSuggestionList
              storyId={storyId}
              analysisId={summary.id}
              proposals={analysis.fragmentChangeProposals}
              fragmentById={fragmentById}
              provisional={!!provisionalStage}
            />
          )}

          {analysis.timelineEvents.length > 0 && (
            <div className="space-y-1">
              <FieldLabel>Timeline events</FieldLabel>
              <AnalysisList marker={false} items={analysis.timelineEvents.map(event => ({
                key: `${event.position}-${event.event}`,
                content: <><Badge variant="outline" className="mr-1 h-4 px-1 align-middle text-ui-label">{event.position}</Badge>{event.event}</>,
              }))} />
            </div>
          )}

          {analysis.passes && analysis.passes.length > 0 && <AnalysisPasses passes={analysis.passes} />}
          {!!analysis.trace?.length && <LibrarianTraceViewer trace={analysis.trace} />}
        </div>
      )}
    </article>
  )
}

function AnalysisCounts({ summary }: { summary: LibrarianAnalysisSummary }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {summary.continuityStale && (
        <span className="inline-flex size-4 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400" title="The prose changed after this analysis. Re-analyze it to restore continuity notes.">
          <AlertTriangle className="size-2.5" />
        </span>
      )}
      {summary.contradictionCount > 0 && <span className="inline-flex size-4 items-center justify-center rounded-full bg-destructive/15 font-mono text-ui-label text-destructive">{summary.contradictionCount}</span>}
      {summary.pendingSuggestionCount > 0 && <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary/10 font-mono text-ui-label text-primary">{summary.pendingSuggestionCount}</span>}
    </span>
  )
}

function SummaryEditor({ value, draft, editing, provisional, saving, onDraftChange, onEdit, onCancel, onSave }: {
  value: string
  draft: string
  editing: boolean
  provisional: boolean
  saving: boolean
  onDraftChange: (value: string) => void
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>Summary update</FieldLabel>
        {!provisional && (!editing ? (
          <Button type="button" size="xs" variant="ghost" onClick={onEdit}>Edit</Button>
        ) : (
          <div className="flex items-center gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="button" size="xs" onClick={onSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
          </div>
        ))}
      </div>
      {editing ? (
        <Textarea value={draft} onChange={event => onDraftChange(event.target.value)} className="mt-1.5 min-h-[88px] resize-y bg-background/50 text-ui-label leading-relaxed" placeholder="Summary update..." />
      ) : value ? (
        <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-foreground/65">{value}</p>
      ) : <p className="mt-0.5 italic text-muted-foreground">No summary update</p>}
    </div>
  )
}

function ContinuityNotes({ projection, stale, charName }: {
  projection: NonNullable<LibrarianAnalysis['continuityProjection']>
  stale: boolean
  charName: (id: string) => string
}) {
  const threadRows = threadContinuityRows(projection.threadOperations, projection.threadFocus)
  return (
    <div className="space-y-1.5">
      <FieldLabel>Continuity notes</FieldLabel>
      {stale && <p className="leading-relaxed text-amber-600 dark:text-amber-400">The prose changed after this analysis, so these notes are excluded from story continuity. Re-analyze this passage to rebuild them.</p>}
      <InlineField label="Scene frame">
        {projection.scene.transition}
        {projection.scene.line ? ` — ${projection.scene.line}` : ''}
        {projection.scene.location ? ` — ${projection.scene.location.label}` : ''}
        {projection.scene.time ? ` — ${projection.scene.time.label}` : ''}
      </InlineField>
      {projection.stateOperations.length > 0 && (
        <div><SubLabel>Current state</SubLabel><AnalysisList items={projection.stateOperations.map((operation, index) => ({
          key: `state-${index}`,
          content: operation.action === 'clear'
            ? `${operation.stateKey}: no longer current`
            : `${operation.subject.label} — ${operation.facet}${operation.slot ? `/${operation.slot}` : ''}: ${operation.value} (${operation.scope}${operation.until ? ` until ${operation.until.label}` : ''}, ${operation.certainty})`,
        }))} /></div>
      )}
      {threadRows.length > 0 && <div><SubLabel>Unresolved threads</SubLabel><AnalysisList items={threadRows} /></div>}
      {projection.knowledgeOperations.length > 0 && (
        <div><SubLabel>Character awareness</SubLabel><AnalysisList items={projection.knowledgeOperations.map((operation, index) => ({ key: `knowledge-${index}`, content: `${charName(operation.characterId)}: ${operation.action}${operation.fact ? ` — ${operation.fact}` : ''}` }))} /></div>
      )}
    </div>
  )
}

function Contradictions({ analysis, fragmentId, provisional, pending, onDismiss, onOpenChat }: {
  analysis: LibrarianAnalysis
  fragmentId: string
  provisional: boolean
  pending: boolean
  onDismiss: (index: number) => void
  onOpenChat?: (message: string) => void
}) {
  const visible = analysis.contradictions.map((contradiction, index) => ({ contradiction, index })).filter(({ contradiction }) => !contradiction.dismissed)
  if (visible.length === 0) return null
  return (
    <div className="space-y-1.5">
      <FieldLabel tone="destructive">Contradictions</FieldLabel>
      {visible.map(({ contradiction, index }) => {
        const references = [...new Set([fragmentId, ...contradiction.fragmentIds])]
        return (
          <div key={`${contradiction.fragmentIds.join('-')}-${index}`} className="rounded-md border border-destructive/10 bg-destructive/5 p-2">
            <div className="flex items-start justify-between gap-1">
              <div>
                <p className="text-foreground/70">{contradiction.description}</p>
                {contradiction.fragmentIds.length > 0 && <p className="mt-0.5 font-mono text-ui-label text-muted-foreground">{contradiction.fragmentIds.join(', ')}</p>}
              </div>
              {!provisional && (
                <div className="flex shrink-0 items-center gap-0.5">
                  {onOpenChat && (
                    <Button type="button" size="xs" variant="ghost" className="text-destructive/60 hover:text-destructive" onClick={() => onOpenChat(`Review and fix this contradiction if it is valid: ${contradiction.description}\n\n${references.map(id => `@${id}`).join(' ')}`)}>
                      <MessageSquare />Review
                    </Button>
                  )}
                  <Button type="button" size="icon-xs" variant="ghost" title="Dismiss contradiction" aria-label="Dismiss contradiction" disabled={pending} onClick={() => onDismiss(index)}><X /></Button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AnalysisPasses({ passes }: { passes: NonNullable<LibrarianAnalysis['passes']> }) {
  return (
    <div className="space-y-1">
      <FieldLabel>Passes</FieldLabel>
      <div className="flex flex-wrap gap-1">
        {passes.map((pass, index) => (
          <span key={`${pass.name}-${index}`} className={cn(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-ui-label',
            pass.status === 'complete' && 'border-emerald-500/15 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
            pass.status === 'skipped' && 'border-muted bg-muted/20 text-muted-foreground',
            pass.status === 'failed' && 'border-destructive/15 bg-destructive/5 text-destructive/80',
          )} title={pass.error ?? pass.reason ?? undefined}>
            <span>{pass.name}</span><span className="opacity-70">{pass.status}</span>
            {typeof pass.durationMs === 'number' && <span className="opacity-60">{Math.round(pass.durationMs)}ms</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

function FieldLabel({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'destructive' }) {
  return <span className={cn('text-ui-label font-medium uppercase tracking-[0.12em]', tone === 'muted' ? 'text-muted-foreground' : 'text-destructive/70')}>{children}</span>
}
function SubLabel({ children }: { children: ReactNode }) {
  return <span className="block text-ui-label uppercase tracking-[0.08em] text-foreground/40">{children}</span>
}
function InlineField({ label, children }: { label: string; children: ReactNode }) {
  return <p className="flex flex-wrap items-baseline gap-x-1.5"><SubLabel>{label}</SubLabel><span className="leading-relaxed text-foreground/60">{children}</span></p>
}
function AnalysisList({ items, marker = true }: { items: Array<{ key: string; content: ReactNode }>; marker?: boolean }) {
  return <ul className="mt-0.5 space-y-0.5">{items.map(item => <li key={item.key} className="leading-relaxed text-foreground/60">{marker ? '- ' : ''}{item.content}</li>)}</ul>
}

const THREAD_ACTION_LABELS: Record<string, string> = { open: 'opened', advance: 'advanced', resolve: 'resolved', abandon: 'abandoned' }
export function threadContinuityRows(
  operations: Array<{ threadKey: string; action: string; label?: string }>,
  focus: Array<{ threadKey: string; visibility: string }>,
): Array<{ key: string; content: ReactNode }> {
  type ThreadRow = { label: string; actions: string[]; visibility?: string }
  const rows = new Map<string, ThreadRow>()
  const rowFor = (threadKey: string, label?: string) => {
    const existing = rows.get(threadKey)
    if (existing) { if (label) existing.label = label; return existing }
    const created: ThreadRow = { label: label ?? continuityKeyLabel(threadKey), actions: [] }
    rows.set(threadKey, created)
    return created
  }
  for (const operation of operations) rowFor(operation.threadKey, operation.label).actions.push(THREAD_ACTION_LABELS[operation.action] ?? operation.action)
  for (const entry of focus) rowFor(entry.threadKey).visibility = entry.visibility
  return [...rows.entries()].map(([threadKey, row]) => ({
    key: `continuity-thread-${threadKey}`,
    content: [row.label, [...row.actions, ...(row.visibility ? [`in the ${row.visibility}`] : [])].join(', ')].filter(Boolean).join(' — '),
  }))
}
