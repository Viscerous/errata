import { describe, expect, it } from 'vitest'
import {
  buildAnalyzeStagePlan,
  describeAnalyzeToolStages,
} from '@/server/librarian/analyze-stages'
import { createEmptyCollector, createLibrarianOnlineTools } from '@/server/librarian/analysis-tools'
import { describeToolSurface } from '@/server/llm/tool-surface'

describe('librarian analyze tool stages', () => {
  it('builds one ordered request per available reporting task', () => {
    const stages = buildAnalyzeStagePlan([
      'reportAnalysis',
      'reportObservation',
      'reportContinuity',
      'reportMaintenance',
      'reportDirections',
    ])

    expect(stages.map((stage) => stage.id)).toEqual([
      'observation',
      'continuity',
      'maintenance',
      'directions',
    ])
    expect(stages.map((stage) => stage.toolNames)).toEqual([
      ['reportObservation'],
      ['reportContinuity'],
      ['reportMaintenance'],
      ['reportDirections'],
    ])
    expect(stages.find((stage) => stage.id === 'maintenance')?.conditional).toBe(true)
    expect(stages.filter((stage) => stage.id !== 'maintenance').every((stage) => !stage.conditional)).toBe(true)
  })

  it('uses the legacy combined report only when observation is unavailable', () => {
    expect(buildAnalyzeStagePlan(['reportAnalysis', 'reportDirections']).map((stage) => ({
      id: stage.id,
      toolName: stage.toolName,
    }))).toEqual([
      { id: 'observation', toolName: 'reportAnalysis' },
      { id: 'directions', toolName: 'reportDirections' },
    ])
  })

  it('returns no runnable plan without an observation report tool', () => {
    expect(buildAnalyzeStagePlan(['reportContinuity', 'reportDirections'])).toEqual([])
  })

  it('uses the same plan for context preview', () => {
    const available = ['reportObservation', 'reportContinuity', 'reportDirections']
    expect(describeAnalyzeToolStages(available)).toEqual(buildAnalyzeStagePlan(available))
  })

  it('keeps every isolated tool surface smaller than the combined surface', async () => {
    const toolSet = createLibrarianOnlineTools(createEmptyCollector(), {
      dataDir: '',
      storyId: '',
      proseFragmentId: 'pr-preview',
    })
    const surfaces = await Promise.all(
      Object.entries(toolSet).map(async ([name, tool]) => describeToolSurface(name, tool)),
    )
    const charactersByName = new Map(surfaces.map((surface) => [surface.name, surface.characters]))
    const combinedCharacters = charactersByName.get('reportAnalysis') ?? Number.POSITIVE_INFINITY

    for (const stage of describeAnalyzeToolStages(Object.keys(toolSet))) {
      if (stage.toolName === 'reportAnalysis') continue
      expect(charactersByName.get(stage.toolName), stage.toolName).toBeLessThan(combinedCharacters)
    }
  })
})
