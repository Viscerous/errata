import { Elysia, t } from 'elysia'
import { getStory } from '../fragments/storage'
import { invokeAgent } from '../agents/runner'
import { createLogger } from '../logging'
import type { DirectionProposalResult } from '../directions/suggest'
import { runGeneration } from '../generation/run-generation'

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
        saveResult: t.Optional(t.Boolean()),
        mode: t.Optional(t.Union([t.Literal('generate'), t.Literal('regenerate'), t.Literal('refine')])),
        fragmentId: t.Optional(t.String()),
        clarifications: t.Optional(t.Array(t.Object({ question: t.String(), answer: t.String() }))),
        clarifyRound: t.Optional(t.Number()),
      }),
      detail: { summary: 'Generate prose via streaming NDJSON' },
    })
}
