import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the agent runner so scheduler doesn't execute real agents
vi.mock('@/server/agents', () => ({
  invokeAgent: vi.fn(),
}))

// Mock the branches module — scheduler resolves the active branch before running
vi.mock('@/server/fragments/branches', () => ({
  getActiveBranchId: vi.fn().mockResolvedValue('main'),
  withBranch: vi.fn((_dataDir: string, _storyId: string, fn: () => Promise<unknown>, _branchId?: string) => fn()),
}))

// Mock librarian storage so reanalyzeAfterProseChange's index clear doesn't touch disk
vi.mock('@/server/librarian/storage', () => ({
  clearAnalysisIndexEntry: vi.fn(() => Promise.resolve()),
}))

// Import mocked modules AFTER vi.mock (vitest hoists mocks to top)
import { invokeAgent } from '@/server/agents'
import { triggerLibrarian, reanalyzeAfterProseChange, holdLibrarianAnalysis, clearPending, getPendingCount, getLibrarianRuntimeStatus } from '@/server/librarian/scheduler'
import type { Fragment } from '@/server/fragments/schema'

const mockedInvokeAgent = vi.mocked(invokeAgent)

function makeFragment(id: string): Fragment {
  const now = new Date().toISOString()
  return {
    id,
    type: 'prose',
    name: 'Test',
    description: 'test',
    content: 'content',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user' as const,
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
  }
}

function analysisResult() {
  return {
    runId: 'ar-test',
    output: {
      id: 'la-test',
      createdAt: new Date().toISOString(),
      fragmentId: 'pr-0001',
      summaryUpdate: '',
      mentions: [],
      contradictions: [],
      fragmentChangeProposals: [],
      timelineEvents: [],
    },
    trace: [],
    activityId: 'act-test',
  }
}

/** A controllable in-flight run: resolves only when the returned trigger is called. */
function deferredRun() {
  let release!: () => void
  mockedInvokeAgent.mockImplementationOnce(
    () => new Promise((resolve) => { release = () => resolve(analysisResult()) }),
  )
  return () => release()
}

describe('librarian scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPending()
    mockedInvokeAgent.mockResolvedValue(analysisResult())
  })

  afterEach(() => {
    clearPending()
  })

  it('runs the analyze agent immediately, without a debounce delay', async () => {
    await triggerLibrarian('/data', 'story-1', makeFragment('pr-0001'))

    await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(1))
    expect(mockedInvokeAgent).toHaveBeenCalledWith({
      dataDir: '/data',
      storyId: 'story-1',
      agentName: 'librarian.analyze',
      input: { fragmentId: 'pr-0001' },
    })
    await vi.waitFor(() => expect(getLibrarianRuntimeStatus('story-1').runStatus).toBe('idle'))
    expect(getPendingCount()).toBe(0)
  })

  it('coalesces triggers that arrive while a run is in flight (latest wins)', async () => {
    const release = deferredRun()

    await triggerLibrarian('/data', 'story-1', makeFragment('pr-0001'))
    await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(1))

    // These arrive while the first run is still in flight; only the last survives.
    await triggerLibrarian('/data', 'story-1', makeFragment('pr-0002'))
    await triggerLibrarian('/data', 'story-1', makeFragment('pr-0003'))
    expect(mockedInvokeAgent).toHaveBeenCalledTimes(1)
    expect(getPendingCount()).toBe(1)

    release()

    await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(2))
    expect(mockedInvokeAgent).toHaveBeenLastCalledWith({
      dataDir: '/data',
      storyId: 'story-1',
      agentName: 'librarian.analyze',
      input: { fragmentId: 'pr-0003' },
    })
  })

  it('runs independently for different stories', async () => {
    await triggerLibrarian('/data', 'story-1', makeFragment('pr-0001'))
    await triggerLibrarian('/data', 'story-2', makeFragment('pr-0002'))

    await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(2))
    expect(mockedInvokeAgent).toHaveBeenCalledWith({
      dataDir: '/data',
      storyId: 'story-1',
      agentName: 'librarian.analyze',
      input: { fragmentId: 'pr-0001' },
    })
    expect(mockedInvokeAgent).toHaveBeenCalledWith({
      dataDir: '/data',
      storyId: 'story-2',
      agentName: 'librarian.analyze',
      input: { fragmentId: 'pr-0002' },
    })
  })

  it('does not propagate errors from agent runner', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockedInvokeAgent.mockRejectedValue(new Error('LLM failed'))

    // Should not throw
    await triggerLibrarian('/data', 'story-1', makeFragment('pr-0001'))

    await vi.waitFor(() => {
      const errorCall = consoleSpy.mock.calls.find(call =>
        call[0]?.includes && call[0].includes('Librarian analysis failed'),
      )
      expect(errorCall).toBeDefined()
    })
    expect(getLibrarianRuntimeStatus('story-1').runStatus).toBe('error')
    consoleSpy.mockRestore()
  })

  describe('reanalyzeAfterProseChange', () => {
    it('runs re-analysis when prose content materially changes', async () => {
      const before = makeFragment('pr-0001')
      const after = { ...before, content: 'rewritten content' }

      reanalyzeAfterProseChange('/data', 'story-1', before, after)

      await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(1))
      expect(mockedInvokeAgent).toHaveBeenCalledWith({
        dataDir: '/data',
        storyId: 'story-1',
        agentName: 'librarian.analyze',
        input: { fragmentId: 'pr-0001' },
      })
    })

    it('ignores non-prose fragments', async () => {
      const before = { ...makeFragment('ch-0001'), type: 'character' as const }
      const after = { ...before, content: 'changed' }

      reanalyzeAfterProseChange('/data', 'story-1', before, after)

      expect(getPendingCount()).toBe(0)
      expect(mockedInvokeAgent).not.toHaveBeenCalled()
    })

    it('ignores changes that do not affect analyzed content', async () => {
      const before = makeFragment('pr-0001')
      const after = { ...before, sticky: true, updatedAt: new Date(Date.now() + 1000).toISOString() }

      reanalyzeAfterProseChange('/data', 'story-1', before, after)

      expect(getPendingCount()).toBe(0)
      expect(mockedInvokeAgent).not.toHaveBeenCalled()
    })
  })

  describe('holdLibrarianAnalysis', () => {
    it('defers analysis while held, then runs once with the latest fragment on release', async () => {
      const release = holdLibrarianAnalysis('story-1')

      // Several edits across an agent run's tool steps; none start while held.
      await triggerLibrarian('/data', 'story-1', makeFragment('pr-0001'))
      await triggerLibrarian('/data', 'story-1', makeFragment('pr-0002'))
      expect(mockedInvokeAgent).not.toHaveBeenCalled()
      expect(getLibrarianRuntimeStatus('story-1').runStatus).toBe('scheduled')

      release()

      await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(1))
      expect(mockedInvokeAgent).toHaveBeenCalledWith({
        dataDir: '/data',
        storyId: 'story-1',
        agentName: 'librarian.analyze',
        input: { fragmentId: 'pr-0002' },
      })
    })

    it('releasing with nothing queued does not run analysis', async () => {
      const release = holdLibrarianAnalysis('story-1')
      release()
      await Promise.resolve()
      expect(mockedInvokeAgent).not.toHaveBeenCalled()
      expect(getPendingCount()).toBe(0)
    })

    it('refcounts nested holds — analysis waits for the last release', async () => {
      const release1 = holdLibrarianAnalysis('story-1')
      const release2 = holdLibrarianAnalysis('story-1')

      await triggerLibrarian('/data', 'story-1', makeFragment('pr-0001'))
      release1()
      expect(mockedInvokeAgent).not.toHaveBeenCalled()

      release2()
      await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(1))
    })
  })

  it('clearPending resets in-flight and queued bookkeeping', async () => {
    // Runs that never settle, so they stay "in flight" for the assertion.
    mockedInvokeAgent.mockImplementation(() => new Promise(() => {}))

    await triggerLibrarian('/data', 'story-1', makeFragment('pr-0001'))
    await triggerLibrarian('/data', 'story-2', makeFragment('pr-0002'))
    await vi.waitFor(() => expect(mockedInvokeAgent).toHaveBeenCalledTimes(2))

    expect(getPendingCount()).toBe(2)
    clearPending()
    expect(getPendingCount()).toBe(0)
  })
})
