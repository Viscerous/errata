/**
 * Tool exposure for the adaptive Analyze loop.
 *
 * The loop keeps one conversation and one compiled story context. Only the
 * schemas change between steps: observation starts with the report contract,
 * then the much smaller follow-up toolset replaces it. When the first report
 * resolves additional records, one inspection step keeps both surfaces
 * available so the model can report a newly grounded contradiction.
 */

export const ANALYZE_REPORT_TOOL = 'reportAnalysis'
const ANALYZE_INSPECTION_TOOLS = new Set([
  'readFragments',
  'findFragments',
  'listFragments',
  'listFragmentTypes',
])

export type AnalyzeToolStage = 'observation' | 'inspection' | 'follow-up'

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

function hasResolvedFragments(output: unknown): boolean {
  const value = outputRecord(output)?.resolvedFragments
  return Array.isArray(value) && value.length > 0
}

/** Select the smallest useful tool surface for the next model request. */
export function selectAnalyzeToolStage(
  availableTools: readonly string[],
  steps: readonly AnalyzeStep[],
): AnalyzeStageSelection {
  if (!availableTools.includes(ANALYZE_REPORT_TOOL)) {
    return { stage: 'follow-up', activeTools: [...availableTools] }
  }

  const results = steps.flatMap((step) => step.toolResults ?? [])
  let latestReportIndex = -1
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (results[index].toolName === ANALYZE_REPORT_TOOL) {
      latestReportIndex = index
      break
    }
  }

  if (latestReportIndex < 0) {
    return { stage: 'observation', activeTools: [ANALYZE_REPORT_TOOL] }
  }

  const latestReport = outputRecord(results[latestReportIndex].output)
  if (latestReport?.ok !== true) {
    return { stage: 'observation', activeTools: [ANALYZE_REPORT_TOOL] }
  }

  const progressedBeyondInspection = results
    .slice(latestReportIndex + 1)
    .some((result) => (
      result.toolName !== ANALYZE_REPORT_TOOL
      && !ANALYZE_INSPECTION_TOOLS.has(result.toolName)
    ))
  if (hasResolvedFragments(latestReport) && !progressedBeyondInspection) {
    return { stage: 'inspection', activeTools: [...availableTools] }
  }

  return {
    stage: 'follow-up',
    activeTools: availableTools.filter((name) => name !== ANALYZE_REPORT_TOOL),
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
      id: 'observation',
      label: 'Observation',
      description: 'Initial request: report the passage against the already compiled story context.',
      conditional: false,
      toolNames: [ANALYZE_REPORT_TOOL],
    },
    {
      id: 'inspection',
      label: 'Record inspection',
      description: 'Used only when the report loads additional record bodies that may change the findings.',
      conditional: true,
      toolNames: [...availableTools],
    },
    {
      id: 'follow-up',
      label: 'Follow-up',
      description: 'Directions, record maintenance, and completion after observation is settled.',
      conditional: false,
      toolNames: availableTools.filter((name) => name !== ANALYZE_REPORT_TOOL),
    },
  ]
}
