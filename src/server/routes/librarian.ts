import { Elysia, t } from 'elysia'
import { getStory, getFragment, listFragments, updateFragment } from '../fragments/storage'
import { getActiveProseIds } from '../fragments/prose-chain'
import {
  buildContinuityLedger,
  projectContinuityView,
  invalidateContinuityCache,
} from '../librarian/continuity-view'
import {
  getGenerationLog,
  listGenerationLogs,
} from '../llm/generation-logs'
import { getLibrarianRuntimeStatus, triggerLibrarian } from '../librarian/scheduler'
import { inspectSummarySource, type SummaryGapReason } from '../librarian/summary-source'
import { getAgentBlockConfig } from '../agents/agent-block-storage'
import { createAgentInstance, listAgentRuns } from '../agents'
import {
  getState as getLibrarianState,
  listAnalyses as listLibrarianAnalyses,
  getAnalysis as getLibrarianAnalysis,
  saveAnalysis as saveLibrarianAnalysis,
  listConversations,
  createConversation,
  deleteConversation,
  getConversationHistory,
  saveConversationHistory,
  getAnalysisIndex,
  rebuildAnalysisIndex,
} from '../librarian/storage'
import {
  applyFragmentChangeProposal,
  markFragmentChangeProposalApplied,
  markFragmentChangeProposalReverted,
  markFragmentChangeProposalStale,
  ProposalApplyError,
  ProposalValidationError,
  refreshPendingFragmentChangeProposals,
  revertFragmentChangeProposal,
} from '../librarian/suggestions'
import { RevertConflictError } from '../fragments/change-apply'
import { createLogger } from '../logging'
import { encodeStream } from './encode-stream'
import type { LibrarianAnalysisStatusResponse, LibrarianStatusResponse } from '@/contracts/librarian'

const summaryGapWarning: Record<SummaryGapReason, string> = {
  'missing-analysis': 'No analysis for this passage',
  'empty-summary': 'Analysis recorded no story summary',
  'unverified-source': 'Analysis cannot be matched to this passage',
  'stale-source': 'Passage changed since analysis',
  'old-contract': 'Analysis uses an older story-summary format',
}

export function librarianRoutes(dataDir: string) {
  const logger = createLogger('api:librarian', { dataDir })

  return new Elysia({ detail: { tags: ['Librarian'] } })
    // --- Generation Logs ---
    .get('/stories/:storyId/generation-logs', async ({ params }) => {
      return listGenerationLogs(dataDir, params.storyId)
    }, { detail: { summary: 'List generation logs' } })

    .get('/stories/:storyId/generation-logs/:logId', async ({ params, set }) => {
      const log = await getGenerationLog(dataDir, params.storyId, params.logId)
      if (!log) {
        set.status = 404
        return { error: 'Generation log not found' }
      }
      return log
    }, { detail: { summary: 'Get a generation log by ID' } })

    // --- Librarian ---
    .get('/stories/:storyId/librarian/status', async ({ params }) => {
      const state = await getLibrarianState(dataDir, params.storyId)
      const runtime = getLibrarianRuntimeStatus(params.storyId)
      return {
        ...state,
        ...runtime,
      } satisfies LibrarianStatusResponse
    }, { detail: { summary: 'Get librarian status' } })

    .get('/stories/:storyId/librarian/analysis-index', async ({ params }) => {
      const [storedIndex, story, librarianConfig, activeProseIds] = await Promise.all([
        getAnalysisIndex(dataDir, params.storyId),
        getStory(dataDir, params.storyId),
        getAgentBlockConfig(dataDir, params.storyId, 'librarian.analyze'),
        getActiveProseIds(dataDir, params.storyId),
      ])
      const index = storedIndex ?? await rebuildAnalysisIndex(dataDir, params.storyId)
      const autoAnalysisDisabled = story?.settings.disableLibrarianAutoAnalysis === true
        || librarianConfig.disableAutoAnalysis === true
      const { runningFragmentId, pendingFragmentId } = getLibrarianRuntimeStatus(params.storyId)
      const prose = autoAnalysisDisabled ? [] : activeProseIds.length === 0
        ? await listFragments(dataDir, params.storyId, 'prose')
        : (await Promise.all(activeProseIds.map((id) => getFragment(dataDir, params.storyId, id))))
            .filter((fragment): fragment is NonNullable<typeof fragment> => fragment?.type === 'prose' && !fragment.archived)
      const warningEntries = await Promise.all(prose.map(async (fragment): Promise<[string, string] | null> => {
        if (fragment.id === runningFragmentId || fragment.id === pendingFragmentId) return null
        const latest = index.latestByFragmentId[fragment.id]?.analysisId
        const failed = index.failedByFragmentId[fragment.id]
        if (failed) return [fragment.id, failed]
        if (latest && index.latestProjectionByFragmentId[fragment.id]?.analysisId !== latest) {
          return [fragment.id, 'Analysis did not complete']
        }
        const source = await inspectSummarySource(dataDir, params.storyId, fragment, latest)
        return 'gapReason' in source ? [fragment.id, summaryGapWarning[source.gapReason]] : null
      }))
      return {
        autoAnalysisDisabled,
        latestByFragmentId: Object.fromEntries(
          Object.entries(index.latestByFragmentId).map(([fragmentId, entry]) => [fragmentId, entry.analysisId]),
        ),
        warningByFragmentId: Object.fromEntries(warningEntries.filter((entry): entry is [string, string] => entry !== null)),
      } satisfies LibrarianAnalysisStatusResponse
    }, { detail: { summary: 'Get passage-analysis and story-summary coverage' } })

    .get('/stories/:storyId/librarian/continuity', async ({ params, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }
      const [activeProseIds, analysisIndex] = await Promise.all([
        getActiveProseIds(dataDir, params.storyId),
        getAnalysisIndex(dataDir, params.storyId),
      ])
      const activeProse = (await Promise.all(activeProseIds.map((id) => getFragment(dataDir, params.storyId, id))))
        .filter((fragment): fragment is NonNullable<typeof fragment> => fragment?.type === 'prose' && !fragment.archived)
      const ledger = await buildContinuityLedger({
        dataDir,
        storyId: params.storyId,
        activeProseFragments: activeProse,
        analysisIndex,
      })
      const view = projectContinuityView(ledger)
      const latestProseId = activeProse.at(-1)?.id
      const latestAnalysisId = latestProseId
        ? analysisIndex?.latestProjectionByFragmentId[latestProseId]?.analysisId ?? analysisIndex?.latestByFragmentId[latestProseId]?.analysisId ?? null
        : null
      return {
        ledger: ledger ?? null,
        view: view ?? null,
        latestAnalysisId,
      }
    }, { detail: { summary: 'Get branch folded continuity ledger and view' } })

    .put('/stories/:storyId/librarian/characters/:characterId/live-state', async ({ params, body, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }
      const charFragment = await getFragment(dataDir, params.storyId, params.characterId)
      if (!charFragment) {
        set.status = 404
        return { error: 'Character fragment not found' }
      }

      const input = body as {
        immediate?: string
        state?: Record<string, string>
        knowledge?: string[]
        secrets?: string[]
      }

      const [activeProseIds, analysisIndex] = await Promise.all([
        getActiveProseIds(dataDir, params.storyId),
        getAnalysisIndex(dataDir, params.storyId),
      ])
      const activeProse = (await Promise.all(activeProseIds.map((id) => getFragment(dataDir, params.storyId, id))))
        .filter((fragment): fragment is NonNullable<typeof fragment> => fragment?.type === 'prose' && !fragment.archived)
      const latestProseId = activeProse.at(-1)?.id
      const latestAnalysisId = latestProseId
        ? analysisIndex?.latestProjectionByFragmentId[latestProseId]?.analysisId ?? analysisIndex?.latestByFragmentId[latestProseId]?.analysisId ?? null
        : null

      if (latestAnalysisId) {
        const analysis = await getLibrarianAnalysis(dataDir, params.storyId, latestAnalysisId)
        if (analysis) {
          if (!analysis.continuityProjection) {
            analysis.continuityProjection = {
              version: 2,
              scene: { transition: 'continue', line: 'present' },
              stateOperations: [],
              threadOperations: [],
              threadFocus: [],
              knowledgeOperations: [],
              characterStates: {},
            }
          }
          analysis.continuityProjection.characterStates = analysis.continuityProjection.characterStates ?? {}
          analysis.continuityProjection.characterStates[params.characterId] = {
            characterId: params.characterId,
            name: charFragment.name,
            immediate: input.immediate?.trim() || undefined,
            state: input.state ?? {},
            knowledge: input.knowledge ?? [],
            secrets: input.secrets ?? [],
          }
          await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
        }
      }

      await updateFragment(dataDir, params.storyId, {
        ...charFragment,
        meta: {
          ...charFragment.meta,
          liveState: {
            immediate: input.immediate?.trim() || undefined,
            state: input.state ?? {},
            knowledge: input.knowledge ?? [],
            secrets: input.secrets ?? [],
          },
        },
      })

      invalidateContinuityCache(dataDir, params.storyId, latestAnalysisId ?? undefined)

      return {
        ok: true,
        characterState: {
          characterId: params.characterId,
          name: charFragment.name,
          immediate: input.immediate?.trim() || undefined,
          state: input.state ?? {},
          knowledge: input.knowledge ?? [],
          secrets: input.secrets ?? [],
        },
      }
    }, {
      body: t.Object({
        immediate: t.Optional(t.String()),
        state: t.Optional(t.Record(t.String(), t.String())),
        knowledge: t.Optional(t.Array(t.String())),
        secrets: t.Optional(t.Array(t.String())),
      }),
      detail: { summary: 'Update live state for a character on the active branch' },
    })

    .post('/stories/:storyId/librarian/analyze', async ({ params, body, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }
      const { fragmentId } = body as { fragmentId: string }
      if (!fragmentId) {
        set.status = 422
        return { error: 'fragmentId is required' }
      }
      const fragment = await getFragment(dataDir, params.storyId, fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }
      triggerLibrarian(dataDir, params.storyId, fragment).catch((err) => {
        logger.error('Manual librarian trigger failed', { error: err instanceof Error ? err.message : String(err) })
      })
      return { ok: true, fragmentId }
    }, { detail: { summary: 'Trigger librarian analysis on a specific fragment' } })

    .get('/stories/:storyId/librarian/analyses', async ({ params }) => {
      return listLibrarianAnalyses(dataDir, params.storyId)
    }, { detail: { summary: 'List all analyses' } })

    .get('/stories/:storyId/librarian/agent-runs', async ({ params }) => {
      return listAgentRuns(params.storyId)
    }, { detail: { summary: 'List agent runs' } })

    .get('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      return analysis
    }, { detail: { summary: 'Get an analysis by ID' } })

    /**
     * Updates both the analysis intent and its canonical summary-fragment
     * artifact. Analyses created before summary fragments existed have no
     * linked artifact and remain editable as historical records only.
     */
    .patch('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, body, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const nextSummary = body.summaryUpdate.trim()

      analysis.summaryUpdate = nextSummary
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)

      return analysis
    }, {
      body: t.Object({
        summaryUpdate: t.String(),
      }),
      detail: { summary: 'Update an analysis summary and its linked summary fragment' },
    })

    .post('/stories/:storyId/librarian/analyses/:analysisId/change-proposals/:index/accept', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      const index = parseInt(params.index, 10)
      if (isNaN(index) || index < 0 || index >= analysis.fragmentChangeProposals.length) {
        set.status = 422
        return { error: 'Invalid fragment change proposal index' }
      }

      let result: Awaited<ReturnType<typeof applyFragmentChangeProposal>>
      try {
        result = await applyFragmentChangeProposal({
          dataDir,
          storyId: params.storyId,
          analysis,
          proposalIndex: index,
          reason: 'manual-accept',
        })
      } catch (error) {
        if (error instanceof ProposalApplyError) {
          // Some operations wrote to disk before a later one failed. Record the
          // partial application so it stays visible and revertible.
          markFragmentChangeProposalApplied({
            analysis,
            proposalIndex: index,
            result: error.partial,
            autoApplied: false,
          })
          await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
        } else if (error instanceof ProposalValidationError) {
          // Nothing was written; the proposal is stale against current fragment
          // state (typically a sibling proposal already landed the same change).
          // Mark it so the user is not offered an accept that can only fail again.
          markFragmentChangeProposalStale({
            analysis,
            proposalIndex: index,
            reason: error.message,
            validation: error.results,
          })
          await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
        }
        set.status = 422
        return { error: error instanceof Error ? error.message : String(error), analysis }
      }

      markFragmentChangeProposalApplied({
        analysis,
        proposalIndex: index,
        result,
        autoApplied: false,
      })
      // A successful apply can invalidate sibling proposals that carry the same
      // change; mark them stale now instead of letting their accept fail later.
      await refreshPendingFragmentChangeProposals({ dataDir, storyId: params.storyId, analysis })
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
      return {
        analysis,
        ...result,
      }
    }, { detail: { summary: 'Accept a fragment change proposal' } })

    .post('/stories/:storyId/librarian/analyses/:analysisId/change-proposals/:index/revert', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      const index = parseInt(params.index, 10)
      if (isNaN(index) || index < 0 || index >= analysis.fragmentChangeProposals.length) {
        set.status = 422
        return { error: 'Invalid fragment change proposal index' }
      }

      let result: Awaited<ReturnType<typeof revertFragmentChangeProposal>>
      try {
        result = await revertFragmentChangeProposal({
          dataDir,
          storyId: params.storyId,
          analysis,
          proposalIndex: index,
        })
      } catch (error) {
        if (error instanceof RevertConflictError) {
          set.status = 409
          return {
            error: error.message,
            ...(error.partial ? { partial: error.partial } : {}),
          }
        }
        set.status = 422
        return { error: error instanceof Error ? error.message : String(error) }
      }

      await markFragmentChangeProposalReverted({
        dataDir,
        storyId: params.storyId,
        analysis,
        proposalIndex: index,
        result,
      })
      // Reverting can make sibling proposals valid again (their change is no
      // longer duplicated); revive any that were auto-marked stale.
      await refreshPendingFragmentChangeProposals({ dataDir, storyId: params.storyId, analysis })
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
      return {
        analysis,
        ...result,
      }
    }, { detail: { summary: 'Revert an accepted fragment change proposal' } })

    .post('/stories/:storyId/librarian/analyses/:analysisId/change-proposals/:index/dismiss', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      const index = parseInt(params.index, 10)
      if (isNaN(index) || index < 0 || index >= analysis.fragmentChangeProposals.length) {
        set.status = 422
        return { error: 'Invalid fragment change proposal index' }
      }

      analysis.fragmentChangeProposals[index].dismissed = true
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
      return { analysis }
    }, { detail: { summary: 'Dismiss a fragment change proposal' } })

    .post('/stories/:storyId/librarian/analyses/:analysisId/contradictions/:index/dismiss', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      const index = parseInt(params.index, 10)
      if (isNaN(index) || index < 0 || index >= analysis.contradictions.length) {
        set.status = 422
        return { error: 'Invalid contradiction index' }
      }

      analysis.contradictions[index].dismissed = true
      analysis.contradictions[index].dismissedAt = new Date().toISOString()
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
      return { analysis }
    }, { detail: { summary: 'Dismiss a contradiction finding' } })

    .delete('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, set }) => {
      const { deleteAnalysis } = await import('../librarian/storage')
      const deleted = await deleteAnalysis(dataDir, params.storyId, params.analysisId)
      if (!deleted) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      return { ok: true }
    }, { detail: { summary: 'Delete an analysis' } })

    // --- Librarian Refine ---
    .post('/stories/:storyId/librarian/refine', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Refinement request started', { fragmentId: body.fragmentId })

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const fragment = await getFragment(dataDir, params.storyId, body.fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }

      if (fragment.type === 'prose') {
        set.status = 422
        return { error: 'Cannot refine prose fragments. Use the generation refine mode instead.' }
      }

      let agent: ReturnType<typeof createAgentInstance> | undefined
      try {
        agent = createAgentInstance('librarian.refine', {
          dataDir,
          storyId: params.storyId,
          runId: body.runId,
        })
        const { eventStream, completion } = await agent.execute({
          fragmentId: body.fragmentId,
          instructions: body.instructions,
          maxSteps: story.settings.maxSteps ?? 5,
        })

        completion.then((result) => {
          requestLogger.info('Refinement completed', {
            fragmentId: body.fragmentId,
            stepCount: result.stepCount,
            finishReason: result.finishReason,
            toolCallCount: result.toolCalls.length,
          })
        }).catch((err) => {
          requestLogger.error('Refinement completion error', { error: err instanceof Error ? err.message : String(err) })
        })

        return new Response(encodeStream(eventStream), {
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        })
      } catch (err) {
        // Runner threw before producing a stream — record the failure and free
        // the active-agent registration instead of leaking it.
        agent?.fail(err)
        requestLogger.error('Refinement failed', { error: err instanceof Error ? err.message : String(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Refinement failed' }
      }
    }, {
      body: t.Object({
        runId: t.Optional(t.String()),
        fragmentId: t.String(),
        instructions: t.Optional(t.String()),
      }),
      detail: { summary: 'Refine a non-prose fragment (streaming NDJSON)' },
    })

    // --- Librarian Prose Transform ---
    .post('/stories/:storyId/librarian/prose-transform', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Prose transform request started', {
        fragmentId: body.fragmentId,
        operation: body.operation,
      })

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const fragment = await getFragment(dataDir, params.storyId, body.fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }

      if (fragment.type !== 'prose') {
        set.status = 422
        return { error: 'Only prose fragments support selection transforms.' }
      }

      let agent: ReturnType<typeof createAgentInstance> | undefined
      try {
        agent = createAgentInstance('librarian.prose-transform', {
          dataDir,
          storyId: params.storyId,
          runId: body.runId,
        })
        const { eventStream, completion } = await agent.execute({
          fragmentId: body.fragmentId,
          selectedText: body.selectedText,
          operation: body.operation,
          instruction: body.instruction,
          sourceContent: body.sourceContent,
          contextBefore: body.contextBefore,
          contextAfter: body.contextAfter,
        })

        completion.then((result) => {
          requestLogger.info('Prose transform completed', {
            fragmentId: body.fragmentId,
            operation: body.operation,
            stepCount: result.stepCount,
            finishReason: result.finishReason,
            outputLength: result.text.trim().length,
            reasoningLength: result.reasoning.trim().length,
          })
        }).catch((err) => {
          requestLogger.error('Prose transform completion error', {
            error: err instanceof Error ? err.message : String(err),
          })
        })

        return new Response(encodeStream(eventStream), {
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        })
      } catch (err) {
        agent?.fail(err)
        requestLogger.error('Prose transform failed', { error: err instanceof Error ? err.message : String(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Prose transform failed' }
      }
    }, {
      body: t.Object({
        runId: t.Optional(t.String()),
        fragmentId: t.String(),
        selectedText: t.String({ minLength: 1 }),
        operation: t.Union([t.Literal('rewrite'), t.Literal('expand'), t.Literal('compress'), t.Literal('custom')]),
        instruction: t.Optional(t.String()),
        sourceContent: t.Optional(t.String()),
        contextBefore: t.Optional(t.String()),
        contextAfter: t.Optional(t.String()),
      }),
      detail: { summary: 'Transform a prose selection (streaming NDJSON)' },
    })

    // --- Conversations ---
    .get('/stories/:storyId/librarian/conversations', async ({ params }) => {
      return listConversations(dataDir, params.storyId)
    }, { detail: { summary: 'List chat conversations' } })

    .post('/stories/:storyId/librarian/conversations', async ({ params, body }) => {
      return createConversation(dataDir, params.storyId, body.title ?? 'New chat')
    }, {
      body: t.Object({ title: t.Optional(t.String()) }),
      detail: { summary: 'Create a chat conversation' },
    })

    .delete('/stories/:storyId/librarian/conversations/:conversationId', async ({ params, set }) => {
      const ok = await deleteConversation(dataDir, params.storyId, params.conversationId)
      if (!ok) { set.status = 404; return { error: 'Conversation not found' } }
      return { ok: true }
    }, { detail: { summary: 'Delete a conversation' } })

    .get('/stories/:storyId/librarian/conversations/:conversationId/chat', async ({ params }) => {
      return getConversationHistory(dataDir, params.storyId, params.conversationId)
    }, { detail: { summary: 'Get conversation chat history' } })

    .post('/stories/:storyId/librarian/conversations/:conversationId/chat', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId, extra: { conversationId: params.conversationId } })
      requestLogger.info('Conversation chat request', { messageCount: body.messages.length })

      const story = await getStory(dataDir, params.storyId)
      if (!story) { set.status = 404; return { error: 'Story not found' } }
      if (!body.messages.length) { set.status = 422; return { error: 'At least one message is required' } }

      let agent: ReturnType<typeof createAgentInstance> | undefined
      try {
        agent = createAgentInstance('librarian.chat', {
          dataDir,
          storyId: params.storyId,
          runId: body.runId,
        })
        const { eventStream, completion } = await agent.execute({
          messages: body.messages,
          maxSteps: story.settings.maxSteps ?? 10,
        })

        completion.then(async (result) => {
          requestLogger.info('Conversation chat completed', {
            stepCount: result.stepCount,
            finishReason: result.finishReason,
            toolCallCount: result.toolCalls.length,
          })
          const fullHistory = [
            ...body.messages,
            {
              role: 'assistant' as const,
              content: result.text,
              ...(result.reasoning ? { reasoning: result.reasoning } : {}),
            },
          ]
          await saveConversationHistory(dataDir, params.storyId, params.conversationId, fullHistory)
        }).catch((err) => {
          requestLogger.error('Conversation chat completion error', { error: err instanceof Error ? err.message : String(err) })
        })

        return new Response(encodeStream(eventStream), {
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        })
      } catch (err) {
        agent?.fail(err)
        requestLogger.error('Conversation chat failed', { error: err instanceof Error ? err.message : String(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Chat failed' }
      }
    }, {
      body: t.Object({
        runId: t.Optional(t.String()),
        messages: t.Array(t.Object({
          role: t.Union([t.Literal('user'), t.Literal('assistant')]),
          content: t.String(),
        })),
      }),
      detail: { summary: 'Chat in a conversation (streaming NDJSON)' },
    })
}
