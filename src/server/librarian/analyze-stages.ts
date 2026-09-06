/** Tool exposure and deterministic completion for the adaptive Analyze loop. */

export const ANALYZE_REPORT_TOOL = 'reportAnalysis'
const ANALYZE_FINISH_TOOL = 'finishAnalysis'
const ANALYZE_DIRECTION_TOOL = 'proposeDirections'
const ANALYZE_PROPOSAL_TOOLS = new Set([
  'proposeRecordCorrections',
  'proposeNewRecords',
])
const ANALYZE_INSPECTION_TOOLS = new Set([
  'readFragments',
  'findFragments',
  'listFragments',
  'listFragmentTypes',
])

export type AnalyzeToolStage = 'primary' | 'inspection' | 'recovery'

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
  return availableTools.filter((name) => (
    !ANALYZE_INSPECTION_TOOLS.has(name)
    && name !== ANALYZE_FINISH_TOOL
  ))
}

/**
 * The normal path ends after one model response: report, optional proposals,
 * and directions can be emitted together. A final model-authored finish marker
 * adds no information, so successful required work is a deterministic stop.
 */
export function isAnalyzeWorkflowComplete(
  availableTools: readonly string[],
  steps: readonly AnalyzeStep[],
): boolean {
  const results = flattenResults(steps)
  if (results.length === 0) return false

  const finish = lastResult(results, ANALYZE_FINISH_TOOL)
  if (finish && outputOk(finish.output)) return true

  if (availableTools.includes(ANALYZE_REPORT_TOOL)) {
    const report = lastResult(results, ANALYZE_REPORT_TOOL)
    if (!report || !outputOk(report.output) || hasResolvedFragments(report.output)) return false
  }

  if (availableTools.includes(ANALYZE_DIRECTION_TOOL)) {
    const directions = lastResult(results, ANALYZE_DIRECTION_TOOL)
    if (!directions || !outputOk(directions.output)) return false
  }

  for (const toolName of ANALYZE_PROPOSAL_TOOLS) {
    const proposal = lastResult(results, toolName)
    if (proposal && !outputOk(proposal.output)) return false
  }

  return true
}

/** Select the smallest useful tool surface for the next model request. */
export function selectAnalyzeToolStage(
  availableTools: readonly string[],
  steps: readonly AnalyzeStep[],
): AnalyzeStageSelection {
  if (!availableTools.includes(ANALYZE_REPORT_TOOL)) {
    return { stage: 'primary', activeTools: [...availableTools] }
  }
  const results = flattenResults(steps)
  if (results.length === 0) {
    return { stage: 'primary', activeTools: primaryTools(availableTools) }
  }

  const latestReport = lastResult(results, ANALYZE_REPORT_TOOL)
  if (latestReport && !outputOk(latestReport.output)) {
    return { stage: 'recovery', activeTools: [ANALYZE_REPORT_TOOL] }
  }

  if (latestReport && hasResolvedFragments(latestReport.output)) {
    const reportIndex = results.lastIndexOf(latestReport)
    const closedInspection = results.slice(reportIndex + 1).some((result) => (
      result.toolName === ANALYZE_FINISH_TOOL
      || result.toolName === ANALYZE_REPORT_TOOL
    ))
    if (!closedInspection) {
      return { stage: 'inspection', activeTools: [...availableTools] }
    }
  }

  return {
    stage: 'recovery',
    activeTools: availableTools.filter((name) => (
      !ANALYZE_INSPECTION_TOOLS.has(name)
      && name !== ANALYZE_REPORT_TOOL
    )),
  }
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
  if (!availableTools.includes(ANALYZE_REPORT_TOOL)) return []
  return [
    {
      id: 'primary',
      label: 'Primary',
      description: 'Normal one-request path: observation, optional proposals, and directions.',
      conditional: false,
      toolNames: primaryTools(availableTools),
    },
    {
      id: 'inspection',
      label: 'Record inspection',
      description: 'Used only when the report loads additional record bodies that may change the findings.',
      conditional: true,
      toolNames: [...availableTools],
    },
    {
      id: 'recovery',
      label: 'Recovery',
      description: 'Focused retry or explicit close after rejected or incomplete work.',
      conditional: true,
      toolNames: availableTools.filter((name) => !ANALYZE_INSPECTION_TOOLS.has(name)),
    },
  ]
}
