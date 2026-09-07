import { z } from 'zod/v4'
import { agentRegistry } from '../agents/registry'
import { agentBlockRegistry } from '../agents/agent-block-registry'
import { modelRoleRegistry } from '../agents/model-role-registry'
import { instructionRegistry } from '../instructions'
import type { AgentDefinition } from '../agents/types'
import { summarizeChapter, CHAPTER_SUMMARIZE_SYSTEM_PROMPT } from './summarize'
import { instructionsBlock, buildBasePreviewContext } from '../agents/block-helpers'

const SummarizeInputSchema = z.object({
  fragmentId: z.string(),
})

declare module '../agents/agent-instance' {
  interface AgentInputMap {
    'chapters.summarize': z.infer<typeof SummarizeInputSchema>
  }
}

const summarizeDefinition: AgentDefinition<typeof SummarizeInputSchema> = {
  name: 'chapters.summarize',
  description: 'Summarize a chapter by collecting prose from marker to next marker and generating a summary.',
  inputSchema: SummarizeInputSchema,
  run: async (ctx, input) => {
    return summarizeChapter(ctx.dataDir, ctx.storyId, input, { abortSignal: ctx.abortSignal })
  },
}

let registered = false

export function registerChapterAgents(): void {
  if (registered) return
  instructionRegistry.registerDefault('chapters.summarize.system', CHAPTER_SUMMARIZE_SYSTEM_PROMPT, { usedBy: 'chapters.summarize', kind: 'system' })
  agentRegistry.register(summarizeDefinition)
  modelRoleRegistry.register({
    key: 'chapters',
    label: 'Chapters',
    description: 'Chapter summaries',
    fallback: 'librarian',
  })
  agentBlockRegistry.register({
    agentName: 'chapters.summarize',
    displayName: 'Chapter Summarizer',
    description: 'Summarizes the prose between chapter markers.',
    createDefaultBlocks: ctx => [instructionsBlock('chapters.summarize.system', ctx)],
    availableTools: [],
    buildPreviewContext: buildBasePreviewContext,
  })
  registered = true
}

/** Auto-discovery entry point */
export const register = registerChapterAgents
