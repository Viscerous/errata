import { MISSING_SYSTEM_PROMPT_FALLBACK } from '../instructions'
import type { ToolSet } from 'ai'
import type { Fragment, StoryMeta } from '../fragments/schema'
import { compileAgentContext } from '../agents/compile-agent-context'
import type { ActivityStreamEvent } from '../agents/activity-stream'
import type { ContextMessage } from '../llm/context-builder'
import type { resolveAgentRuntime } from '../llm/client'
import { resolveAndReportServedUsage } from '../llm/usage-normalizer'
import type { ContextSelectionSource, FragmentSignal } from '../llm/context-selection'
import { buildAnalyzeContext } from './blocks'
import {
  createEmptyCollector,
  createLibrarianOnlineTools,
  type AnalysisCollector,
} from './analysis-tools'
import {
  type FragmentCandidate,
  fragmentCandidateIds,
  listRoutableMemoryFragments,
  mergeFragmentCandidates,
  observationFragmentCandidates,
  writerProvenanceFragmentCandidates,
  type MergedFragmentCandidate,
} from './candidates'
import {
  passRecord,
  type LibrarianAnalyzeLaneStatus,
  type LibrarianPassRecord,
} from './storage'
import { runToolLoopPass, type ToolLoopPassArgs } from './tool-runner'

type LibrarianRuntime = Awaited<ReturnType<typeof resolveAgentRuntime>>

type PipelineLogger = {
  info(message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

interface RunCompiledPassArgs {
  compiled: { messages: ContextMessage[]; tools: ToolSet; blocks: Array<{ id: string }> }
  model: ToolLoopPassArgs['model']
  temperature: ToolLoopPassArgs['temperature']
  providerOptions: ToolLoopPassArgs['providerOptions']
  maxOutputTokens: number
  maxSteps?: number
  emit: (event: ActivityStreamEvent) => void
  terminalToolName?: string
  terminalRequiresToolName?: string
  abortSignal?: AbortSignal
  idleTimeoutMs?: number
}

export interface LibrarianPipelineInput {
  dataDir: string
  storyId: string
  story: StoryMeta
  fragment: Fragment
  runtime: LibrarianRuntime
  requestLogger: PipelineLogger
  emit: (event: ActivityStreamEvent) => void
  abortSignal?: AbortSignal
  idleTimeoutMs?: number
}

export interface LibrarianPipelineResult {
  collector: AnalysisCollector
  passes: LibrarianPassRecord[]
  mentionedFragmentIds: string[]
  candidateFragmentIds: string[]
  candidateFragments: MergedFragmentCandidate[]
  finishReason: string
  stepCount: number
  analyzeLanes: LibrarianAnalyzeLaneStatus
  /** Set when the observation was recoverable but a required/started tail did not finish. */
  completionError?: string
}

interface CandidateState {
  candidateFragmentIds: string[]
  observedFragmentIds: string[]
}

async function runCompiledToolPass(args: RunCompiledPassArgs): Promise<{
  fullText: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>
  stepCount: number
  finishReason: string
  servedModelId?: string
  totalUsage: PromiseLike<unknown>
}> {
  const systemMessage = args.compiled.messages.find(m => m.role === 'system')
  const userMessage = args.compiled.messages.find(m => m.role === 'user')
  return runToolLoopPass({
    model: args.model,
    instructions: systemMessage?.content || MISSING_SYSTEM_PROMPT_FALLBACK,
    tools: args.compiled.tools,
    prompt: userMessage?.content ?? '',
    temperature: args.temperature,
    providerOptions: args.providerOptions,
    maxOutputTokens: args.maxOutputTokens,
    maxSteps: args.maxSteps,
    emit: args.emit,
    terminalToolName: args.terminalToolName,
    terminalRequiresToolName: args.terminalRequiresToolName,
    abortSignal: args.abortSignal,
    idleTimeoutMs: args.idleTimeoutMs,
  })
}

function candidateState(candidates: MergedFragmentCandidate[], mentionedFragmentIds: string[]): CandidateState {
  const mergedCandidateIds = fragmentCandidateIds(candidates)
  const candidateFragmentIds = mergedCandidateIds.filter((id) => !mentionedFragmentIds.includes(id))
  return {
    candidateFragmentIds,
    observedFragmentIds: [...new Set([
      ...mentionedFragmentIds,
      ...mergedCandidateIds,
    ])],
  }
}

function candidateSignals(candidates: MergedFragmentCandidate[]): FragmentSignal[] {
  return candidates.map((candidate) => ({
    fragmentId: candidate.fragmentId,
    sources: candidate.sources as ContextSelectionSource[],
  }))
}

function unmergeCandidates(candidates: MergedFragmentCandidate[]): FragmentCandidate[] {
  return candidates.flatMap((candidate) =>
    candidate.sources.map((source) => ({
      fragmentId: candidate.fragmentId,
      source,
      reason: candidate.reasons?.join(' / '),
      score: candidate.score,
    })),
  )
}

function numericToolResultField(result: unknown, field: string): number {
  if (!result || typeof result !== 'object') return 0
  const value = (result as Record<string, unknown>)[field]
  return typeof value === 'number' ? value : 0
}

function booleanToolResultField(result: unknown, field: string): boolean | undefined {
  if (!result || typeof result !== 'object') return undefined
  const value = (result as Record<string, unknown>)[field]
  return typeof value === 'boolean' ? value : undefined
}

function lastToolResultFailed(
  toolCalls: Array<{ toolName: string; result: unknown }>,
  toolNames: Set<string>,
): boolean {
  const lastResults = new Map<string, unknown>()
  for (const call of toolCalls) {
    if (toolNames.has(call.toolName)) lastResults.set(call.toolName, call.result)
  }
  return [...lastResults.values()].some((result) => booleanToolResultField(result, 'ok') === false)
}

function analyzeLaneStatus(args: {
  collector: AnalysisCollector
  disableDirections: boolean
  disableSuggestions: boolean
  toolCalls: Array<{ toolName: string; result: unknown }>
  passFailed: boolean
  observationComplete: boolean
}): LibrarianAnalyzeLaneStatus {
  const proposalToolNames = new Set(['proposeRecordCorrections', 'proposeNewRecords'])
  const proposalCalls = args.toolCalls.filter((call) => proposalToolNames.has(call.toolName))
  const finishSucceeded = args.toolCalls.some((call) =>
    call.toolName === 'finishAnalysis' && booleanToolResultField(call.result, 'ok') !== false
  )
  const proposalIncomplete = args.passFailed
    ? proposalCalls.length > 0 || args.collector.fragmentChangeProposals.length > 0
    : lastToolResultFailed(proposalCalls, proposalToolNames) && !finishSucceeded

  return {
    observation: {
      requirement: 'required',
      completion: args.observationComplete ? 'complete' : 'incomplete',
    },
    recordMaintenance: args.disableSuggestions
      ? { requirement: 'disabled', completion: 'disabled' }
      : {
          requirement: 'conditional',
          completion: proposalIncomplete
            ? 'incomplete'
            : proposalCalls.length > 0 || args.collector.fragmentChangeProposals.length > 0
              ? 'complete'
              : 'not-needed',
        },
    directions: args.disableDirections
      ? { requirement: 'disabled', completion: 'disabled' }
      : {
          requirement: 'required',
          completion: args.collector.directions.length > 0 ? 'complete' : 'incomplete',
        },
  }
}

async function initialOnlineCandidates(input: LibrarianPipelineInput): Promise<{
  candidates: MergedFragmentCandidate[]
}> {
  const { dataDir, storyId, story, fragment } = input
  const routableFragments = await listRoutableMemoryFragments(dataDir, storyId, story)
  const writerCandidates = writerProvenanceFragmentCandidates(story, fragment, routableFragments)
  return {
    candidates: mergeFragmentCandidates(writerCandidates),
  }
}

async function runOnlineAnalyzePass(
  input: LibrarianPipelineInput,
  collector: AnalysisCollector,
  initialCandidates: MergedFragmentCandidate[],
  disableDirections: boolean,
  disableSuggestions: boolean,
): Promise<{
  fullText: string
  pass: LibrarianPassRecord
  stepCount?: number
  finishReason?: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>
  error?: unknown
}> {
  const { dataDir, storyId, story, fragment, runtime, requestLogger, emit, abortSignal, idleTimeoutMs } = input
  const { model, modelId, providerId, config, temperature, providerOptions, guards } = runtime
  const analyzeStartedAt = new Date().toISOString()
  const analyzeStartTime = Date.now()
  const requestHeaders = {
    ...config.headers,
    'User-Agent': config.headers['User-Agent'] ?? 'errata-librarian/1.0',
  }

  try {
    const context = await buildAnalyzeContext(dataDir, storyId, story, {
      proseFragment: fragment,
      newProse: { id: fragment.id, content: fragment.content },
    })
    context.modelId = modelId
    context.attentionCandidateIds = fragmentCandidateIds(initialCandidates)
    context.attentionCandidateSignals = candidateSignals(initialCandidates)

    // Seeded from the compiled blocks below, then extended by the tools as they
    // show records numbered. Keeping the Set by reference lets reportAnalysis
    // distinguish actual full presentation from fragments a default block would
    // have shown before user overrides were applied.
    const numberedFragmentIds = new Set<string>()

    // The live registry is repeated beside each key field. It steers reuse
    // without making the registry a closed enum, which smaller models handled
    // poorly and which rejected the whole batched report on a wrong choice.
    const continuityKeys = {
      state: (context.continuityView?.currentState ?? []).map((entry) => ({
        key: entry.stateKey,
        label: entry.subject,
      })),
      thread: (context.continuityView?.liveThreads ?? []).map((entry) => ({
        key: entry.threadKey,
        label: entry.label,
      })),
      knowledge: (context.continuityView?.characterKnowledge ?? [])
        .map((entry) => ({
          key: entry.knowledgeKey,
          label: entry.fact,
          scope: entry.characterId,
        })),
    }

    const tools = createLibrarianOnlineTools(collector, {
      dataDir,
      storyId,
      proseFragmentId: fragment.id,
      disableDirections,
      disableSuggestions,
      numberedFragmentIds,
      continuityKeys,
      customFragmentTypes: story.settings.customFragmentTypes,
    })
    const compiled = await compileAgentContext(dataDir, storyId, 'librarian.analyze', context, tools)
    for (const block of compiled.blocks) {
      if (block.fragmentContext?.mode !== 'full') continue
      for (const fragmentId of block.fragmentContext.fragmentIds ?? []) {
        numberedFragmentIds.add(fragmentId)
      }
    }
    requestLogger.info('Calling LLM for online analysis...', {
      attentionCandidates: context.attentionCandidateIds.length,
      toolNames: Object.keys(compiled.tools),
    })

    const result = await runCompiledToolPass({
      compiled,
      model,
      temperature,
      providerOptions,
      maxOutputTokens: guards.maxOutputTokens,
      maxSteps: 8,
      emit,
      terminalToolName: compiled.tools.finishAnalysis ? 'finishAnalysis' : undefined,
      terminalRequiresToolName: compiled.tools.finishAnalysis && compiled.tools.reportAnalysis ? 'reportAnalysis' : undefined,
      abortSignal,
      idleTimeoutMs,
    })
    // Attribute the work to the model that answered, not the one configured —
    // behind a local endpoint those differ silently, and every analysis in a
    // whole Qwen branch recorded itself as the Gemma the config still named.
    const { modelId: servedModelId } = await resolveAndReportServedUsage(
      dataDir,
      storyId,
      'librarian.analyze',
      result.totalUsage,
      { providerId, configuredModelId: modelId, servedModelId: result.servedModelId },
    )

    requestLogger.info('LLM online analysis completed', {
      durationMs: Date.now() - analyzeStartTime,
      providerId,
      modelId: servedModelId,
      providerName: config.providerName,
      baseURL: config.baseURL,
      headers: Object.keys(requestHeaders),
    })

    const toolCallNames = result.toolCalls.map((call) => call.toolName)
    const proposalToolNames = new Set(['proposeRecordCorrections', 'proposeNewRecords'])
    const proposalToolCalls = toolCallNames.filter((name) => proposalToolNames.has(name))
    const directionToolCalls = toolCallNames.filter((name) => name === 'proposeDirections')
    const finishToolCalls = toolCallNames.filter((name) => name === 'finishAnalysis')
    const proposalToolResults = result.toolCalls
      .filter((call) => proposalToolNames.has(call.toolName))
      .map((call) => call.result)
    return {
      fullText: result.fullText,
      stepCount: result.stepCount,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls,
      pass: passRecord({
        name: 'analyze',
        status: 'complete',
        startedAt: analyzeStartedAt,
        durationMs: Date.now() - analyzeStartTime,
        modelId: servedModelId,
        stepCount: result.stepCount,
        finishReason: result.finishReason,
        diagnostics: {
          toolNames: Object.keys(compiled.tools),
          toolCallNames,
          reportToolCallCount: toolCallNames.filter((name) => name === 'reportAnalysis').length,
          proposalToolCallCount: proposalToolCalls.length,
          proposalToolFailureCount: proposalToolResults.filter((toolResult) => booleanToolResultField(toolResult, 'ok') === false).length,
          proposalQueuedOperationCount: proposalToolResults.reduce<number>((sum, toolResult) => sum + numericToolResultField(toolResult, 'queuedOperationCount'), 0),
          proposalInvalidOperationCount: proposalToolResults.reduce<number>((sum, toolResult) => sum + numericToolResultField(toolResult, 'invalid'), 0),
          directionToolCallCount: directionToolCalls.length,
          finishToolCallCount: finishToolCalls.length,
          blockIds: compiled.blocks.map((block) => block.id),
          attentionCandidateIds: context.attentionCandidateIds,
          initialCandidateFragments: initialCandidates,
          proposalCount: collector.fragmentChangeProposals.length,
          directionCount: collector.directions.length,
        },
      }),
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    requestLogger.error('Online analysis failed', { error: errorMsg })
    emit({ type: 'error', error: errorMsg })
    return {
      fullText: '',
      toolCalls: [],
      error: err,
      pass: passRecord({
        name: 'analyze',
        status: 'failed',
        startedAt: analyzeStartedAt,
        durationMs: Date.now() - analyzeStartTime,
        modelId,
        error: errorMsg,
      }),
    }
  }
}

export async function runLibrarianPipeline(input: LibrarianPipelineInput): Promise<LibrarianPipelineResult> {
  const { requestLogger, emit } = input
  const disableDirections = input.story.settings?.disableLibrarianDirections === true
  const disableSuggestions = input.story.settings?.disableLibrarianSuggestions === true
  const collector = createEmptyCollector()
  const passes: LibrarianPassRecord[] = []

  const initial = await initialOnlineCandidates(input)
  const analyzeOutcome = await runOnlineAnalyzePass(
    input,
    collector,
    initial.candidates,
    disableDirections,
    disableSuggestions,
  )
  passes.push(analyzeOutcome.pass)
  const observationComplete = collector.summaryUpdate.trim().length > 0
  if (analyzeOutcome.pass.status === 'failed' && !observationComplete) {
    if (analyzeOutcome.error instanceof Error) throw analyzeOutcome.error
    throw new Error(analyzeOutcome.pass.error ?? 'Online analysis failed')
  }
  if (!observationComplete) {
    throw new Error('Analyze ended without completing the required observation lane')
  }

  const analyzeLanes = analyzeLaneStatus({
    collector,
    disableDirections,
    disableSuggestions,
    toolCalls: analyzeOutcome.toolCalls,
    passFailed: analyzeOutcome.pass.status === 'failed',
    observationComplete,
  })
  let completionError: string | undefined
  if (analyzeOutcome.pass.status === 'failed') {
    completionError = analyzeOutcome.pass.error ?? 'Analyze stopped after completing its observation lane'
  } else if (analyzeLanes.directions.completion === 'incomplete') {
    completionError = 'Analyze ended without completing automatic directions required by the story setting'
  } else if (analyzeLanes.recordMaintenance.completion === 'incomplete') {
    completionError = 'Analyze ended with an unresolved record-maintenance attempt'
  }

  const mentionedFragmentIds = [...new Set(collector.mentions.map(m => m.fragmentId))]
  const observationCandidates = observationFragmentCandidates({
    mentionedFragmentIds,
    candidateFragmentIds: collector.candidateFragmentIds,
  })
  const candidateFragments = mergeFragmentCandidates(
    unmergeCandidates(initial.candidates),
    observationCandidates,
  )
  const currentCandidateState = candidateState(candidateFragments, mentionedFragmentIds)

  requestLogger.debug('Analysis parsed', {
    mentions: collector.mentions.length,
    mentionedFragments: mentionedFragmentIds.length,
    candidateFragments: currentCandidateState.candidateFragmentIds.length,
    observedFragments: currentCandidateState.observedFragmentIds.length,
    contradictions: collector.contradictions.length,
    fragmentChangeProposals: collector.fragmentChangeProposals.length,
    directions: collector.directions.length,
    timelineEvents: collector.timelineEvents.length,
  })

  emit({
    type: 'finish',
    finishReason: analyzeOutcome.finishReason ?? 'unknown',
    stepCount: analyzeOutcome.stepCount ?? 0,
  })

  return {
    collector,
    passes,
    mentionedFragmentIds,
    candidateFragmentIds: currentCandidateState.candidateFragmentIds,
    candidateFragments,
    finishReason: analyzeOutcome.finishReason ?? 'unknown',
    stepCount: analyzeOutcome.stepCount ?? 0,
    analyzeLanes,
    ...(completionError ? { completionError } : {}),
  }
}
