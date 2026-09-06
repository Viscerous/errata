import { instructionRegistry, type InstructionKind } from './registry'

export interface InstructionInventoryEntry {
  key: string
  usedBy: string
  kind: InstructionKind | 'unclassified'
  characters: number
  estimatedTokens: number
  placeholders: string[]
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([a-zA-Z][\w]*)\}\}/g)].map(match => match[1]))].sort()
}

/** A read-only inventory of registered model-facing instruction text. */
export function buildInstructionInventory(): InstructionInventoryEntry[] {
  return instructionRegistry.listEntries()
    .map(entry => ({
      key: entry.key,
      usedBy: entry.usedBy ?? 'unclassified',
      kind: entry.kind ?? ('unclassified' as const),
      characters: entry.text.length,
      estimatedTokens: Math.ceil(entry.text.length / 4),
      placeholders: placeholders(entry.text),
    }))
    .sort((left, right) => left.usedBy.localeCompare(right.usedBy) || left.key.localeCompare(right.key))
}
