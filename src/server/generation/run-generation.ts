import { ToolLoopAgent, stepCountIs, type ToolSet } from 'ai'
import {
  getStory,
  createFragment,
  getFragment,
  deleteFragment,
} from '../fragments/storage'
import {
  addProseSection,
  addProseVariation,
  findSectionIndex,
} from '../fragments/prose-chain'
import { generateFragmentId } from '@/lib/fragment-ids'
import { buildContextState, createDefaultBlocks, compileBlocks, addCacheBreakpoints, expandMessagesFragmentTags } from '../llm/context-builder'
import { applyBlockConfig } from '../blocks/apply'
import { createScriptHelpers } from '../blocks/script-context'
import { createFragmentTools } from '../llm/tools'
import { resolveAgentRuntime } from '../llm/client'
import { runPrewriter, createWriterBriefBlocks } from '../llm/prewriter'
import {
  saveGenerationLog,
  type GenerationLog,
  type ToolCallLog,
} from '../llm/generation-logs'
import { pluginRegistry } from '../plugins/registry'
import {
  runBeforeContext,
  runBeforeBlocks,
  runBeforeGeneration,
  runAfterGeneration,
  runAfterSave,
} from '../plugins/hooks'
import { collectPluginToolsWithOrigin } from '../plugins/tools'
import { triggerLibrarian } from '../librarian/scheduler'
import { getAgentBlockConfig } from '../agents/agent-block-storage'
import { beginAgentRun } from '../agents/agent-run'
import type { ActivityStreamEvent } from '../agents/activity-stream'
import { resolveAndReportUsage } from '../llm/usage-normalizer'
import { drainAgentStream } from '../agents/drain-agent-stream'
import { createLogger } from '../logging'
import type { Fragment } from '../fragments/schema'

const logger = createLogger('generation')

export interface GenerationInput {
  input: string
  saveResult?: boolean
  mode?: 'generate' | 'regenerate' | 'refine'
  fragmentId?: string
  clarifications?: Array<{ question: string; answer: string }>
  clarifyRound?: number
}

export type RunGenerationResult =
  | { ok: true; eventStream: ReadableStream<Uint8Array> }
  | { ok: false; status: number; error: string }

/**
 * Runs a full prose generation: validates the request, builds context, runs
 * the optional prewriter phase, streams the writer agent, and (when
 * `saveResult`) persists the fragment, triggers the librarian, and saves the
 * generation log. The one place that owns this pipeline — `routes/generation.ts`
 * is transport only: it translates this function's result into an HTTP response.
 *
 * Validation failures are returned as `{ ok: false, status, error }` rather than
 * thrown, so the route can map them to the right HTTP status without this
 * module knowing anything about Elysia.
 */
export async function runGeneration(
  dataDir: string,
  storyId: string,
  body: GenerationInput,
): Promise<RunGenerationResult> {
  const requestLogger = logger.child({ storyId })
  requestLogger.info('Generation request started', { mode: body.mode ?? 'generate', saveResult: body.saveResult ?? false })

  const story = await getStory(dataDir, storyId)
  if (!story) {
    requestLogger.warn('Story not found', { storyId })
    return { ok: false, status: 404, error: 'Story not found' }
  }

  if (!body.input || body.input.trim() === '') {
    requestLogger.warn('Empty input received')
    return { ok: false, status: 422, error: 'Input is required' }
  }

  const mode = body.mode ?? 'generate'
  const librarianConfig = await getAgentBlockConfig(dataDir, storyId, 'librarian.analyze')
  const disableLibrarianAutoAnalysis = (story.settings.disableLibrarianAutoAnalysis ?? false) || (librarianConfig.disableAutoAnalysis ?? false)
  const modeLabel = mode === 'regenerate'
    ? 'Regenerate'
    : mode === 'refine'
      ? 'Refine'
      : 'Continuation'
  const proseFragmentName = `[${modeLabel}] ${body.input.trim()}`.slice(0, 100)

  // Validate fragmentId for regenerate/refine
  let existingFragment: Fragment | null = null
  if (mode === 'regenerate' || mode === 'refine') {
    if (!body.fragmentId) {
      requestLogger.warn('Missing fragmentId for regenerate/refine mode')
      return { ok: false, status: 422, error: 'fragmentId is required for regenerate/refine modes' }
    }
    existingFragment = await getFragment(dataDir, storyId, body.fragmentId)
    if (!existingFragment) {
      requestLogger.warn('Fragment not found', { fragmentId: body.fragmentId })
      return { ok: false, status: 404, error: 'Fragment not found' }
    }
  }

  // Compose prompt based on mode
  let effectiveInput = body.input
  if (mode === 'refine' && existingFragment) {
    effectiveInput = `Here is an existing prose passage (fragment ${existingFragment.id}):\n---\n${existingFragment.content}\n---\nRefine this passage: ${body.input}\nOutput only the rewritten prose.`
  }

  const startTime = Date.now()

  // Get enabled plugins
  const enabledPlugins = pluginRegistry.getEnabled(
    story.settings.enabledPlugins,
  )
  requestLogger.info('Plugins enabled', { pluginCount: enabledPlugins.length, plugins: enabledPlugins.map(p => p.manifest.name) })

  // Build context with plugin hooks
  // When regenerating/refining, exclude the fragment being replaced from context
  requestLogger.info('Building context...')
  const buildContextOpts = (mode === 'regenerate' || mode === 'refine') && existingFragment
    ? {
        excludeFragmentId: existingFragment.id,
        proseBeforeFragmentId: existingFragment.id,
        summaryBeforeFragmentId: existingFragment.id,
      }
    : {}
  let ctxState = await buildContextState(dataDir, storyId, effectiveInput, buildContextOpts)
  const contextFragments = {
    proseCount: ctxState.proseFragments.length,
    stickyGuidelines: ctxState.stickyGuidelines.length,
    stickyKnowledge: ctxState.stickyKnowledge.length,
    stickyCharacters: ctxState.stickyCharacters.length,
    stickyCustomFragments: (ctxState.stickyCustomFragments ?? []).length,
    guidelineCatalog: ctxState.guidelineCatalog.length,
    knowledgeCatalog: ctxState.knowledgeCatalog.length,
    characterCatalog: ctxState.characterCatalog.length,
    customFragmentCatalogs: (ctxState.customFragmentCatalogs ?? [])
      .reduce((sum, group) => sum + group.fragments.length, 0),
  }
  requestLogger.info('Context state built', contextFragments)

  ctxState = await runBeforeContext(enabledPlugins, ctxState)
  requestLogger.info('BeforeContext hooks completed')

  // Resolve model early so modelId is available for instruction resolution
  const { model, modelId: resolvedModelId, temperature, providerOptions, guards } = await resolveAgentRuntime(dataDir, storyId, 'generation.writer', story)
  requestLogger.info('Resolved model', { resolvedModelId })
  ctxState.modelId = resolvedModelId

  // Merge fragment tools + plugin tools, then filter by agent block config
  const fragmentTools = createFragmentTools(dataDir, storyId, { readOnly: true })
  const { tools: pluginTools, origins: pluginToolOrigins } = collectPluginToolsWithOrigin(enabledPlugins, dataDir, storyId)
  // Core fragment tools take precedence: a plugin must not silently shadow
  // readFragments/listFragments/etc. Colliding plugin tools are dropped + logged.
  const allTools: ToolSet = { ...fragmentTools }
  for (const [name, t] of Object.entries(pluginTools)) {
    if (name in allTools) {
      requestLogger.warn('Plugin tool name collides with a core tool; ignoring the plugin tool', { tool: name, plugin: pluginToolOrigins[name] })
      continue
    }
    allTools[name] = t
  }

  const agentConfig = await getAgentBlockConfig(dataDir, storyId, 'generation.writer')
  const disabledTools = new Set(agentConfig.disabledTools ?? [])
  const tools: Record<string, (typeof allTools)[string]> = {}
  for (const [name, t] of Object.entries(allTools)) {
    if (!disabledTools.has(name)) tools[name] = t
  }
  requestLogger.info('Tools prepared', { toolCount: Object.keys(tools).length })

  const scriptContext = { ...ctxState, ...createScriptHelpers(dataDir, storyId) }
  let blocks = createDefaultBlocks(ctxState)
  blocks = await applyBlockConfig(blocks, agentConfig, scriptContext)
  blocks = await runBeforeBlocks(enabledPlugins, blocks)

  // In prewriter mode, strip writer-only blocks from the context that gets
  // dumped into the prewriter's full-context block. The prewriter has its own
  // planning-request for author direction and its own custom blocks — writer
  // custom blocks and author-input would leak through and bypass the
  // prewriter's block config.
  const isPrewriterMode = story.settings.generationMode === 'prewriter'
  // Clarify-before-generate only applies in prewriter mode.
  const clarifyEnabled = isPrewriterMode && (story.settings.clarifyBeforeGenerate ?? false)
  const clarifications = body.clarifications ?? []
  const clarifyRound = body.clarifyRound ?? 0
  if (isPrewriterMode) {
    // Strip writer-only blocks from the context dumped into the prewriter's
    // full-context: the author direction (it has its own planning-request),
    // custom blocks, and the writer's operating instructions/tool guidance
    // ("write prose directly, don't use tools to save") — which would
    // otherwise confuse the planner, whose job is the opposite.
    const WRITER_ONLY_BLOCKS = new Set(['author-input', 'instructions', 'tools'])
    blocks = blocks.filter(b => !WRITER_ONLY_BLOCKS.has(b.id) && b.source !== 'custom')
  }

  let messages = compileBlocks(blocks)
  messages = await runBeforeGeneration(enabledPlugins, messages)
  // Expand inline `<@fragment-id>` references so they don't leak literally
  // into the prompt. The prewriter writer path expands its own context
  // separately (createWriterBriefBlocks + expandMessagesFragmentTags).
  messages = await expandMessagesFragmentTags(messages, dataDir, storyId)
  requestLogger.info('BeforeGeneration hooks completed', { messageCount: messages.length })

  // Prewriter phase: if enabled, run prewriter and replace messages with stripped context
  let prewriterBrief: string | undefined
  let prewriterReasoning: string | undefined
  let prewriterDurationMs: number | undefined
  let prewriterModel: string | undefined
  let prewriterUsage: { inputTokens: number; outputTokens: number } | undefined
  let prewriterLogMessages: Array<{ role: string; content: string }> | undefined
  let prewriterDirections: Array<{ pacing: string; title: string; description: string; instruction: string }> | undefined
  let prewriterToolCalls: ToolCallLog[] = []
  let logMessages = messages // messages saved to generation log — updated to writer context in prewriter mode

  const modelMessages = addCacheBreakpoints(messages)

  requestLogger.info('Starting LLM stream...')
  const abortController = new AbortController()

  let fullText = ''
  let fullReasoning = ''
  const toolCalls: ToolCallLog[] = []
  let lastFinishReason = 'unknown'
  let stepCount = 0
  // Set with the error message when the stream throws for a reason other than
  // client abort, so the save path skips persisting a failed generation.
  let runError: string | null = null

  const writerRun = beginAgentRun(storyId, 'generation.writer')

  const eventStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const emit = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
      }
      let totalUsagePromise: PromiseLike<unknown> | undefined
      try {
        // Run prewriter inside the stream so events are streamed live
        let writerMessages = modelMessages
        let prewriterStepCount = 0
        if (isPrewriterMode) {
          emit({ type: 'phase', phase: 'prewriting' })

          const prewriterRun = beginAgentRun(storyId, 'generation.prewriter')
          let prewriterOk = false
          try {
            const configuredMax = story.settings.maxSteps ?? 10
            const prewriterReasoningLevel = story.settings.prewriterReasoning ?? 'normal'
            // Scale the prewriter's tool-step budget by reasoning length so
            // 'short' actually runs fewer round trips (the main speed win),
            // while 'extensive' may explore the full budget.
            const half = Math.max(1, Math.floor(configuredMax / 2))
            const prewriterMaxSteps = prewriterReasoningLevel === 'short'
              ? Math.min(2, half)
              : prewriterReasoningLevel === 'extensive'
                ? configuredMax
                : half
            const prewriterResult = await runPrewriter({
              dataDir,
              storyId,
              story,
              compiledMessages: messages,
              blockContext: { ...ctxState, systemPromptFragments: [] },
              authorInput: effectiveInput,
              mode,
              tools: allTools,
              maxSteps: prewriterMaxSteps,
              abortSignal: abortController.signal,
              clarifyEnabled,
              clarifications,
              round: clarifyRound,
              reasoning: prewriterReasoningLevel,
              onEvent: (event) => {
                if (event.type === 'reasoning' || event.type === 'text' || event.type === 'tool-call' || event.type === 'tool-result') {
                  prewriterRun.pushEvent(event)
                }
                if (event.type === 'text') {
                  emit({ type: 'prewriter-text', text: event.text })
                } else if (event.type === 'reset') {
                  // The prewriter re-wrote the brief in a new step; tell the
                  // client to discard the brief streamed so far.
                  emit({ type: 'prewriter-reset' })
                } else if (event.type === 'questions') {
                  // Canonical clarify-questions is emitted from the result below.
                } else {
                  emit(event)
                }
              },
            })
            prewriterOk = true

            // The prewriter chose to ask the author questions instead of
            // finalizing a brief. Surface them and end the turn — no writer,
            // no save. The client answers and re-POSTs with clarifications.
            if (prewriterResult.questions && prewriterResult.questions.length > 0) {
              // Inner finally below unregisters the prewriter activity; outer
              // finally unregisters the generation activity. Returning here
              // skips the writer and the save block entirely.
              emit({ type: 'clarify-questions', questions: prewriterResult.questions, round: clarifyRound })
              emit({ type: 'finish', finishReason: 'clarify', stepCount: prewriterResult.stepCount, stopped: true })
              controller.close()
              return
            }
            prewriterBrief = prewriterResult.brief
            prewriterReasoning = prewriterResult.reasoning || undefined
            prewriterDurationMs = prewriterResult.durationMs
            prewriterModel = prewriterResult.model
            prewriterUsage = prewriterResult.usage
            prewriterLogMessages = prewriterResult.messages
            prewriterToolCalls = prewriterResult.toolCalls
            prewriterStepCount = prewriterResult.stepCount
            if (prewriterResult.directions.length > 0) {
              prewriterDirections = prewriterResult.directions
              emit({ type: 'prewriter-directions', directions: prewriterDirections })
            }
            requestLogger.info('Prewriter completed', { briefLength: prewriterBrief.length, durationMs: prewriterDurationMs, stepCount: prewriterStepCount, directionsCount: prewriterDirections?.length ?? 0 })

            // Build stripped writer context with only prose + brief + custom blocks,
            // then apply the writer's agent block config so overrides (e.g. disabled
            // blocks like writing-brief) are respected.
            //
            // If the prewriter produced no usable brief, the stripped context
            // would leave the writer with prose but NO characters/guidelines/
            // knowledge AND no brief — strictly worse than the full context.
            // Fall back to the full context (writerMessages already === modelMessages).
            if (prewriterResult.brief.trim()) {
              const writerBlocks = createWriterBriefBlocks(ctxState.proseFragments, prewriterResult.brief, resolvedModelId)
              let finalWriterBlocks = await applyBlockConfig(writerBlocks, agentConfig, scriptContext)
              finalWriterBlocks = await runBeforeBlocks(enabledPlugins, finalWriterBlocks)
              let writerCompiled = compileBlocks(finalWriterBlocks)
              writerCompiled = await expandMessagesFragmentTags(writerCompiled, dataDir, storyId)
              writerCompiled = await runBeforeGeneration(enabledPlugins, writerCompiled)
              writerMessages = addCacheBreakpoints(writerCompiled)
              logMessages = writerCompiled
            } else {
              requestLogger.warn('Prewriter produced an empty brief; falling back to full context for the writer')
            }
          } finally {
            prewriterRun.finish(prewriterOk ? 'success' : 'error', prewriterOk ? { output: { stepCount: prewriterStepCount } } : undefined)
          }

          emit({ type: 'phase', phase: 'writing' })
        }

        const configuredMaxSteps = story.settings.maxSteps ?? 10
        const writerMaxSteps = isPrewriterMode
          ? Math.max(1, configuredMaxSteps - prewriterStepCount)
          : configuredMaxSteps
        const writerAgent = new ToolLoopAgent({
          model,
          tools,
          toolChoice: 'auto',
          stopWhen: stepCountIs(writerMaxSteps),
          temperature,
          providerOptions,
          maxOutputTokens: guards.maxOutputTokens,
        })
        const result = await writerAgent.stream({
          messages: writerMessages,
          abortSignal: abortController.signal,
        })
        totalUsagePromise = result.totalUsage

        const drained = await drainAgentStream(result.fullStream, (event) => {
          emit(event)
          writerRun.pushEvent(event as ActivityStreamEvent)
        })
        fullText = drained.fullText
        fullReasoning = drained.fullReasoning
        toolCalls.push(...drained.toolCalls)
        stepCount = drained.stepCount
        lastFinishReason = drained.finishReason

        // Emit a final finish event
        const finishEvent = { type: 'finish' as const, finishReason: lastFinishReason, stepCount }
        emit(finishEvent)
        writerRun.pushEvent(finishEvent)
      } catch (err) {
        const wasAborted = abortController.signal.aborted
        if (wasAborted) {
          requestLogger.info('Generation aborted by client', { textLength: fullText.length })
          lastFinishReason = 'stop'
          try {
            emit({
              type: 'finish',
              finishReason: 'stop',
              stepCount,
              stopped: true,
            })
          } catch {
            // Controller may already be closed
          }
        } else {
          // Non-abort failure (provider/network/parse error). The client's
          // stream is errored; do NOT persist a fragment from a failed run.
          runError = err instanceof Error ? err.message : String(err)
          requestLogger.error('Generation stream failed', { error: runError, textLength: fullText.length })
          controller.error(err)
        }
      } finally {
        writerRun.finish(
          runError ? 'error' : 'success',
          runError ? { error: runError } : { output: { finishReason: lastFinishReason, stepCount } },
        )
      }

      // Save only when the generation actually produced text and didn't fail.
      // (Aborted-with-partial-text still saves what was generated.)
      if (body.saveResult && !runError && fullText.trim()) {
        try {
          const durationMs = Date.now() - startTime
          requestLogger.info('LLM generation completed', { durationMs, textLength: fullText.length })

          requestLogger.info('Tool calls extracted', { toolCallCount: toolCalls.length })

          // Run afterGeneration hooks
          const genResult = await runAfterGeneration(enabledPlugins, {
            text: fullText,
            fragmentId: (mode === 'regenerate' || mode === 'refine') ? body.fragmentId! : null,
            toolCalls,
          })
          requestLogger.info('AfterGeneration hooks completed')

          const now = new Date().toISOString()
          let savedFragmentId: string

          // Forward the writer's character/knowledge working set to the
          // librarian via the prose meta — its full-context cast plus anything
          // it looked up — so analyze audits against the same sheets the writer
          // had.
          const fragmentLookupIds = (calls: ToolCallLog[]) => calls.flatMap((tc) => {
            if (tc.toolName !== 'readFragments') return []
            const ids = (tc.args as Record<string, unknown>)?.fragmentIds
            return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
          })
          const lookedUpIds = [
            ...fragmentLookupIds(toolCalls),
            ...fragmentLookupIds(prewriterToolCalls),
          ]
          const writerContextIds = [...new Set([
            ...ctxState.stickyCharacters.map((f) => f.id),
            ...(ctxState.recentCharacters ?? []).map((f) => f.id),
            ...ctxState.stickyKnowledge.map((f) => f.id),
            ...(ctxState.recentKnowledge ?? []).map((f) => f.id),
            ...(ctxState.stickyCustomFragments ?? []).map((f) => f.id),
            ...(ctxState.recentCustomFragments ?? []).flatMap((group) => group.fragments.map((f) => f.id)),
            ...lookedUpIds,
          ])]

          const isRegenOrRefine = (mode === 'regenerate' || mode === 'refine') && existingFragment
          const id = generateFragmentId('prose')

          const fragment: Fragment = {
            id,
            type: 'prose',
            name: proseFragmentName,
            description: body.input.slice(0, 250),
            content: genResult.text,
            tags: isRegenOrRefine ? [...existingFragment!.tags] : [],
            refs: isRegenOrRefine ? [...existingFragment!.refs] : [],
            sticky: isRegenOrRefine ? existingFragment!.sticky : false,
            placement: isRegenOrRefine ? (existingFragment!.placement ?? 'user') : 'user',
            createdAt: now,
            updatedAt: now,
            order: isRegenOrRefine ? existingFragment!.order : 0,
            meta: {
              ...(isRegenOrRefine ? existingFragment!.meta : {}),
              generatedFrom: body.input,
              ...(isRegenOrRefine ? {
                generationMode: mode,
                previousFragmentId: existingFragment!.id,
                variationOf: existingFragment!.id,
              } : {}),
              ...(writerContextIds.length ? { writerContextIds } : {}),
            },
            version: 1,
            versions: [],
          }

          await createFragment(dataDir, storyId, fragment)
          savedFragmentId = id
          requestLogger.info(isRegenOrRefine ? 'Fragment variation created' : 'New fragment created', {
            fragmentId: savedFragmentId,
            mode,
            originalId: existingFragment?.id,
          })

          // Add to prose chain
          try {
            if (isRegenOrRefine) {
              const sectionIndex = await findSectionIndex(dataDir, storyId, existingFragment!.id)
              if (sectionIndex !== -1) {
                await addProseVariation(dataDir, storyId, sectionIndex, id)
                requestLogger.info('Added as variation to prose chain', { sectionIndex })
              } else {
                requestLogger.warn('Original fragment not found in prose chain, creating new section')
                await addProseSection(dataDir, storyId, id)
              }
            } else {
              await addProseSection(dataDir, storyId, id)
              requestLogger.info('Added as new section to prose chain')
            }
          } catch (chainErr) {
            await deleteFragment(dataDir, storyId, id).catch(() => {})
            throw chainErr
          }

          // Run afterSave hooks
          await runAfterSave(enabledPlugins, fragment, storyId)
          requestLogger.info('AfterSave hooks completed')

          if (!disableLibrarianAutoAnalysis) {
            triggerLibrarian(dataDir, storyId, fragment).catch((err) => {
              requestLogger.error('triggerLibrarian failed', { error: err instanceof Error ? err.message : String(err) })
            })
            requestLogger.info('Librarian analysis triggered')
          } else {
            requestLogger.info('Librarian auto analysis disabled; skipping trigger')
          }

          // Capture finish reason, step count, and token usage
          const finishReason = lastFinishReason
          const configuredMaxStepsForLog = story.settings.maxSteps ?? 10
          const stepsExceeded = stepCount >= configuredMaxStepsForLog && finishReason !== 'stop'
          const totalUsage = await resolveAndReportUsage(
            dataDir, storyId, 'generation.writer',
            totalUsagePromise ?? Promise.resolve(undefined), resolvedModelId,
          )

          // Persist generation log
          const logId = `gen-${Date.now().toString(36)}`
          const log: GenerationLog = {
            id: logId,
            createdAt: now,
            input: body.input,
            messages: logMessages.map((m) => ({
              role: String(m.role),
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
            toolCalls,
            generatedText: genResult.text,
            fragmentId: savedFragmentId,
            model: resolvedModelId,
            durationMs,
            stepCount,
            finishReason: String(finishReason),
            stepsExceeded,
            ...(totalUsage ? { totalUsage } : {}),
            ...(fullReasoning ? { reasoning: fullReasoning } : {}),
            ...(prewriterBrief ? { prewriterBrief } : {}),
            ...(prewriterReasoning ? { prewriterReasoning } : {}),
            ...(prewriterLogMessages ? { prewriterMessages: prewriterLogMessages } : {}),
            ...(prewriterDurationMs ? { prewriterDurationMs } : {}),
            ...(prewriterModel ? { prewriterModel } : {}),
            ...(prewriterUsage ? { prewriterUsage } : {}),
            ...(prewriterToolCalls.length ? { prewriterToolCalls } : {}),
            ...(prewriterDirections?.length ? { prewriterDirections } : {}),
          }
          await saveGenerationLog(dataDir, storyId, log)
          requestLogger.info('Generation log saved', { logId, stepCount, finishReason, stepsExceeded })
        } catch (err) {
          requestLogger.error('Error saving generation result', { error: err instanceof Error ? err.message : String(err) })
        }
      }

      // Close the stream controller after saving completes (or abort concludes)
      if (!runError) {
        try {
          controller.close()
        } catch {
          // Ignore if already closed or errored
        }
      }
    },
    cancel() {
      abortController.abort()
    },
  })

  return { ok: true, eventStream }
}
