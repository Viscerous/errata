import { asSchema } from 'ai'

export interface ToolSurface {
  name: string
  description: string
  schema: string
  characters: number
  estimatedTokens: number
}

/** Serialize the same name, description, and input schema exposed to the model. */
export async function describeToolSurface(name: string, definition: unknown): Promise<ToolSurface> {
  const tool = definition as {
    description?: string
    inputSchema?: Parameters<typeof asSchema>[0]
  }
  const description = tool.description ?? ''
  const schema = tool.inputSchema
    ? JSON.stringify(await asSchema(tool.inputSchema).jsonSchema)
    : ''
  const characters = name.length + description.length + schema.length
  return {
    name,
    description,
    schema,
    characters,
    estimatedTokens: Math.ceil(characters / 4),
  }
}
