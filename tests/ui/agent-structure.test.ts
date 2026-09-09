import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentBlockInfo } from '@/lib/api/types'
import { groupAgents } from '@/components/agents/AgentCatalog'

function source(path: string) {
  return readFileSync(resolve(path), 'utf8')
}

function agent(agentName: string): AgentBlockInfo {
  return { agentName, displayName: agentName, description: '', availableTools: [] }
}

describe('agent workspace structure', () => {
  it('keeps the configuration panel focused on orchestration', () => {
    const panel = source('src/components/agents/AgentConfigurePanel.tsx')
    expect(panel).toContain('AgentCatalog')
    expect(panel).toContain('AgentModelControls')
    expect(panel).toContain('AgentToolControls')
    expect(panel).toContain('AgentPromptBlocks')
    expect(panel.split('\n').length).toBeLessThan(500)
  })

  it('uses shared settings controls for model and tool configuration', () => {
    expect(source('src/components/agents/AgentModelControls.tsx')).toContain('SettingsCard')
    expect(source('src/components/agents/AgentModelControls.tsx')).toContain('SettingRow')
    expect(source('src/components/agents/AgentToolControls.tsx')).toContain('Toggle')
    expect(source('src/components/agents/AgentPromptBlocks.tsx')).toContain('SegmentedControl')
  })

  it('groups known agents predictably and retains unknown agents', () => {
    const groups = groupAgents([
      agent('custom.agent'),
      agent('librarian.chat'),
      agent('generation.prewriter'),
      agent('generation.writer'),
      agent('generation.experimental'),
    ])

    expect(groups.map((group) => group.label)).toEqual(['Generation', 'Librarian', 'Other'])
    expect(groups[0].agents.map((item) => item.agentName)).toEqual([
      'generation.writer',
      'generation.prewriter',
      'generation.experimental',
    ])
    expect(groups[2].agents.map((item) => item.agentName)).toEqual(['custom.agent'])
  })
})
