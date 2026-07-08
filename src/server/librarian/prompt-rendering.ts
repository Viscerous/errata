export interface LibrarianObservationPrompt {
  summaryUpdate?: string
  events?: string[]
  stateChanges?: string[]
  openThreads?: string[]
  mentionedFragmentIds?: string[]
  candidateFragmentIds?: string[]
}

export function renderLibrarianObservation(
  observation: LibrarianObservationPrompt | null | undefined,
  options: {
    emptyText?: string
    candidateLabel?: string
  } = {},
): string {
  const emptyText = options.emptyText ?? '(none)'
  if (!observation) return emptyText

  const parts = [
    observation.summaryUpdate ? `Summary: ${observation.summaryUpdate}` : undefined,
    observation.events?.length ? `Events:\n${observation.events.map((event) => `- ${event}`).join('\n')}` : undefined,
    observation.stateChanges?.length ? `State changes:\n${observation.stateChanges.map((change) => `- ${change}`).join('\n')}` : undefined,
    observation.openThreads?.length ? `Open threads:\n${observation.openThreads.map((thread) => `- ${thread}`).join('\n')}` : undefined,
    observation.mentionedFragmentIds?.length ? `Mentioned fragments: ${observation.mentionedFragmentIds.join(', ')}` : undefined,
    observation.candidateFragmentIds?.length
      ? `${options.candidateLabel ?? 'Candidate fragments'}: ${observation.candidateFragmentIds.join(', ')}`
      : undefined,
  ].filter((part): part is string => Boolean(part))

  return parts.join('\n\n') || emptyText
}
