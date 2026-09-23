import { MISSING_SYSTEM_PROMPT_FALLBACK } from '../instructions'
import type { ToolSet } from 'ai'
import type { Fragment, StoryMeta } from '@/contracts/story'
import { compileAgentContext } from '../agents/compile-agent-context'
import type { ActivityStreamEvent } from '../agents/activity-stream'
import {
  compileBlocks,
  expandMessagesFragmentTags,
  type ContextBlock,
  type ContextMessage,
} from '../llm/context-builder'
import { samplingDiagnostics, type resolveAgentRuntime } from '../llm/client'
import { toolCallOutputCap } from '../llm/output-budget'
import { normalizeTokenUsage, resolveAndReportServedUsage } from '../llm/usage-normalizer'
import type { ContextSelectionSource, FragmentSignal } from '../llm/context-selection'
import { buildAnalyzeContext } from './blocks'
import { continuityRegistry } from './continuity-view'
import {
  MAINTENANCE_REPORT_TOOL,
  createAnalysisTools,
  createEmptyCollector,
  needsRecordMaintenance,
  type AnalysisCollector,
} from './analysis-tools'
import { buildAnalyzeStagePlan, type AnalyzeStageId } from './analyze-stages'
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
  runStructuredPass,
  runToolLoopPass,
  ToolLoopPassError,
  type ToolLoopPassArgs,
  type ToolLoopPrepareStep,
  type ToolLoopStopWhen,
  type ToolLoopStepUsage,
} from './tool-runner'

export const DEFAULT_ANALYZE_IDLE_TIMEOUT_MS = 180_000

type LibrarianRuntime = Awaited<ReturnType<typeof resolveAgentRuntime>>

type PipelineLogger = {
  info(message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

interface RunCompiledPassArgs {
  compiled: { messages: ContextMessage[]; tools: ToolSet; blocks: ContextBlock[] }
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
  prepareStep?: ToolLoopPrepareStep
  stopWhen?: ToolLoopStopWhen
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
  /** True after required observation and direction work completes. */
  workflowComplete: boolean
  /** Set when the observation was recoverable but a required/started tail did not finish. */
  completionError?: string
}

interface CandidateState {
  candidateFragmentIds: string[]
  observedFragmentIds: string[]
}

class AnalyzeStageIncompleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalyzeStageIncompleteError'
  }
}

async function runCompiledToolPass(args: RunCompiledPassArgs): Promise<{
  fullText: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>
  toolErrors: Array<{ toolName: string; error: string }>
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
    prepareStep: args.prepareStep,
    stopWhen: args.stopWhen,
  })
}

/**
 * A structured answer is constrained by its schema but never shown it: the
 * server turns the schema into a decoding grammar, not into prompt text. The
 * task block therefore carries what a tool declaration would have: the tool's
 * description and its schema with field descriptions.
 */
function structuredOutputForm(tool: ToolSet[string]): string {
  const schema = (tool.inputSchema as { jsonSchema?: unknown }).jsonSchema
  return [
    tool.description ?? '',
    'Report form (JSON Schema):',
    JSON.stringify(schema),
  ].filter(Boolean).join('\n')
}

async function runCompiledStructuredPass(
  args: Omit<RunCompiledPassArgs, 'maxSteps' | 'terminalToolName' | 'terminalRequiresToolName' | 'prepareStep' | 'stopWhen'>
    & { toolName: string },
): ReturnType<typeof runStructuredPass> {
  const systemMessage = args.compiled.messages.find(m => m.role === 'system')
  const userMessage = args.compiled.messages.find(m => m.role === 'user')
  return runStructuredPass({
    model: args.model,
    instructions: systemMessage?.content || MISSING_SYSTEM_PROMPT_FALLBACK,
    prompt: userMessage?.content ?? '',
    toolName: args.toolName,
    tool: args.compiled.tools[args.toolName],
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
    providerOptions: args.providerOptions,
    maxOutputTokens: args.maxOutputTokens,
    emit: args.emit,
    abortSignal: args.abortSignal,
    idleTimeoutMs: args.idleTimeoutMs,
  })
}

async function withAnalyzeStagePrompt(
  compiled: RunCompiledPassArgs['compiled'],
  dataDir: string,
  storyId: string,
  stage: AnalyzeStageId,
  directive: string,
  handoff?: string,
  relevantFragmentIds: ReadonlySet<string> = new Set(),
): Promise<RunCompiledPassArgs['compiled']> {
  const compactBuiltinIds = new Set(['story-summary', 'prose-new'])
  const blocks = compiled.blocks.filter((block) => {
    if (stage === 'passage' || block.role === 'system' || block.source !== 'builtin') return true
    // Maintenance edits authored records; live state is not something it may
    // change, and showing it invites writing scene beats into canon. Of the
    // records, it sees the ones the passage report cited.
    if (compactBuiltinIds.has(block.id)) return true
    return (block.fragmentContext?.fragmentIds ?? []).some((id) => relevantFragmentIds.has(id))
  })
  blocks.push({
    id: `analyze-stage-${stage}`,
    role: 'user',
    content: ['## Current analysis task', directive, handoff].filter(Boolean).join('\n\n'),
    order: 900,
    source: 'builtin',
  })
  let messages = compileBlocks(blocks)
  messages = await expandMessagesFragmentTags(messages, dataDir, storyId)
  return {
    ...compiled,
    messages,
    blocks,
  }
}

/**
 * A stage request may produce its tool's largest well-formed call plus the
 * model's reasoning allowance, and no more. The provider is the only party that
 * can stop generation: a client abort does not reliably reach it, and a
 * degenerate continuation the server's tool-call parser withholds never shows
 * on the stream. An explicit story limit still applies when it is lower.
 */
function stageOutputCap(tool: ToolSet[string] | undefined, runtime: LibrarianRuntime): number | undefined {
  const schema = (tool?.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema
  const derived = schema
    ? toolCallOutputCap(schema, { enabled: runtime.thinkingEnabled, allowance: runtime.reasoningAllowance })
    : undefined
  const configured = runtime.guards.maxOutputTokens
  if (derived === undefined) return configured
  return configured === undefined ? derived : Math.min(derived, configured)
}

function successfulToolCall(
  toolCalls: OnlineToolCall[],
  toolName: string,
): OnlineToolCall | undefined {
  return [...toolCalls].reverse().find((call) => (
    call.toolName === toolName && booleanToolResultField(call.result, 'ok') === true
  ))
}

function maintenanceHandoff(collector: AnalysisCollector, passageResult?: unknown): string {
  const result = passageResult && typeof passageResult === 'object'
    ? passageResult as Record<string, unknown>
    : undefined
  return [
    'The passage report found durable-record work. Review only the cited evidence and supplied numbered records:',
    JSON.stringify({
      summary: collector.summaryUpdate,
      contradictions: collector.contradictions,
      newRecordNames: collector.newRecordNames,
      resolvedFragments: result?.resolvedFragments,
    }),
  ].join('\n')
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

function analyzeLaneStatus(args: {
  collector: AnalysisCollector
  disableDirections: boolean
  disableSuggestions: boolean
  observationComplete: boolean
}): LibrarianAnalyzeLaneStatus {
  return {
    observation: {
      requirement: 'required',
      completion: args.observationComplete ? 'complete' : 'incomplete',
    },
    recordMaintenance: args.disableSuggestions
      ? { requirement: 'disabled', completion: 'disabled' }
      : {
          requirement: 'conditional',
          completion: args.collector.fragmentChangeProposals.length > 0
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
      ...(step.stage ? { stage: step.stage } : {}),
      ...(step.activeTools ? { activeTools: step.activeTools } : {}),
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
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
  const { model, modelId, providerId, config, temperature, topP, topK, providerOptions } = runtime
  const startedAt = new Date().toISOString()
  const startTime = Date.now()
  const sampling = samplingDiagnostics(runtime)
  const requestHeaders = {
    ...config.headers,
    'User-Agent': config.headers['User-Agent'] ?? 'errata-librarian/1.0',
  }
  const completedStageUsages: ToolLoopStepUsage[] = []
  const completedToolCalls: OnlineToolCall[] = []
  const completedToolErrors: Array<{ toolName: string; error: string }> = []
  let completedInputTokens = 0
  let completedOutputTokens = 0
  let lastServedModelId: string | undefined
  let activeStageId: AnalyzeStageId | undefined

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
    const tools = createAnalysisTools(collector, {
      dataDir,
      storyId,
      proseFragmentId: fragment.id,
      disableDirections,
      disableSuggestions,
      numberedFragmentIds,
      registry: continuityRegistry(context),
      customFragmentTypes: story.settings.customFragmentTypes,
      onProgress: (progress) => emit({ type: 'analysis-progress', progress }),
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

    emit({
      type: 'analysis-progress',
      progress: {
        fragmentId: fragment.id,
        stage: 'passage',
        summaryUpdate: '',
        continuityProjection: collector.continuityProjection,
        mentions: [],
        contradictions: [],
        fragmentChangeProposals: [],
        timelineEvents: [],
        directions: [],
      },
    })

    const stages = buildAnalyzeStagePlan(Object.keys(compiled.tools))
    if (stages.length === 0) throw new Error('Analyze has no enabled passage report tool')

    let passageToolOutput: unknown
    let fullText = ''
    let finishReason = 'unknown'
    let stepCount = 0
    const completedStageIds = new Set<string>()
    for (const stage of stages) {
      if (stage.id === 'maintenance' && !needsRecordMaintenance(collector)) {
        completedStageIds.add(stage.id)
        continue
      }
      const relevantFragmentIds = new Set([
        ...collector.mentions.map((mention) => mention.fragmentId),
        ...collector.contradictions.flatMap((contradiction) => contradiction.fragmentIds),
      ])
      const stageTool = compiled.tools[stage.toolName]
      // Answered in the tool's schema where the provider enforces it, so the
      // schema bounds the whole answer; through a tool call elsewhere.
      const structured = runtime.structuredOutput && stageTool !== undefined
      const stageCompiled = await withAnalyzeStagePrompt(
        compiled,
        dataDir,
        storyId,
        stage.id,
        structured ? `${stage.structuredDirective}\n\n${structuredOutputForm(stageTool)}` : stage.directive,
        stage.id === 'maintenance' ? maintenanceHandoff(collector, passageToolOutput) : undefined,
        relevantFragmentIds,
      )
      requestLogger.debug('Calling analyze stage', {
        stage: stage.id,
        toolName: stage.toolName,
      })
      activeStageId = stage.id
      const stageSettings = {
        compiled: stageCompiled,
        model,
        temperature,
        topP,
        topK,
        providerOptions,
        maxOutputTokens: stageOutputCap(stageTool, runtime),
        emit,
        abortSignal,
        idleTimeoutMs: idleTimeoutMs ?? DEFAULT_ANALYZE_IDLE_TIMEOUT_MS,
      }
      const stageResult = structured
        ? await runCompiledStructuredPass({ ...stageSettings, toolName: stage.toolName })
        : await runCompiledToolPass({
            ...stageSettings,
            maxSteps: 1,
            prepareStep: () => ({ activeTools: [stage.toolName], toolChoice: 'required' }),
          })
      const reported = await resolveAndReportServedUsage(
        dataDir,
        storyId,
        'librarian.analyze',
        stageResult.totalUsage,
        { providerId, configuredModelId: modelId, servedModelId: stageResult.servedModelId },
      )
      lastServedModelId = reported.modelId
      // Some providers (and interrupted SDK streams) omit aggregate usage even
      // though each completed step carries it. Preserve those tokens in the
      // pass diagnostics; prefer the provider aggregate when both are present.
      const accountedUsage = reported.usage ?? aggregateCompletedStepUsage(stageResult.stepUsages)
      if (accountedUsage) {
        completedInputTokens += accountedUsage.inputTokens
        completedOutputTokens += accountedUsage.outputTokens
      }
      const stageUsageOffset = completedStageUsages.length
      completedStageUsages.push(...stageResult.stepUsages.map((usage, index) => ({
        ...usage,
        stepNumber: stageUsageOffset + index,
        stage: stage.id,
      })))
      completedToolCalls.push(...stageResult.toolCalls)
      completedToolErrors.push(...stageResult.toolErrors)
      fullText += stageResult.fullText
      finishReason = stageResult.finishReason
      stepCount += stageResult.stepCount

      const expectedCall = successfulToolCall(stageResult.toolCalls, stage.toolName)
      if (stage.id === 'passage') passageToolOutput = expectedCall?.result
      if (!expectedCall) {
        const detail = stageResult.toolErrors.map((item) => item.error).join('; ')
        throw new AnalyzeStageIncompleteError(`${stage.id} stage did not complete ${stage.toolName}${detail ? `: ${detail}` : ''}`)
      }
      completedStageIds.add(stage.id)
      activeStageId = undefined
    }

    const toolCallNames = completedToolCalls.map((call) => call.toolName)
    const workflowComplete = stages.every((stage) => completedStageIds.has(stage.id))
      && (disableDirections || collector.directions.length > 0)
    const proposalToolResults = completedToolCalls
      .filter((call) => call.toolName === MAINTENANCE_REPORT_TOOL)
      .map((call) => call.result)
    const stepUsage = completedStepUsageDiagnostics(completedStageUsages)
    const durationMs = Date.now() - startTime
    const diagnostics = {
      toolNames: Object.keys(compiled.tools),
      toolCallNames,
      toolErrors: completedToolErrors,
      blockIds: compiled.blocks.map((block) => block.id),
      inputTokens: completedInputTokens,
      outputTokens: completedOutputTokens,
      sampling,
      stepUsage,
      reportToolCallCount: toolCallNames.filter((name) => stages.some((stage) => stage.toolName === name)).length,
      proposalToolCallCount: proposalToolResults.length,
      proposalToolFailureCount: proposalToolResults.filter((result) => (
        booleanToolResultField(result, 'ok') === false || numericToolResultField(result, 'invalid') > 0
      )).length,
      proposalQueuedOperationCount: proposalToolResults.reduce<number>((sum, result) => sum + numericToolResultField(result, 'queuedOperationCount'), 0),
      proposalInvalidOperationCount: proposalToolResults.reduce<number>((sum, result) => sum + numericToolResultField(result, 'invalid'), 0),
      workflowComplete,
      attentionCandidateIds: context.attentionCandidateIds,
      initialCandidateFragments: initialCandidates,
      proposalCount: collector.fragmentChangeProposals.length,
      directionCount: collector.directions.length,
    }

    requestLogger.info('LLM online analysis completed', {
      durationMs,
      providerId,
      modelId: lastServedModelId ?? modelId,
      providerName: config.providerName,
      baseURL: config.baseURL,
      headers: Object.keys(requestHeaders),
      finishReason,
      stepCount,
      ...diagnostics,
    })
    return {
      fullText,
      stepCount,
      finishReason,
      toolCalls: completedToolCalls,
      workflowComplete,
      pass: passRecord({
        name: 'analyze',
        status: workflowComplete ? 'complete' : 'failed',
        startedAt,
        durationMs,
        modelId: lastServedModelId ?? modelId,
        stepCount,
        finishReason,
        ...(!workflowComplete ? { error: 'Analyze ended before its required tool work completed' } : {}),
        diagnostics,
      }),
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const failedStageUsages = error instanceof ToolLoopPassError
      ? error.stepUsages.map((usage, index) => ({
          ...usage,
          stepNumber: completedStageUsages.length + index,
          ...(activeStageId ? { stage: activeStageId } : {}),
        }))
      : []
    const stepUsages = [...completedStageUsages, ...failedStageUsages]
    const failedStageUsage = aggregateCompletedStepUsage(failedStageUsages)
    const stepUsage = completedStepUsageDiagnostics(stepUsages)
    const partialServedModelId = [...failedStageUsages].reverse().find((step) => step.servedModelId)?.servedModelId
    let attributedModelId = lastServedModelId ?? modelId
    if (failedStageUsage) {
      const reported = await resolveAndReportServedUsage(
        dataDir,
        storyId,
        'librarian.analyze',
        Promise.resolve(failedStageUsage),
        { providerId, configuredModelId: modelId, servedModelId: partialServedModelId },
      )
      attributedModelId = reported.modelId
    }
    const diagnostics = {
      completedStepCount: stepUsages.length,
      inputTokens: completedInputTokens + (failedStageUsage?.inputTokens ?? 0),
      outputTokens: completedOutputTokens + (failedStageUsage?.outputTokens ?? 0),
      toolCallNames: completedToolCalls.map((call) => call.toolName),
      toolErrors: completedToolErrors,
      sampling,
      stepUsage,
    }
    requestLogger.error('Online analysis failed', { error: errorMessage, ...diagnostics })
    emit({ type: 'error', error: errorMessage })
    return {
      fullText: '',
      toolCalls: completedToolCalls,
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
    if (analyzeOutcome.error instanceof Error && !(analyzeOutcome.error instanceof AnalyzeStageIncompleteError)) {
      throw analyzeOutcome.error
    }
    throw new Error('Analyze ended without completing the passage report')
  }

  const analyzeLanes = analyzeLaneStatus({
    collector,
    disableDirections,
    disableSuggestions,
    observationComplete: observationPresent,
  })
  let completionError: string | undefined
  if (analyzeLanes.directions.completion === 'incomplete') {
    completionError = 'Analyze ended without completing automatic directions required by the story setting'
  } else if (analyzeOutcome.error instanceof Error) {
    completionError = analyzeOutcome.pass.error ?? 'Analyze stopped after completing its passage report'
  } else if (passFailed) {
    completionError = analyzeOutcome.pass.error ?? 'Analyze stopped without successfully finishing'
  }

  const mentionedFragmentIds = [...new Set(collector.mentions.map(m => m.fragmentId))]
  const observationCandidates = observationFragmentCandidates({ mentionedFragmentIds })
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
