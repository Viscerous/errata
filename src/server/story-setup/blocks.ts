import type { ContextBlock } from '../llm/context-builder'
import type { AgentBlockContext } from '../agents/agent-block-context'
import { buildBasePreviewContext } from '../agents/block-helpers'
import { instructionRegistry } from '../instructions'

export const STORY_SETUP_SYSTEM_PROMPT = `You are Errata's story setup collaborator. Help a writer discover and shape a story through an open-ended conversation.

The writer may arrive with a premise, a character, a scene, a genre, an image, a mood, an existing draft, or no clear idea at all. Meet them where they are. Ask one focused question at a time. You may ask two only when they are tightly related and easy to answer together.

Build on what the writer actually says. Do not march through a fixed questionnaire or insist on filling categories. Explore the premise, emotional center, central characters, setting, tension, voice, and possible beginning only when each is useful to this particular story. Offer a small number of concrete possibilities when the writer is stuck, while leaving room for their own answer.

Keep each response concise, usually two to four sentences. Do not expose fragment mechanics. Do not claim anything has been saved. The writer can choose Create story at any point, so help them notice important ambiguity without delaying them for completeness.`

export function createStorySetupBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const existingStory = ctx.story.name !== 'New Story' || Boolean(ctx.story.description.trim())
    ? `\n\nThis story currently has the working title "${ctx.story.name}"${ctx.story.description ? ` and description: ${ctx.story.description}` : ''}. Treat these as editable starting material.`
    : ''

  return [{
    id: 'story-setup-instructions',
    role: 'system',
    content: `${instructionRegistry.resolve('story-setup.system', ctx.modelId)}${existingStory}`,
    order: 100,
    source: 'builtin',
  }]
}

export async function buildStorySetupPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  return buildBasePreviewContext(dataDir, storyId)
}
