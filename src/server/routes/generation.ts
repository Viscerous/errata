import { Elysia, t } from 'elysia'
import { getStory } from '../fragments/storage'
import { invokeAgent } from '../agents/runner'
import { createLogger } from '../logging'
import type { DirectionProposalResult } from '../directions/suggest'
import { runGeneration } from '../generation/run-generation'
import { compileGenerationWriterContext } from '../llm/compile-generation-writer-context'
import { getModel } from '../llm/client'
import { getProvider } from '../config/storage'
import { advertisedModelContextWindow } from '../config/model-capabilities'
import { pluginRegistry } from '../plugins/registry'
import { describeToolSurface } from '../llm/tool-surface'

export function generationRoutes(dataDir: string) {
  const logger = createLogger('api:generation', { dataDir })

  return new Elysia({ detail: { tags: ['Generation'] } })
    .post('/stories/:storyId/propose-directions', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Propose directions request')

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      try {
        const { output } = await invokeAgent<DirectionProposalResult>({
          dataDir,
          storyId: params.storyId,
          agentName: 'directions.suggest',
          input: { count: body.count },
        })
        return { suggestions: output.suggestions }
      } catch (err) {
        requestLogger.error('Propose directions failed', { error: err instanceof Error ? err.message : String(err) })
        set.status = 502
        return { error: err instanceof Error ? err.message : 'Failed to generate suggestions' }
      }
    }, {
      body: t.Object({
        count: t.Optional(t.Number()),
      }),
      detail: { summary: 'Get AI-generated story direction suggestions' },
    })
    .post('/stories/:storyId/generation-context-preview', async ({ params, body, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const inputMode = body.inputMode ?? story.settings.authorInputMode ?? 'direct'
      const enabledPlugins = pluginRegistry.getEnabled(story.settings.enabledPlugins)
      let modelId: string | undefined
      let contextWindowPromise: Promise<number | undefined> = Promise.resolve(undefined)
      try {
        const resolved = await getModel(dataDir, params.storyId, { role: 'generation.writer' })
        modelId = resolved.modelId || undefined
        if (resolved.providerId && modelId) {
          const provider = await getProvider(dataDir, resolved.providerId)
          if (provider) {
            contextWindowPromise = advertisedModelContextWindow(provider, modelId, { timeoutMs: 1_500 })
              .catch(() => undefined)
          }
        }
      } catch {
        // Context remains previewable before the author configures a provider.
      }
      const compiled = await compileGenerationWriterContext({
        dataDir,
        storyId: params.storyId,
        authorInput: body.input,
        enabledPlugins,
        contextOptions: { authorInputMode: inputMode },
        modelId,
      })
      const messages = compiled.messages.map(message => ({ role: message.role, content: message.content }))
      const messageCharacters = messages.reduce((sum, message) => sum + message.content.length, 0)
      const tools = await Promise.all(
        Object.entries(compiled.tools).map(([name, tool]) => describeToolSurface(name, tool)),
      )
      const toolCharacters = tools.reduce((sum, tool) => sum + tool.characters, 0)
      const estimatedCharacters = messageCharacters + toolCharacters
      const contextWindowTokens = await contextWindowPromise

      return {
        inputMode,
        pipeline: story.settings.generationMode ?? 'standard',
        modelId,
        contextWindowTokens,
        estimatedCharacters,
        estimatedTokens: Math.ceil(estimatedCharacters / 4),
        messageCharacters,
        toolCharacters,
        blocks: compiled.blocks
          .slice()
          .sort((left, right) => left.role === right.role
            ? left.order - right.order
            : left.role === 'system' ? -1 : 1)
          .map(block => ({
            id: block.id,
            name: block.name ?? block.id,
            role: block.role,
            source: block.source,
            content: block.content,
            characters: block.content.length,
            estimatedTokens: Math.ceil(block.content.length / 4),
          })),
        messages,
        tools,
        caveat: story.settings.generationMode === 'prewriter'
          ? 'This is the source context assembled before the prewriter creates its brief. The final writer will receive recent prose, that brief, and any canonical Play turn.'
          : null,
      }
    }, {
      body: t.Object({
        input: t.String(),
        inputMode: t.Optional(t.Union([t.Literal('direct'), t.Literal('play')])),
      }),
      detail: { summary: 'Preview the next prose generation context' },
    })
    .post('/stories/:storyId/generate', async ({ params, body, set }) => {
      const result = await runGeneration(dataDir, params.storyId, body)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }

      logger.child({ storyId: params.storyId }).info('Streaming NDJSON response', { saveResult: body.saveResult ?? false })
      return new Response(result.eventStream, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }, {
      body: t.Object({
        input: t.String(),
        inputMode: t.Optional(t.Union([t.Literal('direct'), t.Literal('play')])),
        runId: t.Optional(t.String()),
        branchId: t.Optional(t.String()),
        saveResult: t.Optional(t.Boolean()),
        mode: t.Optional(t.Union([t.Literal('generate'), t.Literal('regenerate'), t.Literal('refine')])),
        fragmentId: t.Optional(t.String()),
        clarifications: t.Optional(t.Array(t.Object({ question: t.String(), answer: t.String() }))),
        clarifyRound: t.Optional(t.Number()),
      }),
      detail: { summary: 'Generate prose via streaming NDJSON' },
    })
}
