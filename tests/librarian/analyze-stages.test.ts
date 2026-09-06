import { describe, expect, it } from 'vitest'
import {
  describeAnalyzeToolStages,
  selectAnalyzeToolStage,
  type AnalyzeStep,
} from '@/server/librarian/analyze-stages'
import { createEmptyCollector, createLibrarianOnlineTools } from '@/server/librarian/analysis-tools'
import { describeToolSurface } from '@/server/llm/tool-surface'

const tools = [
  'reportAnalysis',
  'readFragments',
  'proposeRecordCorrections',
  'proposeDirections',
  'finishAnalysis',
]

function step(...toolResults: Array<{ toolName: string; output: unknown }>): AnalyzeStep {
  return { toolResults }
}

describe('librarian analyze tool stages', () => {
  it('starts with only the observation contract', () => {
    expect(selectAnalyzeToolStage(tools, [])).toEqual({
      stage: 'observation',
      activeTools: ['reportAnalysis'],
    })
  })

  it('keeps only the report contract while observation needs correction', () => {
    expect(selectAnalyzeToolStage(tools, [
      step({ toolName: 'reportAnalysis', output: { ok: false, skippedContinuity: [{}] } }),
    ])).toEqual({
      stage: 'observation',
      activeTools: ['reportAnalysis'],
    })
  })

  it('moves directly to the smaller follow-up surface after a settled report', () => {
    expect(selectAnalyzeToolStage(tools, [
      step({ toolName: 'reportAnalysis', output: { ok: true } }),
    ])).toEqual({
      stage: 'follow-up',
      activeTools: ['readFragments', 'proposeRecordCorrections', 'proposeDirections', 'finishAnalysis'],
    })
  })

  it('keeps the report available for one record-inspection step', () => {
    expect(selectAnalyzeToolStage(tools, [
      step({
        toolName: 'reportAnalysis',
        output: { ok: true, resolvedFragments: [{ id: 'ch-1', content: '[1] Existing claim.' }] },
      }),
    ])).toEqual({
      stage: 'inspection',
      activeTools: tools,
    })
  })

  it('retires the report after inspection proceeds without another report', () => {
    expect(selectAnalyzeToolStage(tools, [
      step({
        toolName: 'reportAnalysis',
        output: { ok: true, resolvedFragments: [{ id: 'ch-1' }] },
      }),
      step({ toolName: 'proposeDirections', output: { ok: true } }),
    ])).toEqual({
      stage: 'follow-up',
      activeTools: ['readFragments', 'proposeRecordCorrections', 'proposeDirections', 'finishAnalysis'],
    })
  })

  it('keeps reporting available after an inspection read', () => {
    expect(selectAnalyzeToolStage(tools, [
      step({
        toolName: 'reportAnalysis',
        output: { ok: true, resolvedFragments: [{ id: 'ch-1' }] },
      }),
      step({ toolName: 'readFragments', output: { fragments: [{ id: 'kn-1' }] } }),
    ])).toEqual({
      stage: 'inspection',
      activeTools: tools,
    })
  })

  it('uses the un-staged surface when the report tool is disabled', () => {
    const available = ['readFragments', 'finishAnalysis']
    expect(selectAnalyzeToolStage(available, [])).toEqual({
      stage: 'follow-up',
      activeTools: available,
    })
    expect(describeAnalyzeToolStages(available)).toEqual([])
  })

  it('describes the same three surfaces for the context preview', () => {
    const stages = describeAnalyzeToolStages(tools)
    expect(stages.map((stage) => stage.id)).toEqual(['observation', 'inspection', 'follow-up'])
    expect(stages[0].toolNames).toEqual(['reportAnalysis'])
    expect(stages[1]).toMatchObject({ conditional: true, toolNames: tools })
    expect(stages[2].toolNames).not.toContain('reportAnalysis')
  })

  it('makes both routine requests smaller than the unstaged tool surface', async () => {
    const toolSet = createLibrarianOnlineTools(createEmptyCollector(), {
      dataDir: '',
      storyId: '',
      proseFragmentId: 'pr-preview',
    })
    const surfaces = await Promise.all(
      Object.entries(toolSet).map(async ([name, tool]) => describeToolSurface(name, tool)),
    )
    const charactersByName = new Map(surfaces.map((surface) => [surface.name, surface.characters]))
    const totalCharacters = surfaces.reduce((sum, surface) => sum + surface.characters, 0)
    const stageCharacters = describeAnalyzeToolStages(Object.keys(toolSet)).map((stage) => ({
      id: stage.id,
      characters: stage.toolNames.reduce((sum, name) => sum + (charactersByName.get(name) ?? 0), 0),
    }))

    expect(stageCharacters.find((stage) => stage.id === 'observation')!.characters).toBeLessThan(totalCharacters)
    expect(stageCharacters.find((stage) => stage.id === 'follow-up')!.characters).toBeLessThan(totalCharacters)
    expect(stageCharacters.find((stage) => stage.id === 'inspection')!.characters).toBe(totalCharacters)
  })
})
