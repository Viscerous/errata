import type { SuggestionDirection } from '@/lib/api/types'

interface MergeDirectionSuggestionsArgs {
  manualSuggestions: SuggestionDirection[] | null
  manualAnchor?: string
  latestFragmentId?: string
  analysisDirections: SuggestionDirection[]
  latestAnalysisId: string | null
  invalidatedAnalysisId: string | null
}

export function mergeDirectionSuggestions({
  manualSuggestions,
  manualAnchor,
  latestFragmentId,
  analysisDirections,
  latestAnalysisId,
  invalidatedAnalysisId,
}: MergeDirectionSuggestionsArgs): SuggestionDirection[] {
  const manualIsCurrent = manualSuggestions !== null && manualAnchor === latestFragmentId
  const base = manualIsCurrent ? manualSuggestions : []
  const analysisIsInvalidated = latestAnalysisId !== null && latestAnalysisId === invalidatedAnalysisId

  if (analysisIsInvalidated) {
    return base
  }

  const baseTitles = new Set(base.map((suggestion) => suggestion.title))
  const extra = analysisDirections.filter((suggestion) => !baseTitles.has(suggestion.title))
  return [...base, ...extra]
}
