import { describe, expect, it } from 'vitest'
import {
  cancelActiveAgentsForBranch,
  listActiveAgents,
  registerActiveAgent,
  requestAgentCancellation,
  unregisterActiveAgent,
} from '@/server/agents/active-registry'

describe('active agent lifecycle', () => {
  it('cancels a run even when Stop wins the registration race', () => {
    const controller = new AbortController()
    expect(requestAgentCancellation('story-race', 'run-race')).toBe(false)

    const activityId = registerActiveAgent('story-race', 'generation.writer', {
      runId: 'run-race',
      branchId: 'br-abort',
      cancel: () => controller.abort(),
    })

    expect(controller.signal.aborted).toBe(true)
    expect(listActiveAgents('story-race')[0]).toMatchObject({
      runId: 'run-race',
      branchId: 'br-abort',
      status: 'cancelling',
    })
    unregisterActiveAgent(activityId)
  })

  it('cancels and waits for agents in only the deleted timeline', async () => {
    const cancelled: string[] = []
    let targetId = ''
    targetId = registerActiveAgent('story-delete', 'librarian.analyze', {
      branchId: 'br-delete',
      cancel: () => {
        cancelled.push('target')
        queueMicrotask(() => unregisterActiveAgent(targetId))
      },
    })
    const otherId = registerActiveAgent('story-delete', 'generation.writer', {
      branchId: 'br-keep',
      cancel: () => cancelled.push('other'),
    })

    await expect(cancelActiveAgentsForBranch('story-delete', 'br-delete')).resolves.toBe(1)
    expect(cancelled).toEqual(['target'])
    expect(listActiveAgents('story-delete')).toHaveLength(1)

    unregisterActiveAgent(otherId)
  })
})
