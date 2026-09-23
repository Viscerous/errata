/** Single source of truth for the isolated Librarian Analyze requests. */

export const ANALYZE_REPORT_TOOL = 'reportAnalysis'
export const ANALYZE_OBSERVATION_TOOL = 'reportObservation'
export const ANALYZE_CONTINUITY_TOOL = 'reportContinuity'
export const ANALYZE_MAINTENANCE_TOOL = 'reportMaintenance'
export const ANALYZE_DIRECTIONS_TOOL = 'reportDirections'

export type AnalyzeStageId = 'observation' | 'continuity' | 'maintenance' | 'directions' | 'passage'

export interface AnalyzeStageDefinition {
  id: AnalyzeStageId
  label: string
  description: string
  conditional: boolean
  toolName: string
  toolNames: string[]
  /** The task, stated for a request answered by calling its tool. */
  directive: string
  /** The same task, stated for a request answered in its tool's schema as JSON. */
  structuredDirective: string
}

function stage(
  id: AnalyzeStageId,
  toolName: string,
  label: string,
  description: string,
  task: string,
  conditional = false,
): AnalyzeStageDefinition {
  return {
    id,
    toolName,
    toolNames: [toolName],
    label,
    description,
    directive: `Perform only the ${task} task. Call ${toolName} exactly once, then stop.`,
    structuredDirective: `Perform only the ${task} task. Answer with the report as a single JSON object in the form below.`,
    conditional,
  }
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
    'observation',
  )]

  if (observationTool === ANALYZE_OBSERVATION_TOOL && available.has(ANALYZE_CONTINUITY_TOOL)) {
    stages.push(stage(
      'continuity',
      ANALYZE_CONTINUITY_TOOL,
      'Continuity',
      'Active character and entity state plus foreground and resolved threads.',
      'continuity',
    ))
  }

  if (available.has(ANALYZE_MAINTENANCE_TOOL)) {
    stages.push(stage(
      'maintenance',
      ANALYZE_MAINTENANCE_TOOL,
      'Record maintenance',
      'Corrections or new reusable records, only when observation found durable-record work.',
      'record-maintenance',
      true,
    ))
  }

  if (available.has(ANALYZE_DIRECTIONS_TOOL)) {
    stages.push(stage(
      'directions',
      ANALYZE_DIRECTIONS_TOOL,
      'Directions',
      'Distinct next-passage directions based on the completed analysis.',
      'directions',
    ))
  }

  return stages
}

/**
 * The single-report plan: the whole passage in one request, then record
 * maintenance only when that report produced evidence for it.
 */
export function buildSinglePassPlan(passageToolName: string, availableTools: readonly string[]): AnalyzeStageDefinition[] {
  return [
    stage(
      'passage',
      passageToolName,
      'Passage',
      'Observation, live state, threads, and directions in one report.',
      'passage-analysis',
    ),
    ...buildAnalyzeStagePlan(availableTools).filter((candidate) => candidate.id === 'maintenance'),
  ]
}

/** Static stage map used by the context preview. */
export function describeAnalyzeToolStages(availableTools: readonly string[]): AnalyzeStageDefinition[] {
  return buildAnalyzeStagePlan(availableTools)
}
