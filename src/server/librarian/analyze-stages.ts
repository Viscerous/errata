/** Single source of truth for the Librarian Analyze requests. */

import { MAINTENANCE_REPORT_TOOL, PASSAGE_REPORT_TOOL } from './analysis-tools'

export type AnalyzeStageId = 'passage' | 'maintenance'

export interface AnalyzeStageDefinition {
  id: AnalyzeStageId
  label: string
  description: string
  conditional: boolean
  toolName: string
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
    label,
    description,
    directive: `Perform only the ${task} task. Call ${toolName} exactly once, then stop.`,
    structuredDirective: `Perform only the ${task} task. Answer with the report as a single JSON object in the form below.`,
    conditional,
  }
}

/**
 * The ordered request plan for the tools that survived agent configuration:
 * the passage in one request, then record maintenance. Maintenance stays in
 * the plan so runtime and context preview describe the same surface; runtime
 * runs it only when the passage report produced evidence for it.
 */
export function buildAnalyzeStagePlan(availableTools: readonly string[]): AnalyzeStageDefinition[] {
  const available = new Set(availableTools)
  if (!available.has(PASSAGE_REPORT_TOOL)) return []
  const stages = [stage(
    'passage',
    PASSAGE_REPORT_TOOL,
    'Passage',
    'Summary, scene, mentions, live state, threads, and directions in one report.',
    'passage-analysis',
  )]
  if (available.has(MAINTENANCE_REPORT_TOOL)) {
    stages.push(stage(
      'maintenance',
      MAINTENANCE_REPORT_TOOL,
      'Record maintenance',
      'Corrections or new reusable records, only when the passage report found a contradiction or a new name.',
      'record-maintenance',
      true,
    ))
  }
  return stages
}
