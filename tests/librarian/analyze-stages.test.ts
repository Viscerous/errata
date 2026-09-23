import { describe, expect, it } from 'vitest'
import { buildAnalyzeStagePlan } from '@/server/librarian/analyze-stages'

describe('librarian analyze stages', () => {
  it('answers the passage in one request, then maintains records only on evidence', () => {
    const stages = buildAnalyzeStagePlan(['reportPassage', 'reportMaintenance'])

    expect(stages.map((stage) => [stage.id, stage.toolName, stage.conditional])).toEqual([
      ['passage', 'reportPassage', false],
      ['maintenance', 'reportMaintenance', true],
    ])
    expect(stages[0].directive).toBe('Perform only the passage-analysis task. Call reportPassage exactly once, then stop.')
  })

  it('runs the passage alone when record maintenance is unavailable', () => {
    expect(buildAnalyzeStagePlan(['reportPassage']).map((stage) => stage.id)).toEqual(['passage'])
  })

  it('returns no runnable plan without the passage report', () => {
    expect(buildAnalyzeStagePlan(['reportMaintenance'])).toEqual([])
  })
})
