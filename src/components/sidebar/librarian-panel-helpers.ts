import type { Fragment, LibrarianAnalysis } from '@/lib/api'

export type ProposalDiffItem = {
  key: string
  fieldLabel?: string
  before: string
  after: string
}

const DIFF_TEXT_LIMIT = 4000

export function mentionSourceCount(sourceFragmentIds: string[]): number {
  return new Set(sourceFragmentIds).size
}

export function mentionLinkCount(entries: Array<[string, string[]]>): number {
  return entries.reduce((sum, [, sourceFragmentIds]) => sum + mentionSourceCount(sourceFragmentIds), 0)
}

export function operationActionLabel(action: string): string {
  const labels: Record<string, string> = {
    create_fragment: 'create',
    replace_text: 'replace',
    append_paragraph: 'append',
    set_fields: 'rewrite',
    archive_fragment: 'archive',
  }
  return labels[action] ?? action
}

export function clipDiffText(text: string): string {
  return text.length <= DIFF_TEXT_LIMIT ? text : `${text.slice(0, DIFF_TEXT_LIMIT)}\n...`
}

export function proposalOperationTarget(
  operation: LibrarianAnalysis['fragmentChangeProposals'][number]['operations'][number],
  validation: LibrarianAnalysis['fragmentChangeProposals'][number]['validation'][number] | undefined,
  fragmentById: Map<string, Fragment>,
): string {
  if (operation.action === 'create_fragment') {
    return typeof operation.name === 'string' ? operation.name : 'New fragment'
  }
  const fragmentId = typeof operation.fragmentId === 'string' ? operation.fragmentId : validation?.target?.fragmentId
  return fragmentId ? fragmentById.get(fragmentId)?.name ?? fragmentId : 'Fragment'
}

export function proposalOperationDiffItems(
  proposal: LibrarianAnalysis['fragmentChangeProposals'][number],
): Map<number, ProposalDiffItem[]> {
  const byOperation = new Map<number, ProposalDiffItem[]>()
  const validations = proposal.appliedResults?.length ? proposal.appliedResults : proposal.validation
  validations.forEach((validation, validationIndex) => {
    const operation = proposal.operations.find((candidate) =>
      candidate.operationId && candidate.operationId === validation.operationId,
    ) ?? proposal.operations[validationIndex]
    const operationIndex = operation ? proposal.operations.indexOf(operation) : validationIndex
    const items = byOperation.get(operationIndex) ?? []
    if (validation.action === 'archive_fragment' && validation.status !== 'invalid') {
      items.push({
        key: `${validation.operationId}-${validationIndex}-archive`,
        fieldLabel: 'state',
        before: 'Active fragment',
        after: 'Archived fragment',
      })
    } else {
      for (const [diffIndex, diff] of (validation.diffs ?? []).entries()) {
        items.push({
          key: `${validation.operationId}-${diff.field}-${diffIndex}`,
          fieldLabel: diff.field,
          before: diff.before,
          after: diff.after,
        })
      }
    }
    if (items.length > 0) byOperation.set(operationIndex, items)
  })
  return byOperation
}
