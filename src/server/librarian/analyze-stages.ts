/** Tool exposure and deterministic completion for the adaptive Analyze loop. */

export const ANALYZE_REPORT_TOOL = 'reportAnalysis'
export const ANALYZE_OBSERVATION_TOOL = 'reportObservation'
export const ANALYZE_CONTINUITY_TOOL = 'reportContinuity'
export const ANALYZE_DIRECTIONS_TOOL = 'reportDirections'

const ANALYZE_INSPECTION_TOOLS = new Set([
  'readFragments',
  'findFragments',
  'listFragments',
  'listFragmentTypes',
  'proposeRecordCorrections',
  'proposeNewRecords',
])

export type AnalyzeToolStage = 'observation' | 'continuity' | 'directions' | 'primary' | 'inspection'

export interface AnalyzeToolResult {
  toolName: string
  output: unknown
}

export interface AnalyzeStep {
  toolResults?: readonly AnalyzeToolResult[]
}

export interface AnalyzeStageSelection {
  stage: AnalyzeToolStage
  activeTools: string[]
}

function outputRecord(output: unknown): Record<string, unknown> | null {
  return output && typeof output === 'object' ? output as Record<string, unknown> : null
}

function outputOk(output: unknown): boolean {
  return outputRecord(output)?.ok === true
}

function hasResolvedFragments(output: unknown): boolean {
  return outputRecord(output)?.inspectionRequired === true
}

function flattenResults(steps: readonly AnalyzeStep[]): AnalyzeToolResult[] {
  return steps.flatMap((step) => step.toolResults ?? [])
}

function lastResult(results: readonly AnalyzeToolResult[], toolName: string): AnalyzeToolResult | undefined {
  return [...results].reverse().find((result) => result.toolName === toolName)
}

function primaryTools(availableTools: readonly string[]): string[] {
  return availableTools.filter(
    (name) => !ANALYZE_INSPECTION_TOOLS.has(name)
      && name !== ANALYZE_DIRECTIONS_TOOL
      && name !== ANALYZE_OBSERVATION_TOOL
      && name !== ANALYZE_CONTINUITY_TOOL,
  )
}

/**
 * A successful report is the deterministic stage boundary. If it supplies
 * record bodies, the loop stays open so the model can inspect them and replace
 * findings that changed; a natural model stop can also close unchanged
 * inspection without a synthetic finish tool.
 */
export function isAnalyzeWorkflowComplete(
  availableTools: readonly string[],
  steps: readonly AnalyzeStep[],
): boolean {
  const results = flattenResults(steps)
  if (results.length === 0) return false

  // 3-Beat Staged Pipeline
  if (availableTools.includes(ANALYZE_OBSERVATION_TOOL)) {
    const obs = lastResult(results, ANALYZE_OBSERVATION_TOOL)
    if (!obs || !outputOk(obs.output)) return false

    if (availableTools.includes(ANALYZE_CONTINUITY_TOOL)) {
      const cont = lastResult(results, ANALYZE_CONTINUITY_TOOL)
      if (!cont || !outputOk(cont.output)) return false
    }

    if (availableTools.includes(ANALYZE_DIRECTIONS_TOOL)) {
      const dir = lastResult(results, ANALYZE_DIRECTIONS_TOOL)
      if (!dir || !outputOk(dir.output)) return false
    }

    return true
  }

  // Legacy fallback: single reportAnalysis or staged reportAnalysis + reportDirections
  if (availableTools.includes(ANALYZE_REPORT_TOOL)) {
    const report = lastResult(results, ANALYZE_REPORT_TOOL)
    if (!report || !outputOk(report.output)) return false

    if (availableTools.includes(ANALYZE_DIRECTIONS_TOOL)) {
      const directionsProvided = outputRecord(report.output)?.directionsProvided === true
      const directionsReport = lastResult(results, ANALYZE_DIRECTIONS_TOOL)
      if (!directionsProvided && (!directionsReport || !outputOk(directionsReport.output))) {
        return false
      }
      return true
    }

    if (hasResolvedFragments(report.output)) {
      const lastStep = steps[steps.length - 1]
      const lastStepHadProposal = lastStep?.toolResults?.some(
        (r) => r.toolName === 'proposeRecordCorrections' || r.toolName === 'proposeNewRecords',
      )
      if (lastStepHadProposal) return true
      const lastStepHadTools = (lastStep?.toolResults?.length ?? 0) > 0
      if (!lastStepHadTools) return true
      return false
    }
  }

  return true
}

/** Select the smallest useful tool surface for the next model request. */
export function selectAnalyzeToolStage(
  availableTools: readonly string[],
  steps: readonly AnalyzeStep[],
): AnalyzeStageSelection {
  const results = flattenResults(steps)

  // 3-Beat Staged Pipeline: Observation -> Continuity -> Directions
  if (availableTools.includes(ANALYZE_OBSERVATION_TOOL)) {
    const obs = lastResult(results, ANALYZE_OBSERVATION_TOOL)
    if (!obs || !outputOk(obs.output)) {
      return { stage: 'observation', activeTools: [ANALYZE_OBSERVATION_TOOL] }
    }

    if (availableTools.includes(ANALYZE_CONTINUITY_TOOL)) {
      const cont = lastResult(results, ANALYZE_CONTINUITY_TOOL)
      if (!cont || !outputOk(cont.output)) {
        return { stage: 'continuity', activeTools: [ANALYZE_CONTINUITY_TOOL] }
      }
    }

    if (availableTools.includes(ANALYZE_DIRECTIONS_TOOL)) {
      const dir = lastResult(results, ANALYZE_DIRECTIONS_TOOL)
      if (!dir || !outputOk(dir.output)) {
        return { stage: 'directions', activeTools: [ANALYZE_DIRECTIONS_TOOL] }
      }
    }

    return { stage: 'inspection', activeTools: [] }
  }

  // Legacy fallback: reportAnalysis (+ optional reportDirections)
  if (!availableTools.includes(ANALYZE_REPORT_TOOL)) {
    return { stage: 'primary', activeTools: [...availableTools] }
  }
  if (results.length === 0) {
    return { stage: 'primary', activeTools: primaryTools(availableTools) }
  }

  const latestReport = lastResult(results, ANALYZE_REPORT_TOOL)
  if (!latestReport || !outputOk(latestReport.output)) {
    return { stage: 'primary', activeTools: primaryTools(availableTools) }
  }

  if (availableTools.includes(ANALYZE_DIRECTIONS_TOOL)) {
    const directionsProvided = outputRecord(latestReport.output)?.directionsProvided === true
    const latestDirections = lastResult(results, ANALYZE_DIRECTIONS_TOOL)
    if (!directionsProvided && (!latestDirections || !outputOk(latestDirections.output))) {
      return { stage: 'directions', activeTools: [ANALYZE_DIRECTIONS_TOOL] }
    }
    // Directions are satisfied: never reopen inspection turns.
    return { stage: 'inspection', activeTools: [] }
  }

  if (hasResolvedFragments(latestReport.output)) {
    return { stage: 'inspection', activeTools: [...availableTools] }
  }

  return { stage: 'inspection', activeTools: [] }
}

export interface AnalyzeStageDefinition {
  id: AnalyzeToolStage
  label: string
  description: string
  conditional: boolean
  toolNames: string[]
}

/** Static stage map used by the context preview. */
export function describeAnalyzeToolStages(availableTools: readonly string[]): AnalyzeStageDefinition[] {
  // 3-Beat Staged Pipeline Description
  if (availableTools.includes(ANALYZE_OBSERVATION_TOOL)) {
    const stages: AnalyzeStageDefinition[] = [
      {
        id: 'observation',
        label: 'Observation',
        description: 'First request: grounded narrative observation and mentions.',
        conditional: false,
        toolNames: [ANALYZE_OBSERVATION_TOOL],
      },
    ]
    if (availableTools.includes(ANALYZE_CONTINUITY_TOOL)) {
      stages.push({
        id: 'continuity',
        label: 'Continuity',
        description: 'Second request: character live state, entities, and open threads.',
        conditional: false,
        toolNames: [ANALYZE_CONTINUITY_TOOL],
      })
    }
    if (availableTools.includes(ANALYZE_DIRECTIONS_TOOL)) {
      stages.push({
        id: 'directions',
        label: 'Directions',
        description: 'Third request: three distinct next-passage directions.',
        conditional: false,
        toolNames: [ANALYZE_DIRECTIONS_TOOL],
      })
    }
    return stages
  }

  if (!availableTools.includes(ANALYZE_REPORT_TOOL)) return []
  const stages: AnalyzeStageDefinition[] = [
    {
      id: 'primary',
      label: 'Primary',
      description: 'First request: observation and working memory update.',
      conditional: false,
      toolNames: primaryTools(availableTools),
    },
  ]
  if (availableTools.includes(ANALYZE_DIRECTIONS_TOOL)) {
    stages.push({
      id: 'directions',
      label: 'Directions',
      description: 'Second request: three distinct next-passage directions.',
      conditional: false,
      toolNames: [ANALYZE_DIRECTIONS_TOOL],
    })
  }
  stages.push({
    id: 'inspection',
    label: 'Record inspection',
    description: 'Used only when the report loads record bodies that may prompt proposals or a revised report.',
    conditional: true,
    toolNames: [...availableTools],
  })
  return stages
}
