/** Tool exposure and deterministic completion for the adaptive Analyze loop. */

export const ANALYZE_REPORT_TOOL = 'reportAnalysis'
const ANALYZE_INSPECTION_TOOLS = new Set([
  'readFragments',
  'findFragments',
  'listFragments',
  'listFragmentTypes',
])

export type AnalyzeToolStage = 'primary' | 'inspection'

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
  return availableTools.filter((name) => !ANALYZE_INSPECTION_TOOLS.has(name))
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

  if (availableTools.includes(ANALYZE_REPORT_TOOL)) {
    const report = lastResult(results, ANALYZE_REPORT_TOOL)
    if (!report || !outputOk(report.output) || hasResolvedFragments(report.output)) return false
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
  if (latestReport && hasResolvedFragments(latestReport.output)) {
    return { stage: 'inspection', activeTools: [...availableTools] }
  }

  return { stage: 'primary', activeTools: primaryTools(availableTools) }
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
      description: 'Normal one-request path: optional record proposals followed by the complete report.',
      conditional: false,
      toolNames: primaryTools(availableTools),
    },
    {
      id: 'inspection',
      label: 'Record inspection',
      description: 'Used only when the report loads record bodies that may prompt proposals or a revised report.',
      conditional: true,
      toolNames: [...availableTools],
    },
  ]
}
