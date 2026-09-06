export interface PayloadMessage {
  role: string
  content: string
}

export interface PayloadBlock {
  id: string
  name: string
  role: string
  content?: string
}

export interface PayloadTool {
  name: string
  characters: number
  enabled?: boolean
}

export interface PayloadPart {
  id: string
  label: string
  kind: 'message' | 'block' | 'tool'
  role?: string
  characters: number
  estimatedTokens: number
}

export interface ContextPayloadBreakdown {
  messageCharacters: number
  toolCharacters: number
  estimatedCharacters: number
  estimatedTokens: number
  requestParts: PayloadPart[]
  largestSources: PayloadPart[]
}

function tokensFor(characters: number): number {
  return Math.ceil(characters / 4)
}

/** Exact request totals plus declared block/tool sources for visual inspection. */
export function buildContextPayloadBreakdown(args: {
  messages: readonly PayloadMessage[]
  blocks?: readonly PayloadBlock[]
  tools?: readonly PayloadTool[]
  activeToolNames?: readonly string[]
  sourceLimit?: number
}): ContextPayloadBreakdown {
  const roles = new Map<string, number>()
  for (const message of args.messages) {
    roles.set(message.role, (roles.get(message.role) ?? 0) + message.content.length)
  }

  const activeNames = args.activeToolNames ? new Set(args.activeToolNames) : null
  const activeTools = (args.tools ?? []).filter((tool) => (
    tool.enabled !== false && (!activeNames || activeNames.has(tool.name))
  ))
  const messageCharacters = [...roles.values()].reduce((sum, characters) => sum + characters, 0)
  const toolCharacters = activeTools.reduce((sum, tool) => sum + tool.characters, 0)
  const estimatedCharacters = messageCharacters + toolCharacters

  const requestParts: PayloadPart[] = [
    ...[...roles.entries()].map(([role, characters]) => ({
      id: `message:${role}`,
      label: `${role} messages`,
      kind: 'message' as const,
      role,
      characters,
      estimatedTokens: tokensFor(characters),
    })),
    ...(toolCharacters > 0 ? [{
      id: 'tool-schemas',
      label: 'tool schemas',
      kind: 'tool' as const,
      characters: toolCharacters,
      estimatedTokens: tokensFor(toolCharacters),
    }] : []),
  ]

  const largestSources: PayloadPart[] = [
    ...(args.blocks ?? [])
      .filter((block) => block.content !== undefined)
      .map((block) => {
        const characters = block.content?.length ?? 0
        return {
          id: `block:${block.id}`,
          label: block.name,
          kind: 'block' as const,
          role: block.role,
          characters,
          estimatedTokens: tokensFor(characters),
        }
      }),
    ...activeTools.map((tool) => ({
      id: `tool:${tool.name}`,
      label: tool.name,
      kind: 'tool' as const,
      characters: tool.characters,
      estimatedTokens: tokensFor(tool.characters),
    })),
  ]
    .filter((part) => part.characters > 0)
    .sort((left, right) => right.characters - left.characters)
    .slice(0, args.sourceLimit ?? 8)

  return {
    messageCharacters,
    toolCharacters,
    estimatedCharacters,
    estimatedTokens: tokensFor(estimatedCharacters),
    requestParts,
    largestSources,
  }
}
