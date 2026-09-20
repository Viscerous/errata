/** Single source of truth for the isolated Librarian Analyze requests. */

export const ANALYZE_REPORT_TOOL = 'reportAnalysis'
export const ANALYZE_OBSERVATION_TOOL = 'reportObservation'
export const ANALYZE_CONTINUITY_TOOL = 'reportContinuity'
export const ANALYZE_MAINTENANCE_TOOL = 'reportMaintenance'
export const ANALYZE_DIRECTIONS_TOOL = 'reportDirections'

export type AnalyzeStageId = 'observation' | 'continuity' | 'maintenance' | 'directions'

export interface AnalyzeStageDefinition {
  id: AnalyzeStageId
  label: string
  description: string
  conditional: boolean
  toolName: string
  toolNames: string[]
  directive: string
}

function stage(
  id: AnalyzeStageId,
  toolName: string,
  label: string,
  description: string,
  directive: string,
  conditional = false,
): AnalyzeStageDefinition {
  return { id, toolName, toolNames: [toolName], label, description, directive, conditional }
}

/**
 * Build the exact ordered request plan from the tools that survived agent
 * configuration. Conditional stages remain in the plan so runtime and context
 * preview describe the same surface; runtime decides whether their evidence
 * threshold was met.
 */
export function buildAnalyzeStagePlan(availableTools: readonly string[]): AnalyzeStageDefinition[] {
  const available = new Set(availableTools)
  const observationTool = available.has(ANALYZE_OBSERVATION_TOOL)
    ? ANALYZE_OBSERVATION_TOOL
    : available.has(ANALYZE_REPORT_TOOL) ? ANALYZE_REPORT_TOOL : undefined
  if (!observationTool) return []

  const stages: AnalyzeStageDefinition[] = [stage(
    'observation',
    observationTool,
    'Observation',
    'Grounded narrative summary, scene frame, mentions, and continuity candidates.',
    `Perform only the observation task. Call ${observationTool} exactly once, then stop.`,
  )]

  if (observationTool === ANALYZE_OBSERVATION_TOOL && available.has(ANALYZE_CONTINUITY_TOOL)) {
    stages.push(stage(
      'continuity',
      ANALYZE_CONTINUITY_TOOL,
      'Continuity',
      'Active character and entity state plus foreground and resolved threads.',
      'Perform only the continuity task. Call reportContinuity exactly once, then stop.',
    ))
  }

  if (available.has(ANALYZE_MAINTENANCE_TOOL)) {
    stages.push(stage(
      'maintenance',
      ANALYZE_MAINTENANCE_TOOL,
      'Record maintenance',
      'Corrections or new reusable records, only when observation found durable-record work.',
      'Perform only the record-maintenance task. Call reportMaintenance exactly once, then stop.',
      true,
    ))
  }

  if (available.has(ANALYZE_DIRECTIONS_TOOL)) {
    stages.push(stage(
      'directions',
      ANALYZE_DIRECTIONS_TOOL,
      'Directions',
      'Distinct next-passage directions based on the completed analysis.',
      'Perform only the directions task. Call reportDirections exactly once, then stop.',
    ))
  }

  return stages
}

/** Static stage map used by the context preview. */
export function describeAnalyzeToolStages(availableTools: readonly string[]): AnalyzeStageDefinition[] {
  return buildAnalyzeStagePlan(availableTools)
}
