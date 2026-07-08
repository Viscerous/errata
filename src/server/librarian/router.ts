import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { resolveAgentRuntime } from '../llm/client'
import { resolveAndReportUsage } from '../llm/usage-normalizer'
import { joinMarkdownBlocks, markdownSection } from '../llm/fragment-context-blocks'
import type { Fragment, StoryMeta } from '../fragments/schema'
import { FragmentIdSchema } from '../fragments/schema'
import { runToolLoopPass } from './tool-runner'
import type { FragmentCandidate, MergedFragmentCandidate } from './candidates'
import { mergeFragmentCandidates } from './candidates'
import { passRecord, type LibrarianPassRecord } from './storage'
import { renderLibrarianObservation, type LibrarianObservationPrompt } from './prompt-rendering'

export interface FragmentRouterInput {
  proseFragment: Fragment
  observation: LibrarianObservationPrompt
  catalog: Fragment[]
  seedCandidates: MergedFragmentCandidate[]
}

export interface FragmentRouterResult {
  candidates: FragmentCandidate[]
  pass: LibrarianPassRecord
  stepCount?: number
  finishReason?: string
}

const reportFragmentCandidatesSchema = z.object({
  candidates: z.array(z.object({
    fragmentId: FragmentIdSchema.describe('Existing fragment ID from the catalog'),
    reason: z.string().trim().optional().describe('Brief reason this fragment may need proposal/audit context'),
    confidence: z.number().min(0).max(1).optional(),
  })).default([]),
})

function catalogRows(catalog: Fragment[]): string {
  return catalog
    .map((fragment) => `- ${fragment.id} | ${fragment.type} | ${fragment.name} | ${fragment.description}`)
    .join('\n')
}

function seedRows(candidates: MergedFragmentCandidate[]): string {
  if (candidates.length === 0) return '(none)'
  return candidates
    .map((candidate) => {
      const details = [
        `sources=${candidate.sources.join('+')}`,
        candidate.score !== undefined ? `score=${candidate.score}` : undefined,
        candidate.reasons?.length ? `reasons=${candidate.reasons.join(' / ')}` : undefined,
      ].filter((part): part is string => Boolean(part)).join('; ')
      return `- ${candidate.fragmentId}${details ? ` (${details})` : ''}`
    })
    .join('\n')
}

function buildRouterPrompt(input: FragmentRouterInput): string {
  return joinMarkdownBlocks([
    markdownSection(2, 'New Prose', [
      `Fragment ID: ${input.proseFragment.id}`,
      input.proseFragment.content,
    ]),
    markdownSection(2, 'Observation', renderLibrarianObservation(input.observation, {
      emptyText: '(no structured observation)',
      candidateLabel: 'Observation candidates',
    })),
    markdownSection(2, 'Existing Candidate Seeds', seedRows(input.seedCandidates)),
    markdownSection(2, 'Mutable Fragment Catalog', catalogRows(input.catalog)),
  ])
}

export async function runFragmentRouter(
  dataDir: string,
  storyId: string,
  story: StoryMeta,
  input: FragmentRouterInput,
): Promise<FragmentRouterResult> {
  const startedAt = new Date().toISOString()
  const startTime = Date.now()
  const validIds = new Set(input.catalog.map((fragment) => fragment.id))
  const collected: FragmentCandidate[] = []
  const invalidIds = new Set<string>()
  const { model, modelId, temperature, providerOptions, guards } = await resolveAgentRuntime(dataDir, storyId, 'librarian.router', story)

  const tools: ToolSet = {
    reportFragmentCandidates: tool({
      description: 'Return existing fragments that may need full context in proposal or continuity audit. Candidates only; this does not create mention annotations.',
      inputSchema: reportFragmentCandidatesSchema,
      execute: async ({ candidates }) => {
        for (const candidate of candidates) {
          if (!validIds.has(candidate.fragmentId)) {
            invalidIds.add(candidate.fragmentId)
            continue
          }
          collected.push({
            fragmentId: candidate.fragmentId,
            source: 'router',
            ...(candidate.reason ? { reason: candidate.reason } : {}),
            ...(candidate.confidence !== undefined ? { score: candidate.confidence } : {}),
          })
        }
        return {
          ok: true,
          candidateCount: collected.length,
          ...(invalidIds.size > 0 ? { ignoredUnknownFragmentIds: [...invalidIds] } : {}),
        }
      },
    }),
  }

  try {
    const result = await runToolLoopPass({
      model,
      instructions: [
        'You are the Librarian fragment-router.',
        'Your only job is to select existing mutable fragments that may need full context in online analysis or continuity audit.',
        'Treat observation mentions, writer provenance, and catalog hints as candidate seeds, not truth.',
        'Do not report prose annotations, do not propose fragment edits, and do not create new fragments.',
        'Call reportFragmentCandidates once. If no existing fragment is relevant, call it with an empty candidates array.',
      ].join('\n'),
      prompt: buildRouterPrompt(input),
      tools,
      temperature,
      providerOptions,
      maxOutputTokens: guards.maxOutputTokens,
      terminalToolName: 'reportFragmentCandidates',
    })
    await resolveAndReportUsage(dataDir, storyId, 'librarian.router', result.totalUsage, modelId)
    return {
      candidates: mergeFragmentCandidates(collected).flatMap((candidate) =>
        candidate.sources.map((source) => ({
          fragmentId: candidate.fragmentId,
          source,
          reason: candidate.reasons?.join(' / '),
          score: candidate.score,
        })),
      ),
      stepCount: result.stepCount,
      finishReason: result.finishReason,
      pass: passRecord({
        name: 'router',
        status: 'complete',
        startedAt,
        durationMs: Date.now() - startTime,
        modelId,
        stepCount: result.stepCount,
        finishReason: result.finishReason,
        diagnostics: {
          catalogCount: input.catalog.length,
          seedCandidateCount: input.seedCandidates.length,
          routedCandidateCount: collected.length,
          ignoredUnknownFragmentIds: [...invalidIds],
        },
      }),
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return {
      candidates: [],
      pass: passRecord({
        name: 'router',
        status: 'failed',
        startedAt,
        durationMs: Date.now() - startTime,
        modelId,
        error: errorMsg,
      }),
    }
  }
}
