export function describeVersionReason(reason?: string, isLatest = false): string | null {
  if (!reason) return null
  switch (reason) {
    case 'created': return 'Created'
    case 'autosave': return isLatest ? 'Autosaved' : 'Edited'
    case 'manual-update': return 'Edited'
    case 'llm-applyProposedChanges': return 'AI edit'
    case 'librarian-manual-accept': return 'Librarian'
    case 'librarian-auto-apply': return 'Librarian (auto)'
    case 'librarian-revert-proposal': return 'Librarian revert'
  }
  if (reason.startsWith('librarian-')) return 'Librarian'
  return reason
}
