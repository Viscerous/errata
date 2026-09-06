import { beforeAll, describe, expect, it } from 'vitest'
import { ensureCoreAgentsRegistered } from '@/server/agents/register-core'
import { agentRegistry } from '@/server/agents/registry'
import { agentBlockRegistry } from '@/server/agents/agent-block-registry'
import { buildInstructionInventory } from '@/server/instructions/inventory'

describe('model-facing instruction inventory', () => {
  beforeAll(() => {
    ensureCoreAgentsRegistered()
  })

  it('classifies every registered instruction and maps it to a known model surface', () => {
    const inventory = buildInstructionInventory()
    const knownSurfaces = new Set([
      ...agentRegistry.list().map(agent => agent.name),
      ...agentBlockRegistry.list().map(agent => agent.agentName),
    ])

    expect(inventory).toHaveLength(17)
    expect(inventory.every(entry => entry.usedBy !== 'unclassified')).toBe(true)
    expect(inventory.every(entry => entry.kind !== 'unclassified')).toBe(true)
    expect(inventory.every(entry => knownSurfaces.has(entry.usedBy))).toBe(true)
  })

  it('reports template placeholders and prompt size without interpreting prompt text', () => {
    const inventory = buildInstructionInventory()
    const byKey = new Map(inventory.map(entry => [entry.key, entry]))

    expect(byKey.get('character-chat.persona.character')).toMatchObject({
      usedBy: 'character-chat.chat',
      kind: 'template',
      placeholders: ['personaDescription', 'personaName'],
    })
    expect(byKey.get('directions.suggest-template')).toMatchObject({
      usedBy: 'directions.suggest',
      kind: 'template',
      placeholders: ['count'],
    })
    expect(byKey.get('librarian.analyze.system')?.characters).toBeGreaterThan(1_000)
    expect(byKey.get('librarian.analyze.system')?.estimatedTokens).toBeGreaterThan(250)
  })
})
