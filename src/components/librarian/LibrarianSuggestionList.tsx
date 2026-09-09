import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, Plus, Undo2, Wrench, X } from 'lucide-react'
import { api, type Fragment, type LibrarianAnalysis } from '@/lib/api'
import { diffRows } from '@/lib/diff'
import { cn } from '@/lib/utils'
import { DiffRowsView } from '@/components/DiffRowsView'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  clipDiffText,
  operationActionLabel,
  proposalOperationDiffItems,
  proposalOperationTarget,
  type ProposalDiffItem,
} from '@/components/sidebar/librarian-panel-helpers'

interface LibrarianSuggestionListProps {
  storyId: string
  analysisId: string
  proposals: LibrarianAnalysis['fragmentChangeProposals']
  fragmentById: Map<string, Fragment>
  provisional?: boolean
}

export function LibrarianSuggestionList({
  storyId,
  analysisId,
  proposals,
  fragmentById,
  provisional = false,
}: LibrarianSuggestionListProps) {
  const queryClient = useQueryClient()
  const [expandedDiffs, setExpandedDiffs] = useState<Record<number, boolean>>({})

  const invalidateProposalData = () => {
    queryClient.invalidateQueries({ queryKey: ['librarian-analyses', storyId] })
    queryClient.invalidateQueries({ queryKey: ['librarian-analysis', storyId, analysisId] })
    queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
    queryClient.invalidateQueries({ queryKey: ['fragments-archived', storyId] })
  }

  const accept = useMutation({
    mutationFn: (index: number) => api.librarian.acceptChangeProposal(storyId, analysisId, index),
    onSettled: invalidateProposalData,
  })
  const revert = useMutation({
    mutationFn: (index: number) => api.librarian.revertChangeProposal(storyId, analysisId, index),
    onSuccess: invalidateProposalData,
  })
  const dismiss = useMutation({
    mutationFn: (index: number) => api.librarian.dismissChangeProposal(storyId, analysisId, index),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['librarian-analyses', storyId] })
      queryClient.invalidateQueries({ queryKey: ['librarian-analysis', storyId, analysisId] })
    },
  })
  const error = accept.error ?? revert.error ?? dismiss.error

  return (
    <div className="space-y-1.5" data-component-id="librarian-suggestions">
      <span className="text-ui-label font-medium uppercase tracking-[0.12em] text-primary/70">Suggestions</span>
      {proposals.map((proposal, index) => {
        const title = proposal.title?.trim()
          || `${proposal.operations.length} fragment change${proposal.operations.length === 1 ? '' : 's'}`
        const validationResults = proposal.appliedResults?.length ? proposal.appliedResults : proposal.validation
        const diffItemsByOperation = proposalOperationDiffItems(proposal)
        const diffCount = [...diffItemsByOperation.values()].reduce((count, items) => count + items.length, 0)
        const diffExpanded = expandedDiffs[index] === true
        const canRevert = proposal.accepted === true && (proposal.appliedChanges?.length ?? 0) > 0

        return (
          <article
            key={`proposal-${analysisId}-${index}`}
            className={cn(
              'rounded-md border p-2',
              proposal.accepted
                ? 'border-emerald-500/10 bg-emerald-500/5'
                : 'border-primary/10 bg-primary/5',
            )}
          >
            <div className="flex items-start justify-between gap-1">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="outline" className="h-4 gap-0.5 px-1 text-ui-label">
                    <Wrench className="size-2" />
                    proposal
                  </Badge>
                  <span className="font-medium text-foreground/70">{title}</span>
                  <Badge variant="outline" className="h-4 px-1 text-ui-label">
                    {proposal.operations.length} op{proposal.operations.length === 1 ? '' : 's'}
                  </Badge>
                  {proposal.accepted && (
                    <Badge variant="secondary" className="h-4 gap-0.5 px-1 text-ui-label">
                      <Check className="size-2" />
                      Applied
                    </Badge>
                  )}
                  {proposal.accepted && proposal.autoApplied && (
                    <Badge variant="outline" className="h-4 px-1 text-ui-label">Auto</Badge>
                  )}
                  {diffCount > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-5 px-1 text-muted-foreground"
                      aria-expanded={diffExpanded}
                      onClick={(event) => {
                        event.stopPropagation()
                        setExpandedDiffs(current => ({ ...current, [index]: !diffExpanded }))
                      }}
                    >
                      {diffExpanded ? <ChevronDown /> : <ChevronRight />}
                      Diff
                    </Button>
                  )}
                </div>
              </div>
              <SuggestionControls
                proposal={proposal}
                provisional={provisional}
                canRevert={canRevert}
                pending={accept.isPending || revert.isPending || dismiss.isPending}
                onAccept={() => accept.mutate(index)}
                onDismiss={() => dismiss.mutate(index)}
                onRevert={() => revert.mutate(index)}
              />
            </div>

            {proposal.rationale && <p className="mt-0.5 break-words text-muted-foreground">{proposal.rationale}</p>}
            {proposal.evidenceText && (
              <p className="mt-0.5 break-words italic text-muted-foreground/80">Evidence: “{proposal.evidenceText}”</p>
            )}

            <div className="mt-1 space-y-0.5">
              {proposal.operations.slice(0, 5).map((operation, operationIndex) => {
                const validation = validationResults.find(result => result.operationId === operation.operationId)
                  ?? validationResults[operationIndex]
                const operationDiffItems = diffItemsByOperation.get(operationIndex) ?? []
                return (
                  <div key={operation.operationId ?? operationIndex} className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1 text-ui-label text-muted-foreground">
                      <Badge variant="outline" className="h-4 shrink-0 px-1 text-ui-label">
                        {operationActionLabel(operation.action)}
                      </Badge>
                      <span className="truncate">
                        {proposalOperationTarget(operation, validation, fragmentById)}
                        {validation?.target?.field ? `.${validation.target.field}` : ''}
                      </span>
                    </div>
                    {diffExpanded && operationDiffItems.length > 0 && <OperationDiffPreview items={operationDiffItems} />}
                  </div>
                )
              })}
              {proposal.operations.length > 5 && (
                <p className="text-ui-label text-muted-foreground">+{proposal.operations.length - 5} more</p>
              )}
            </div>
            {proposal.sourceFragmentId && (
              <p className="mt-0.5 font-mono text-ui-label text-muted-foreground">from {proposal.sourceFragmentId}</p>
            )}
          </article>
        )
      })}
      {error && (
        <p className="rounded-md border border-destructive/10 bg-destructive/5 px-2 py-1 text-ui-label leading-relaxed text-destructive/80">
          {error instanceof Error ? error.message : 'Suggestion action failed.'}
        </p>
      )}
    </div>
  )
}

function SuggestionControls({
  proposal,
  provisional,
  canRevert,
  pending,
  onAccept,
  onDismiss,
  onRevert,
}: {
  proposal: LibrarianAnalysis['fragmentChangeProposals'][number]
  provisional: boolean
  canRevert: boolean
  pending: boolean
  onAccept: () => void
  onDismiss: () => void
  onRevert: () => void
}) {
  if (proposal.dismissed) {
    return (
      <span className="shrink-0 text-ui-label italic text-muted-foreground" title={proposal.stale ? proposal.staleReason : undefined}>
        {proposal.stale ? 'no longer applicable' : 'dismissed'}
      </span>
    )
  }
  if (provisional || (proposal.accepted && !canRevert)) return null

  return (
    <div className="flex shrink-0 gap-0.5">
      {!proposal.accepted && (
        <>
          <Button type="button" size="icon-xs" variant="ghost" onClick={onAccept} disabled={pending} title="Apply suggestion">
            <Plus />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" className="hover:text-destructive" onClick={onDismiss} disabled={pending} title="Dismiss suggestion">
            <X />
          </Button>
        </>
      )}
      {canRevert && (
        <Button type="button" size="icon-xs" variant="ghost" className="hover:text-destructive" onClick={onRevert} disabled={pending} title="Revert suggestion">
          <Undo2 />
        </Button>
      )}
    </div>
  )
}

function OperationDiffPreview({ items }: { items: ProposalDiffItem[] }) {
  return (
    <div className="mt-1.5 space-y-2 border-t border-border/20 pt-1.5 text-ui-label leading-4">
      {items.map((item) => {
        const rows = diffRows(clipDiffText(item.before), clipDiffText(item.after))
        if (rows.length === 0) return null
        return (
          <div key={item.key} className="space-y-0.5">
            {items.length > 1 && item.fieldLabel && (
              <p className="text-ui-label uppercase tracking-wide text-muted-foreground/70">{item.fieldLabel}</p>
            )}
            <div className="-mx-2 min-w-0 overflow-hidden">
              <DiffRowsView rows={rows} rowClassName="px-2" />
            </div>
          </div>
        )
      })}
    </div>
  )
}
