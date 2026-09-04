import { MISSING_SYSTEM_PROMPT_FALLBACK } from '../instructions'
import type { ToolSet } from 'ai'
import type { Fragment, StoryMeta } from '../fragments/schema'
import { compileAgentContext } from '../agents/compile-agent-context'
import type { ActivityStreamEvent } from '../agents/activity-stream'
import type { ContextMessage } from '../llm/context-builder'
import { samplingDiagnostics, type resolveAgentRuntime } from '../llm/client'
import { normalizeTokenUsage, resolveAndReportServedUsage } from '../llm/usage-normalizer'
import type { ContextSelectionSource, FragmentSignal } from '../llm/context-selection'
import { buildAnalyzeContext } from './blocks'
import { continuityRegistry } from './continuity-view'
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
import {
  runToolLoopPass,
  ToolLoopPassError,
  type ToolLoopPassArgs,
  type ToolLoopStepUsage,
} from './tool-runner'

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
  topP: ToolLoopPassArgs['topP']
  topK: ToolLoopPassArgs['topK']
  providerOptions: ToolLoopPassArgs['providerOptions']
  maxOutputTokens?: number
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
  /** True only after finishAnalysis accepted the complete workflow. */
  workflowComplete: boolean
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
  stepUsages: ToolLoopStepUsage[]
}> {
  const systemMessage = args.compiled.messages.find(m => m.role === 'system')
  const userMessage = args.compiled.messages.find(m => m.role === 'user')
  return runToolLoopPass({
    model: args.model,
    instructions: systemMessage?.content || MISSING_SYSTEM_PROMPT_FALLBACK,
    tools: args.compiled.tools,
    prompt: userMessage?.content ?? '',
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
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
  const finishSucceeded = toolCallSucceeded(args.toolCalls, 'finishAnalysis')
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

type OnlineToolCall = { toolName: string; args: Record<string, unknown>; result: unknown }

interface OnlinePassOutcome {
  fullText: string
  pass: LibrarianPassRecord
  stepCount?: number
  finishReason?: string
  toolCalls: OnlineToolCall[]
  workflowComplete: boolean
  error?: unknown
}

function toolCallSucceeded(
  toolCalls: Array<{ toolName: string; result: unknown }>,
  toolName: string,
): boolean {
  return toolCalls.some((call) => call.toolName === toolName && booleanToolResultField(call.result, 'ok') === true)
}

function registerFullContextFragments(
  compiled: { blocks: Array<{ fragmentContext?: { mode?: string; fragmentIds?: string[] } }> },
  numberedFragmentIds: Set<string>,
): void {
  for (const block of compiled.blocks) {
    if (block.fragmentContext?.mode !== 'full') continue
    for (const fragmentId of block.fragmentContext.fragmentIds ?? []) numberedFragmentIds.add(fragmentId)
  }
}

function aggregateCompletedStepUsage(stepUsages: ToolLoopStepUsage[]): { inputTokens: number; outputTokens: number } | undefined {
  let inputTokens = 0
  let outputTokens = 0
  let found = false
  for (const step of stepUsages) {
    const usage = normalizeTokenUsage(step.usage)
    if (!usage) continue
    found = true
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
  }
  return found ? { inputTokens, outputTokens } : undefined
}

function completedStepUsageDiagnostics(stepUsages: ToolLoopStepUsage[]): Array<Record<string, unknown>> {
  return stepUsages.map((step) => {
    const usage = normalizeTokenUsage(step.usage)
    return {
      stepNumber: step.stepNumber,
      finishReason: step.finishReason,
      ...(step.servedModelId ? { modelId: step.servedModelId } : {}),
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
    }
  })
}

async function runOnlineAnalyzePass(
  input: LibrarianPipelineInput,
  collector: AnalysisCollector,
  initialCandidates: MergedFragmentCandidate[],
  disableDirections: boolean,
  disableSuggestions: boolean,
): Promise<OnlinePassOutcome> {
  const { dataDir, storyId, story, fragment, runtime, requestLogger, emit, abortSignal, idleTimeoutMs } = input
  const { model, modelId, providerId, config, temperature, topP, topK, providerOptions, guards } = runtime
  const startedAt = new Date().toISOString()
  const startTime = Date.now()
  const sampling = samplingDiagnostics(runtime)
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

    // Seeded from the compiled blocks below, then extended by tools as they show
    // numbered records. The shared ledger suppresses duplicate reads within the
    // adaptive tool loop without forcing a second model invocation.
    const numberedFragmentIds = new Set<string>()
    const tools = createLibrarianOnlineTools(collector, {
      dataDir,
      storyId,
      proseFragmentId: fragment.id,
      disableDirections,
      disableSuggestions,
      numberedFragmentIds,
      continuityKeys: continuityRegistry(context),
      customFragmentTypes: story.settings.customFragmentTypes,
    })
    const compiled = await compileAgentContext(
      dataDir,
      storyId,
      'librarian.analyze',
      context,
      tools,
    )
    registerFullContextFragments(compiled, numberedFragmentIds)

    requestLogger.info('Calling LLM for online analysis...', {
      attentionCandidates: context.attentionCandidateIds.length,
      toolNames: Object.keys(compiled.tools),
      blockIds: compiled.blocks.map((block) => block.id),
      sampling,
    })

    const result = await runCompiledToolPass({
      compiled,
      model,
      temperature,
      topP,
      topK,
      providerOptions,
      maxOutputTokens: guards.maxOutputTokens,
      maxSteps: 8,
      emit,
      terminalToolName: compiled.tools.finishAnalysis ? 'finishAnalysis' : undefined,
      terminalRequiresToolName: compiled.tools.finishAnalysis && compiled.tools.reportAnalysis
        ? 'reportAnalysis'
        : undefined,
      abortSignal,
      idleTimeoutMs,
    })
    const { modelId: servedModelId, usage } = await resolveAndReportServedUsage(
      dataDir,
      storyId,
      'librarian.analyze',
      result.totalUsage,
      { providerId, configuredModelId: modelId, servedModelId: result.servedModelId },
    )
    const toolCallNames = result.toolCalls.map((call) => call.toolName)
    const workflowComplete = toolCallSucceeded(result.toolCalls, 'finishAnalysis')
    const proposalToolNames = new Set(['proposeRecordCorrections', 'proposeNewRecords'])
    const proposalToolResults = result.toolCalls
      .filter((call) => proposalToolNames.has(call.toolName))
      .map((call) => call.result)
    const stepUsage = completedStepUsageDiagnostics(result.stepUsages)
    const durationMs = Date.now() - startTime
    const diagnostics = {
      toolNames: Object.keys(compiled.tools),
      toolCallNames,
      blockIds: compiled.blocks.map((block) => block.id),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      sampling,
      stepUsage,
      reportToolCallCount: toolCallNames.filter((name) => name === 'reportAnalysis').length,
      proposalToolCallCount: proposalToolResults.length,
      proposalToolFailureCount: proposalToolResults.filter((result) => booleanToolResultField(result, 'ok') === false).length,
      proposalQueuedOperationCount: proposalToolResults.reduce<number>((sum, result) => sum + numericToolResultField(result, 'queuedOperationCount'), 0),
      proposalInvalidOperationCount: proposalToolResults.reduce<number>((sum, result) => sum + numericToolResultField(result, 'invalid'), 0),
      directionToolCallCount: toolCallNames.filter((name) => name === 'proposeDirections').length,
      finishToolCallCount: toolCallNames.filter((name) => name === 'finishAnalysis').length,
      workflowComplete,
      attentionCandidateIds: context.attentionCandidateIds,
      initialCandidateFragments: initialCandidates,
      proposalCount: collector.fragmentChangeProposals.length,
      directionCount: collector.directions.length,
    }

    requestLogger.info('LLM online analysis completed', {
      durationMs,
      providerId,
      modelId: servedModelId,
      providerName: config.providerName,
      baseURL: config.baseURL,
      headers: Object.keys(requestHeaders),
      finishReason: result.finishReason,
      stepCount: result.stepCount,
      ...diagnostics,
    })
    return {
      fullText: result.fullText,
      stepCount: result.stepCount,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls,
      workflowComplete,
      pass: passRecord({
        name: 'analyze',
        status: workflowComplete ? 'complete' : 'failed',
        startedAt,
        durationMs,
        modelId: servedModelId,
        stepCount: result.stepCount,
        finishReason: result.finishReason,
        ...(!workflowComplete ? { error: 'Analyze ended without a successful finishAnalysis call' } : {}),
        diagnostics,
      }),
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const stepUsages = error instanceof ToolLoopPassError ? error.stepUsages : []
    const partialUsage = aggregateCompletedStepUsage(stepUsages)
    const stepUsage = completedStepUsageDiagnostics(stepUsages)
    const partialServedModelId = [...stepUsages].reverse().find((step) => step.servedModelId)?.servedModelId
    let attributedModelId = modelId
    if (partialUsage) {
      const reported = await resolveAndReportServedUsage(
        dataDir,
        storyId,
        'librarian.analyze',
        Promise.resolve(partialUsage),
        { providerId, configuredModelId: modelId, servedModelId: partialServedModelId },
      )
      attributedModelId = reported.modelId
    }
    const diagnostics = {
      completedStepCount: stepUsages.length,
      inputTokens: partialUsage?.inputTokens,
      outputTokens: partialUsage?.outputTokens,
      sampling,
      stepUsage,
    }
    requestLogger.error('Online analysis failed', { error: errorMessage, ...diagnostics })
    emit({ type: 'error', error: errorMessage })
    return {
      fullText: '',
      toolCalls: [],
      workflowComplete: false,
      error,
      pass: passRecord({
        name: 'analyze',
        status: 'failed',
        startedAt,
        durationMs: Date.now() - startTime,
        modelId: attributedModelId,
        error: errorMessage,
        diagnostics,
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
  const passFailed = analyzeOutcome.pass.status === 'failed'
  const observationPresent = collector.summaryUpdate.trim().length > 0
  if (!observationPresent) {
    if (analyzeOutcome.error instanceof Error) throw analyzeOutcome.error
    throw new Error('Analyze ended without completing the required observation lane')
  }

  const analyzeLanes = analyzeLaneStatus({
    collector,
    disableDirections,
    disableSuggestions,
    toolCalls: analyzeOutcome.toolCalls,
    passFailed,
    observationComplete: observationPresent,
  })
  let completionError: string | undefined
  if (analyzeOutcome.error instanceof Error) {
    completionError = analyzeOutcome.pass.error ?? 'Analyze stopped after completing its observation lane'
  } else if (analyzeLanes.directions.completion === 'incomplete') {
    completionError = 'Analyze ended without completing automatic directions required by the story setting'
  } else if (analyzeLanes.recordMaintenance.completion === 'incomplete') {
    completionError = 'Analyze ended with an unresolved record-maintenance attempt'
  } else if (passFailed) {
    completionError = analyzeOutcome.pass.error ?? 'Analyze stopped without successfully finishing'
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
    events: collector.events.length,
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
    workflowComplete: analyzeOutcome.workflowComplete,
    ...(completionError ? { completionError } : {}),
  }
}
