import { describe, expect, it } from 'vitest'
import {
  describeAnalyzeToolStages,
  isAnalyzeWorkflowComplete,
  selectAnalyzeToolStage,
  type AnalyzeStep,
} from '@/server/librarian/analyze-stages'
import { createEmptyCollector, createLibrarianOnlineTools } from '@/server/librarian/analysis-tools'
import { describeToolSurface } from '@/server/llm/tool-surface'

const tools = [
  'reportAnalysis',
  'readFragments',
  'proposeRecordCorrections',
  'proposeNewRecords',
  'proposeDirections',
  'finishAnalysis',
]

function step(...toolResults: Array<{ toolName: string; output: unknown }>): AnalyzeStep {
  return { toolResults }
}

describe('librarian analyze tool stages', () => {
  it('keeps the common path in one request while omitting inspection and finish tools', () => {
    expect(selectAnalyzeToolStage(tools, [])).toEqual({
      stage: 'primary',
      activeTools: [
        'reportAnalysis',
        'proposeRecordCorrections',
        'proposeNewRecords',
        'proposeDirections',
      ],
    })
  })

  it('completes deterministically after required work succeeds', () => {
    expect(isAnalyzeWorkflowComplete(tools, [step(
      { toolName: 'reportAnalysis', output: { ok: true } },
      { toolName: 'proposeDirections', output: { ok: true } },
    )])).toBe(true)
  })

  it('does not require an optional proposal that was never called', () => {
    expect(isAnalyzeWorkflowComplete(tools, [step(
      { toolName: 'reportAnalysis', output: { ok: true } },
      { toolName: 'proposeDirections', output: { ok: true } },
    )])).toBe(true)
  })

  it('holds incomplete required or attempted work open', () => {
    expect(isAnalyzeWorkflowComplete(tools, [step(
      { toolName: 'reportAnalysis', output: { ok: true } },
    )])).toBe(false)
    expect(isAnalyzeWorkflowComplete(tools, [step(
      { toolName: 'reportAnalysis', output: { ok: true } },
      { toolName: 'proposeRecordCorrections', output: { ok: false } },
      { toolName: 'proposeDirections', output: { ok: true } },
    )])).toBe(false)
  })

  it('focuses a rejected report retry on the report contract', () => {
    expect(selectAnalyzeToolStage(tools, [
      step({ toolName: 'reportAnalysis', output: { ok: false, skippedContinuity: [{}] } }),
    ])).toEqual({
      stage: 'recovery',
      activeTools: ['reportAnalysis'],
    })
  })

  it('opens the full surface when a report resolves records for inspection', () => {
    const steps = [step(
      {
        toolName: 'reportAnalysis',
        output: { ok: true, inspectionRequired: true, resolvedFragments: [{ id: 'ch-1', content: '[1] Existing claim.' }] },
      },
      { toolName: 'proposeDirections', output: { ok: true } },
    )]
    expect(isAnalyzeWorkflowComplete(tools, steps)).toBe(false)
    expect(selectAnalyzeToolStage(tools, steps)).toEqual({
      stage: 'inspection',
      activeTools: tools,
    })
  })

  it('keeps inspection open across reads and accepts an explicit close', () => {
    const inspected = [
      step({
        toolName: 'reportAnalysis',
        output: { ok: true, inspectionRequired: true, resolvedFragments: [{ id: 'ch-1' }] },
      }),
      step({ toolName: 'readFragments', output: { fragments: [{ id: 'kn-1' }] } }),
    ]
    expect(selectAnalyzeToolStage(tools, inspected)).toMatchObject({ stage: 'inspection' })

    const closed = [...inspected, step({ toolName: 'finishAnalysis', output: { ok: true } })]
    expect(isAnalyzeWorkflowComplete(tools, closed)).toBe(true)
  })

  it('uses the un-staged surface when the report tool is disabled', () => {
    const available = ['readFragments', 'finishAnalysis']
    expect(selectAnalyzeToolStage(available, [])).toEqual({
      stage: 'primary',
      activeTools: available,
    })
    expect(describeAnalyzeToolStages(available)).toEqual([])
  })

  it('describes the same three surfaces for the context preview', () => {
    const stages = describeAnalyzeToolStages(tools)
    expect(stages.map((stage) => stage.id)).toEqual(['primary', 'inspection', 'recovery'])
    expect(stages[0].toolNames).not.toContain('readFragments')
    expect(stages[0].toolNames).not.toContain('finishAnalysis')
    expect(stages[1]).toMatchObject({ conditional: true, toolNames: tools })
    expect(stages[2].toolNames).not.toContain('readFragments')
  })

  it('makes the one-request primary surface smaller than the unstaged surface', async () => {
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

    expect(stageCharacters.find((stage) => stage.id === 'primary')!.characters).toBeLessThan(totalCharacters)
    expect(stageCharacters.find((stage) => stage.id === 'inspection')!.characters).toBe(totalCharacters)
  })
})
