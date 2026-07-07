import { describe, expect, it } from 'vitest'
import { mergeDirectionSuggestions } from '@/components/prose/direction-suggestions'
import type { SuggestionDirection } from '@/lib/api/types'

const direction = (title: string): SuggestionDirection => ({
  title,
  description: `${title} description`,
  instruction: `${title} instruction`,
})

describe('mergeDirectionSuggestions', () => {
  it('appends current analysis directions when they have not been invalidated', () => {
    expect(mergeDirectionSuggestions({
      manualSuggestions: [direction('Manual')],
      manualAnchor: 'fragment-1',
      latestFragmentId: 'fragment-1',
      analysisDirections: [direction('Analysis')],
      latestAnalysisId: 'analysis-1',
      invalidatedAnalysisId: null,
    }).map((suggestion) => suggestion.title)).toEqual(['Manual', 'Analysis'])
  })

  it('does not re-append analysis directions after refresh invalidates that analysis', () => {
    expect(mergeDirectionSuggestions({
      manualSuggestions: [direction('Fresh manual')],
      manualAnchor: 'fragment-1',
      latestFragmentId: 'fragment-1',
      analysisDirections: [direction('Stale analysis')],
      latestAnalysisId: 'analysis-1',
      invalidatedAnalysisId: 'analysis-1',
    }).map((suggestion) => suggestion.title)).toEqual(['Fresh manual'])
  })

  it('allows directions from a later analysis', () => {
    expect(mergeDirectionSuggestions({
      manualSuggestions: [direction('Fresh manual')],
      manualAnchor: 'fragment-1',
      latestFragmentId: 'fragment-1',
      analysisDirections: [direction('New analysis')],
      latestAnalysisId: 'analysis-2',
      invalidatedAnalysisId: 'analysis-1',
    }).map((suggestion) => suggestion.title)).toEqual(['Fresh manual', 'New analysis'])
  })
})
