import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { resolveAgentRuntime } from '../llm/client'
import { getFragment, listFragments } from '../fragments/storage'
import type { Fragment, StoryMeta } from '../fragments/schema'
import { FragmentIdSchema } from '../fragments/schema'
import { resolveAndReportUsage } from '../llm/usage-normalizer'
import { joinMarkdownBlocks, markdownSection } from '../llm/fragment-context-blocks'
import { runToolLoopPass } from './tool-runner'
import type { LibrarianPassRecord } from './storage'
import { passRecord } from './pass-records'
import { renderLibrarianObservation, type LibrarianObservationPrompt } from './prompt-rendering'

export interface ContinuityAuditFinding {
  description: string
  fragmentIds: string[]
  severity?: 'note' | 'warning' | 'blocker'
  evidence?: string
}

export interface ContinuityAuditBatchResult {
  proseFragmentId: string
  batchFragmentIds: string[]
  findings: ContinuityAuditFinding[]
  pass: LibrarianPassRecord
}

export interface ContinuityAuditBatchInput {
  proseFragmentId: string
  knowledgeFragmentIds: string[]
  observation?: LibrarianObservationPrompt
}

const reportContinuityAuditSchema = z.object({
  findings: z.array(z.object({
    description: z.string().trim().min(1),
    fragmentIds: z.array(FragmentIdSchema).default([]),
    severity: z.union([z.literal('note'), z.literal('warning'), z.literal('blocker')]).optional(),
    evidence: z.string().trim().optional(),
  })).default([]),
})

function renderFragment(fragment: Fragment): string {
  return markdownSection(3, `${fragment.id} | ${fragment.name} | ${fragment.description}`, fragment.content)
}

function renderKnowledgeCatalog(allKnowledge: Fragment[], batchIds: Set<string>): string {
  const outsideBatch = allKnowledge.filter((fragment) => !batchIds.has(fragment.id))
  if (outsideBatch.length === 0) return '(none outside this batch)'
  return outsideBatch
    .map((fragment) => `- ${fragment.id} | ${fragment.name} | ${fragment.description}`)
    .join('\n')
}

function buildAuditPrompt(params: {
  prose: Fragment
  batch: Fragment[]
  allKnowledge: Fragment[]
  input: ContinuityAuditBatchInput
}): string {
  const batchIds = new Set(params.batch.map((fragment) => fragment.id))
  return joinMarkdownBlocks([
    markdownSection(2, 'Audit Scope', [
      `Prose fragment: ${params.prose.id}`,
      `Knowledge batch: ${params.batch.map((fragment) => fragment.id).join(', ') || '(empty)'}`,
      'This is a bounded audit over only the full knowledge batch below. Do not imply full-story certainty outside this scope.',
    ]),
    markdownSection(2, 'Observation', renderLibrarianObservation(params.input.observation)),
    markdownSection(2, 'Prose', params.prose.content),
    markdownSection(2, 'Full Knowledge Batch', params.batch.map(renderFragment).join('\n\n') || '(empty)'),
    markdownSection(2, 'Other Knowledge Catalog', renderKnowledgeCatalog(params.allKnowledge, batchIds)),
  ])
}

export async function runContinuityAuditBatch(
  dataDir: string,
  storyId: string,
  story: StoryMeta,
  input: ContinuityAuditBatchInput,
): Promise<ContinuityAuditBatchResult> {
  const startedAt = new Date().toISOString()
  const startTime = Date.now()
  const prose = await getFragment(dataDir, storyId, input.proseFragmentId)
  if (!prose) throw new Error(`Fragment ${input.proseFragmentId} not found`)

  const allKnowledge = await listFragments(dataDir, storyId, 'knowledge')
  const knowledgeById = new Map(allKnowledge.map((fragment) => [fragment.id, fragment]))
  const unknownIds = input.knowledgeFragmentIds.filter((id) => !knowledgeById.has(id))
  if (unknownIds.length > 0) {
    throw new Error(`Unknown knowledge fragment IDs: ${unknownIds.join(', ')}`)
  }

  const batch = input.knowledgeFragmentIds.map((id) => knowledgeById.get(id)!)
  const allowedIds = new Set([prose.id, ...batch.map((fragment) => fragment.id)])
  const findings: ContinuityAuditFinding[] = []
  const { model, modelId, temperature, providerOptions, guards } = await resolveAgentRuntime(dataDir, storyId, 'librarian.audit-continuity', story)

  const tools: ToolSet = {
    reportContinuityAudit: tool({
      description: 'Report contradictions, stale-state risks, or continuity warnings found within the declared audit batch.',
      inputSchema: reportContinuityAuditSchema,
      execute: async ({ findings: reported }) => {
        for (const finding of reported) {
          findings.push({
            description: finding.description,
            fragmentIds: finding.fragmentIds.filter((id) => allowedIds.has(id)),
            ...(finding.severity ? { severity: finding.severity } : {}),
            ...(finding.evidence ? { evidence: finding.evidence } : {}),
          })
        }
        return { ok: true, findingCount: findings.length }
      },
    }),
  }

  try {
    const result = await runToolLoopPass({
      model,
      instructions: [
        'You are the Librarian continuity-audit runner.',
        'Your only job is to compare the prose against the full knowledge batch in scope.',
        'Report only contradictions, stale-state risks, or uncertainty that matters for continuity.',
        'Do not propose edits, do not annotate prose, and do not inspect outside the declared batch except for the compact catalog as orientation.',
        'Call reportContinuityAudit once. If there are no findings, call it with an empty findings array.',
      ].join('\n'),
      prompt: buildAuditPrompt({ prose, batch, allKnowledge, input }),
      tools,
      temperature,
      providerOptions,
      maxOutputTokens: guards.maxOutputTokens,
      terminalToolName: 'reportContinuityAudit',
    })
    await resolveAndReportUsage(dataDir, storyId, 'librarian.audit-continuity', result.totalUsage, modelId)
    return {
      proseFragmentId: prose.id,
      batchFragmentIds: batch.map((fragment) => fragment.id),
      findings,
      pass: passRecord({
        name: 'audit',
        status: 'complete',
        startedAt,
        durationMs: Date.now() - startTime,
        modelId,
        stepCount: result.stepCount,
        finishReason: result.finishReason,
        diagnostics: {
          proseFragmentId: prose.id,
          batchFragmentIds: batch.map((fragment) => fragment.id),
          findingCount: findings.length,
        },
      }),
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return {
      proseFragmentId: prose.id,
      batchFragmentIds: batch.map((fragment) => fragment.id),
      findings,
      pass: passRecord({
        name: 'audit',
        status: 'failed',
        startedAt,
        durationMs: Date.now() - startTime,
        modelId,
        error: errorMsg,
        diagnostics: {
          proseFragmentId: prose.id,
          batchFragmentIds: batch.map((fragment) => fragment.id),
        },
      }),
    }
  }
}
