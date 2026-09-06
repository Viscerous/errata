import { z } from 'zod/v4'
import { agentRegistry } from '../agents/registry'
import { agentBlockRegistry } from '../agents/agent-block-registry'
import { modelRoleRegistry } from '../agents/model-role-registry'
import { instructionRegistry } from '../instructions'
import type { AgentDefinition } from '../agents/types'
import { characterChat } from './chat'
import { CHARACTER_CHAT_SYSTEM_PROMPT, createCharacterChatBlocks, buildCharacterChatPreviewContext } from './blocks'

const PersonaModeSchema = z.union([
  z.object({ type: z.literal('character'), characterId: z.string() }),
  z.object({ type: z.literal('stranger') }),
  z.object({ type: z.literal('custom'), prompt: z.string() }),
])

const ChatInputSchema = z.object({
  characterId: z.string(),
  persona: PersonaModeSchema,
  storyPointFragmentId: z.string().nullable(),
  messages: z.array(z.object({
    role: z.union([z.literal('user'), z.literal('assistant')]),
    content: z.string(),
  })),
  maxSteps: z.int().positive().optional(),
})

declare module '../agents/agent-instance' {
  interface AgentInputMap {
    'character-chat.chat': z.infer<typeof ChatInputSchema>
  }
}

const chatDefinition: AgentDefinition<typeof ChatInputSchema> = {
  name: 'character-chat.chat',
  description: 'In-character conversation with a story character.',
  inputSchema: ChatInputSchema,
  allowedCalls: [],
  run: async (ctx, input) => {
    return characterChat(ctx.dataDir, ctx.storyId, input, { abortSignal: ctx.abortSignal })
  },
}

let registered = false

export function registerCharacterChatAgents(): void {
  if (registered) return

  // Register instruction defaults
  instructionRegistry.registerDefault('character-chat.system', CHARACTER_CHAT_SYSTEM_PROMPT, { usedBy: 'character-chat.chat', kind: 'system' })
  instructionRegistry.registerDefault('character-chat.persona.character', 'You are speaking with {{personaName}}. {{personaDescription}}', { usedBy: 'character-chat.chat', kind: 'template' })
  instructionRegistry.registerDefault('character-chat.persona.stranger', 'You are speaking with a stranger you have just met. You do not know who they are.', { usedBy: 'character-chat.chat', kind: 'template' })
  instructionRegistry.registerDefault('character-chat.persona.custom', 'You are speaking with someone described as: {{prompt}}', { usedBy: 'character-chat.chat', kind: 'template' })

  // Agent definition
  agentRegistry.register(chatDefinition)

  // Model role (namespace-level — per-agent resolution via dot-separated names)
  modelRoleRegistry.register({ key: 'character-chat', label: 'Character Chat', description: 'In-character conversations' })

  // Block definition
  agentBlockRegistry.register({
    agentName: 'character-chat.chat',
    displayName: 'Character Chat',
    description: 'In-character conversation with a story character.',
    createDefaultBlocks: createCharacterChatBlocks,
    availableTools: [],
    buildPreviewContext: buildCharacterChatPreviewContext,
  })

  registered = true
}

/** Auto-discovery entry point */
export const register = registerCharacterChatAgents
