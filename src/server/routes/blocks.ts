import { Elysia } from 'elysia'
import { getStory } from '../fragments/storage'
import { buildContextState } from '../llm/context-builder'
import { createScriptHelpers } from '../blocks/script-context'
import { ensureCoreAgentsRegistered } from '../agents/register-core'
import { agentBlockRegistry } from '../agents/agent-block-registry'
import { getAgentBlockConfig, saveAgentBlockConfig, type AgentBlockConfig } from '../agents/agent-block-storage'
import { ImportConfigsPayloadSchema } from '@/contracts/block-config'

/**
 * Block-related routes that are NOT scoped to a specific agent.
 *
 * Historical note: this module used to host the legacy generation-wide
 * block config (`GET /blocks`, `PATCH /blocks/config`, `POST/PUT/DELETE
 * /blocks/custom`, `GET /blocks/preview`). Those endpoints were deleted
 * when per-agent block configuration via `/agent-blocks/:agentName` became
 * the single source of truth for generation-writer blocks. The routes
 * that remain here are shared utilities:
 *
 *   - POST /blocks/eval-script — used by the script-block editor to
 *     evaluate a snippet against the current context
 *   - GET  /export-configs    — bundles every agent's block config
 *   - POST /import-configs    — restores agent block configs from a bundle
 */
export function blockRoutes(dataDir: string) {
  return new Elysia({ detail: { tags: ['Blocks'] } })
    .post('/stories/:storyId/blocks/eval-script', async ({ params, body, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }
      const { content } = body as { content?: string }
      if (typeof content !== 'string') {
        set.status = 422
        return { error: 'Missing content field' }
      }
      const ctxState = await buildContextState(dataDir, params.storyId, '(preview)')
      const scriptContext = {
        ...ctxState,
        ...createScriptHelpers(dataDir, params.storyId),
      }
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      try {
        const fn = new AsyncFunction('ctx', content)
        const result = await fn(scriptContext)
        if (typeof result !== 'string' || result.trim() === '') {
          return { result: null, error: null }
        }
        return { result, error: null }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { result: null, error: msg }
      }
    }, { detail: { summary: 'Evaluate a script in block context' } })

    .get('/stories/:storyId/export-configs', async ({ params, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      ensureCoreAgentsRegistered()
      const agentDefs = agentBlockRegistry.list()
      const agentBlockConfigs: Record<string, AgentBlockConfig> = {}
      for (const def of agentDefs) {
        const cfg = await getAgentBlockConfig(dataDir, params.storyId, def.agentName)
        const isEmpty =
          cfg.customBlocks.length === 0 &&
          Object.keys(cfg.overrides).length === 0 &&
          cfg.blockOrder.length === 0 &&
          cfg.disabledTools.length === 0
        if (!isEmpty) {
          agentBlockConfigs[def.agentName] = cfg
        }
      }

      return Object.keys(agentBlockConfigs).length > 0 ? { agentBlockConfigs } : {}
    }, { detail: { summary: 'Export every agent\'s block config' } })

    .post('/stories/:storyId/import-configs', async ({ params, body, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const parsed = ImportConfigsPayloadSchema.safeParse(body)
      if (!parsed.success) {
        set.status = 422
        return { error: 'Invalid block configuration bundle', issues: parsed.error.issues }
      }

      // Legacy blockConfig is accepted for archive compatibility, but there is
      // no generation-wide destination after the per-agent migration.
      const { agentBlockConfigs } = parsed.data

      if (agentBlockConfigs) {
        for (const [agentName, cfg] of Object.entries(agentBlockConfigs)) {
          await saveAgentBlockConfig(dataDir, params.storyId, agentName, cfg)
        }
      }

      return { ok: true }
    }, { detail: { summary: 'Import agent block configs' } })
}
