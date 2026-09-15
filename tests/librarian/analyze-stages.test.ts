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
]

function step(...toolResults: Array<{ toolName: string; output: unknown }>): AnalyzeStep {
  return { toolResults }
}

describe('librarian analyze tool stages', () => {
  it('keeps the common path in one request while omitting inspection tools', () => {
    expect(selectAnalyzeToolStage(tools, [])).toEqual({
      stage: 'primary',
      activeTools: [
        'reportAnalysis',
        'proposeRecordCorrections',
        'proposeNewRecords',
      ],
    })
  })

  it('completes deterministically after the final report succeeds', () => {
    expect(isAnalyzeWorkflowComplete(tools, [
      step({ toolName: 'reportAnalysis', output: { ok: true } }),
    ])).toBe(true)
  })

  it('does not require an optional proposal that was never called', () => {
    expect(isAnalyzeWorkflowComplete(tools, [
      step({ toolName: 'reportAnalysis', output: { ok: true } }),
    ])).toBe(true)
  })

  it('holds rejected work open but does not turn an optional proposal into a requirement', () => {
    expect(isAnalyzeWorkflowComplete(tools, [step(
      { toolName: 'reportAnalysis', output: { ok: false } },
    )])).toBe(false)
    expect(isAnalyzeWorkflowComplete(tools, [step(
      { toolName: 'proposeRecordCorrections', output: { ok: false } },
      { toolName: 'reportAnalysis', output: { ok: true } },
    )])).toBe(true)
  })

  it('returns to the primary surface after a rejected report', () => {
    expect(selectAnalyzeToolStage(tools, [
      step({ toolName: 'reportAnalysis', output: { ok: false, skippedContinuity: [{}] } }),
    ])).toEqual({
      stage: 'primary',
      activeTools: [
        'reportAnalysis',
        'proposeRecordCorrections',
        'proposeNewRecords',
      ],
    })
  })

  it('opens the full surface when a report resolves records for inspection', () => {
    const steps = [step(
      {
        toolName: 'reportAnalysis',
        output: { ok: true, inspectionRequired: true, resolvedFragments: [{ id: 'ch-1', content: '[1] Existing claim.' }] },
      },
    )]
    expect(isAnalyzeWorkflowComplete(tools, steps)).toBe(false)
    expect(selectAnalyzeToolStage(tools, steps)).toEqual({
      stage: 'inspection',
      activeTools: tools,
    })
  })

  it('keeps inspection open across reads until a final report replaces the preliminary one', () => {
    const inspected = [
      step({
        toolName: 'reportAnalysis',
        output: { ok: true, inspectionRequired: true, resolvedFragments: [{ id: 'ch-1' }] },
      }),
      step({ toolName: 'readFragments', output: { fragments: [{ id: 'kn-1' }] } }),
    ]
    expect(selectAnalyzeToolStage(tools, inspected)).toMatchObject({ stage: 'inspection' })

    const closed = [...inspected, step({ toolName: 'reportAnalysis', output: { ok: true } })]
    expect(isAnalyzeWorkflowComplete(tools, closed)).toBe(true)
  })

  it('completes deterministically after a proposal follows an inspected report', () => {
    const steps = [
      step({
        toolName: 'reportAnalysis',
        output: { ok: true, inspectionRequired: true, resolvedFragments: [{ id: 'ch-1' }] },
      }),
      step({ toolName: 'proposeRecordCorrections', output: { ok: true, proposalCount: 1 } }),
    ]
    expect(isAnalyzeWorkflowComplete(tools, steps)).toBe(true)
  })

  it('uses the un-staged surface when the report tool is disabled', () => {
    const available = ['readFragments']
    expect(selectAnalyzeToolStage(available, [])).toEqual({
      stage: 'primary',
      activeTools: available,
    })
    expect(describeAnalyzeToolStages(available)).toEqual([])
  })

  it('describes the same two surfaces for the context preview', () => {
    const stages = describeAnalyzeToolStages(tools)
    expect(stages.map((stage) => stage.id)).toEqual(['primary', 'inspection'])
    expect(stages[0].toolNames).not.toContain('readFragments')
    expect(stages[1].toolNames).toContain('readFragments')
    expect(stages[1]).toMatchObject({ conditional: true, toolNames: tools })
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
