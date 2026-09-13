import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createApp } from '@/server/api'
import { createStory, updateStory } from '@/server/fragments/storage'
import { getAgentBlockConfig, saveAgentBlockConfig } from '@/server/agents/agent-block-storage'
import { saveAnalysis, setAnalysisFailure, type LibrarianAnalysis } from '@/server/librarian/storage'

describe('GET librarian analysis-index', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  const storyId = 'story-analysis-status'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, {
      id: storyId,
      name: 'Analysis status',
      description: '',
      coverImage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: makeTestSettings(),
    })
  })

  afterEach(async () => cleanup())

  async function status() {
    const response = await createApp(dataDir).fetch(new Request(`http://localhost/api/stories/${storyId}/librarian/analysis-index`))
    expect(response.status).toBe(200)
    return response.json() as Promise<{
      autoAnalysisDisabled: boolean
      latestByFragmentId: Record<string, string>
      warningByFragmentId: Record<string, string>
    }>
  }

  function analysis(id: string, complete: boolean): LibrarianAnalysis {
    return {
      id,
      createdAt: new Date().toISOString(),
      fragmentId: 'pr-one',
      summaryUpdate: '',
      mentions: [],
      contradictions: [],
      fragmentChangeProposals: [],
      timelineEvents: [],
      ...(complete ? {
        continuityProjection: {
          version: 2 as const,
          scene: { transition: 'continue' as const },
          stateOperations: [],
          threadOperations: [],
          threadFocus: [],
          knowledgeOperations: [],
        },
      } : {}),
    }
  }

  it('does not warn for a never-attempted passage', async () => {
    expect(await status()).toEqual({
      autoAnalysisDisabled: false,
      latestByFragmentId: {},
      warningByFragmentId: {},
    })
  })

  it('warns for an attempted run that failed before saving', async () => {
    await setAnalysisFailure(dataDir, storyId, 'pr-one', 'LLM failed')
    expect(await status()).toEqual({
      autoAnalysisDisabled: false,
      latestByFragmentId: {},
      warningByFragmentId: { 'pr-one': 'LLM failed' },
    })
  })

  it('warns for a saved partial run, then clears after completion', async () => {
    await saveAnalysis(dataDir, storyId, analysis('partial', false))
    expect((await status()).warningByFragmentId['pr-one']).toBe('Analysis did not complete')

    await saveAnalysis(dataDir, storyId, analysis('complete', true))
    expect(await status()).toEqual({
      autoAnalysisDisabled: false,
      latestByFragmentId: { 'pr-one': 'complete' },
      warningByFragmentId: {},
    })
  })

  it('reports both settings that disable automatic analysis', async () => {
    const story = (await (await createApp(dataDir).fetch(new Request(`http://localhost/api/stories/${storyId}`))).json())
    await updateStory(dataDir, { ...story, settings: { ...story.settings, disableLibrarianAutoAnalysis: true } })
    expect((await status()).autoAnalysisDisabled).toBe(true)

    await updateStory(dataDir, { ...story, settings: { ...story.settings, disableLibrarianAutoAnalysis: false } })
    const config = await getAgentBlockConfig(dataDir, storyId, 'librarian.analyze')
    await saveAgentBlockConfig(dataDir, storyId, 'librarian.analyze', { ...config, disableAutoAnalysis: true })
    expect((await status()).autoAnalysisDisabled).toBe(true)
  })
})
