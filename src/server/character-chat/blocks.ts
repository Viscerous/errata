import type { ContextBlock } from '../llm/context-builder'
import {
  fragmentFullContextBlock,
  markdownSection,
  renderFullFragmentSheet,
} from '../llm/fragment-context-blocks'
import type { AgentBlockContext } from '../agents/agent-block-context'
import { instructionRegistry } from '../instructions'
import { buildBasePreviewContext } from '../agents/block-helpers'
import { renderContinuity } from '../librarian/continuity-view'

export const CHARACTER_CHAT_SYSTEM_PROMPT = `Roleplay the character supplied under "Character". Respond in their voice and manner, using only their character sheet and explicit character-awareness context as memory. When asked about anything they have not learned, answer with genuine uncertainty. Stay natural and in character; break the fourth wall only if the character would.`

export function createCharacterChatBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []

  blocks.push({
    id: 'instructions',
    role: 'system',
    content: instructionRegistry.resolve('character-chat.system', ctx.modelId),
    order: 100,
    source: 'builtin',
  })

  if (ctx.character) {
    const characterBlock = fragmentFullContextBlock({
      id: 'character',
      heading: 'Character',
      sections: [{
        type: 'character',
        label: 'Character',
        fragments: [ctx.character],
      }],
      scope: 'all',
      order: 100,
      intro: 'This is the full character sheet for the person you are roleplaying.',
      renderFragment: renderFullFragmentSheet,
    })
    if (characterBlock) blocks.push(characterBlock)
  }

  if (ctx.personaDescription) {
    blocks.push({
      id: 'persona',
      role: 'user',
      content: markdownSection(2, 'Who You Are Speaking With', ctx.personaDescription),
      order: 200,
      source: 'builtin',
    })
  }

  // No global story summary, prose catalog, or fragment tools are routed here:
  // the selected cutoff and folded self-knowledge are an access boundary, not
  // merely an instruction to ignore authorial facts already in the prompt.
  const awareness = renderContinuity(ctx, 'character-chat.chat')
  if (awareness) {
    blocks.push({
      id: 'character-awareness',
      role: 'user',
      content: awareness,
      order: 300,
      source: 'builtin',
    })
  }

  return blocks
}

export async function buildCharacterChatPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  // A real character, not a blank: half this context — the sheet, the awareness
  // boundary, which sheets the catalog then omits — only exists once one is
  // chosen, and a preview that hides those blocks hides what the author came to
  // inspect. Stories with no characters still preview, minus those blocks.
  const character = base.stickyCharacters[0] ?? base.characterCatalog[0]
  return {
    ...base,
    character,
    personaDescription: 'You are speaking with a stranger you have just met. You do not know who they are.',
  }
}
