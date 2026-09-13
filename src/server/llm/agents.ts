import { agentBlockRegistry } from '../agents/agent-block-registry'
import { instructionRegistry } from '../instructions'
import { getStory } from '../fragments/storage'
import type { AgentBlockContext } from '../agents/agent-block-context'
import { createDefaultBlocks, buildContextState, type ContextBlock } from './context-builder'
import { coreReadToolNames, createFragmentTools } from './tools'
import { createPrewriterBlocks, buildPrewriterPreviewContext, createWriterBriefBlocks, PREWRITER_INSTRUCTIONS } from './prewriter'
import {
  GENERATION_SYSTEM_PROMPT,
  WRITER_BRIEF_SYSTEM_PROMPT,
  PLAY_CONTINUATION_SYSTEM_PROMPT,
} from './instruction-texts'

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function pluralize(name: string): string {
  const massNouns = ['prose', 'knowledge']
  return massNouns.includes(name.toLowerCase()) ? name : name + 's'
}

function getAvailableTools(): string[] {
  return coreReadToolNames()
}

function createGenerationBlocks(ctx: AgentBlockContext): ContextBlock[] {
  if (ctx.story.settings.generationMode === 'prewriter') {
    const placeholderBrief = '(The prewriter will generate a brief at generation time.)'
    return createWriterBriefBlocks(
      ctx.proseFragments,
      placeholderBrief,
      ctx.authorInputMode === 'play' ? ctx.authorInput : undefined,
    )
  }
  // The context is already a ContextBuildState (AgentBlockContext extends it), so
  // render it directly — no reconstruction, nothing to drop.
  return createDefaultBlocks(ctx)
}

async function buildGenerationPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const story = await getStory(dataDir, storyId)
  const inputMode = story?.settings.authorInputMode ?? 'direct'
  const placeholder = inputMode === 'play'
    ? '(your protagonist move will appear here)'
    : '(your direction for the next passage will appear here)'
  const state = await buildContextState(dataDir, storyId, placeholder, { authorInputMode: inputMode })
  return { ...state, systemPromptFragments: [] }
}

let registered = false

export function registerGenerationBlocks(): void {
  if (registered) return

  // Register instruction defaults
  instructionRegistry.registerDefault('generation.system', GENERATION_SYSTEM_PROMPT, { usedBy: 'generation.writer', kind: 'system' })
  instructionRegistry.registerDefault('generation.writer-brief.system', WRITER_BRIEF_SYSTEM_PROMPT, { usedBy: 'generation.writer', kind: 'system' })
  instructionRegistry.registerDefault('generation.play-continuation', PLAY_CONTINUATION_SYSTEM_PROMPT, { usedBy: 'generation.writer', kind: 'contract' })
  instructionRegistry.registerDefault('generation.prewriter.system', PREWRITER_INSTRUCTIONS, { usedBy: 'generation.prewriter', kind: 'system' })

  agentBlockRegistry.register({
    agentName: 'generation.writer',
    displayName: 'Writer',
    description: 'Prose continuation and generation.',
    availableTools: getAvailableTools(),
    resolveTools: ({ dataDir, storyId }) => createFragmentTools(dataDir, storyId, { readOnly: true }),
    createDefaultBlocks: createGenerationBlocks,
    buildPreviewContext: buildGenerationPreviewContext,
  })

  agentBlockRegistry.register({
    agentName: 'generation.prewriter',
    displayName: 'Prewriter',
    description: 'Creates a focused writing brief from full story context.',
    availableTools: getAvailableTools(),
    resolveTools: ({ dataDir, storyId }) => createFragmentTools(dataDir, storyId, { readOnly: true }),
    createDefaultBlocks: createPrewriterBlocks,
    buildPreviewContext: buildPrewriterPreviewContext,
  })

  registered = true
}

/** Auto-discovery entry point */
export const register = registerGenerationBlocks
