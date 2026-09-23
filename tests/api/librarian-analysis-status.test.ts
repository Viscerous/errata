import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createApp } from '@/server/api'
import { createFragment, createStory, updateFragment, updateStory } from '@/server/fragments/storage'
import { addProseSection } from '@/server/fragments/prose-chain'
import { getAgentBlockConfig, saveAgentBlockConfig } from '@/server/agents/agent-block-storage'
import { deleteAnalysis, saveAnalysis, setAnalysisFailure, type LibrarianAnalysis } from '@/server/librarian/storage'
import { analysisSourceRevision } from '@/server/librarian/continuity-source'
import { SUMMARY_CONTRACT_VERSION } from '@/server/librarian/summary-contract'
import { clearPending, holdLibrarianAnalysis, triggerLibrarian } from '@/server/librarian/scheduler'
import type { Fragment } from '@/contracts/story'

describe('GET librarian analysis-index', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let analysisSequence = 0
  const storyId = 'story-analysis-status'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    analysisSequence = 0
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

  afterEach(async () => {
    clearPending()
    await cleanup()
  })

  async function status() {
    const response = await createApp(dataDir).fetch(new Request(`http://localhost/api/stories/${storyId}/librarian/analysis-index`))
    expect(response.status).toBe(200)
    return response.json() as Promise<{
      autoAnalysisDisabled: boolean
      latestByFragmentId: Record<string, string>
      warningByFragmentId: Record<string, string>
    }>
  }

  async function passage(id = 'pr-one', inChain = true): Promise<Fragment> {
    const now = new Date().toISOString()
    const fragment: Fragment = {
      id,
      type: 'prose',
      name: 'Passage',
      description: 'Write a scene',
      content: 'The door opened.',
      tags: [],
      refs: [],
      sticky: false,
      placement: 'user',
      createdAt: now,
      updatedAt: now,
      order: 0,
      meta: {},
    }
    await createFragment(dataDir, storyId, fragment)
    if (inChain) await addProseSection(dataDir, storyId, id)
    return fragment
  }

  function analysis(id: string, complete: boolean, source: Fragment): LibrarianAnalysis {
    return {
      id,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, analysisSequence++)).toISOString(),
      fragmentId: source.id,
      sourceRevision: analysisSourceRevision(source),
      summaryUpdate: 'The door opened.',
      summaryContractVersion: SUMMARY_CONTRACT_VERSION,
      mentions: [],
      contradictions: [],
      fragmentChangeProposals: [],
      timelineEvents: [],
      ...(complete ? {
        continuityProjection: {
          version: 4 as const,
          scene: { transition: 'continue' as const },
          threadOperations: [],
          threadFocus: [],
          liveStates: [],
        },
      } : {}),
    }
  }

  it('does not warn when there are no passages', async () => {
    expect(await status()).toEqual({
      autoAnalysisDisabled: false,
      latestByFragmentId: {},
      warningByFragmentId: {},
    })
  })

  it('warns for a saved passage with no analysis', async () => {
    await passage()
    expect((await status()).warningByFragmentId).toEqual({ 'pr-one': 'No analysis for this passage' })
  })

  it('covers prose shown by the no-chain fallback too', async () => {
    await passage('pr-loose', false)
    expect((await status()).warningByFragmentId).toEqual({ 'pr-loose': 'No analysis for this passage' })
  })

  it('warns for an attempted run that failed before saving', async () => {
    await passage()
    await setAnalysisFailure(dataDir, storyId, 'pr-one', 'LLM failed')
    expect(await status()).toEqual({
      autoAnalysisDisabled: false,
      latestByFragmentId: {},
      warningByFragmentId: { 'pr-one': 'LLM failed' },
    })
  })

  it('warns for a saved partial run, then clears after completion', async () => {
    const source = await passage()
    await saveAnalysis(dataDir, storyId, analysis('partial', false, source))
    expect((await status()).warningByFragmentId['pr-one']).toBe('Analysis did not complete')

    await saveAnalysis(dataDir, storyId, analysis('complete', true, source))
    expect(await status()).toEqual({
      autoAnalysisDisabled: false,
      latestByFragmentId: { 'pr-one': 'complete' },
      warningByFragmentId: {},
    })
  })

  it('reveals a gap after the only analysis is deleted', async () => {
    const source = await passage()
    await saveAnalysis(dataDir, storyId, analysis('complete', true, source))
    expect((await status()).warningByFragmentId).toEqual({})

    await deleteAnalysis(dataDir, storyId, 'complete')
    expect((await status()).warningByFragmentId).toEqual({ 'pr-one': 'No analysis for this passage' })
  })

  it('checks every active passage and preserves a valid older analysis after deletion', async () => {
    const first = await passage()
    const second = await passage('pr-two')
    await saveAnalysis(dataDir, storyId, analysis('first-old', true, first))
    await saveAnalysis(dataDir, storyId, analysis('first-new', true, first))

    expect((await status()).warningByFragmentId).toEqual({ 'pr-two': 'No analysis for this passage' })
    await deleteAnalysis(dataDir, storyId, 'first-new')
    expect((await status()).warningByFragmentId).toEqual({ 'pr-two': 'No analysis for this passage' })

    await saveAnalysis(dataDir, storyId, analysis('second', true, second))
    expect((await status()).warningByFragmentId).toEqual({})
  })

  it('warns when an existing analysis cannot contribute a current summary', async () => {
    const source = await passage()
    await saveAnalysis(dataDir, storyId, { ...analysis('empty', true, source), summaryUpdate: '' })
    expect((await status()).warningByFragmentId['pr-one']).toBe('Analysis recorded no story summary')

    await saveAnalysis(dataDir, storyId, analysis('current', true, source))
    await updateFragment(dataDir, storyId, { ...source, content: 'The door stayed closed.' })
    expect((await status()).warningByFragmentId['pr-one']).toBe('Passage changed since analysis')
  })

  it.each([
    ['unverified source', { sourceRevision: undefined }, 'Analysis cannot be matched to this passage'],
    ['old contract', { summaryContractVersion: 0 }, 'Analysis uses an older story-summary format'],
  ] as const)('warns when a summary has %s', async (_label, override, warning) => {
    const source = await passage()
    await saveAnalysis(dataDir, storyId, { ...analysis('unusable', true, source), ...override })
    expect((await status()).warningByFragmentId['pr-one']).toBe(warning)
  })

  it('does not flag a passage while its first analysis is queued', async () => {
    const source = await passage()
    const release = holdLibrarianAnalysis(storyId)
    await triggerLibrarian(dataDir, storyId, source)
    expect((await status()).warningByFragmentId).toEqual({})
    clearPending()
    release()
    expect((await status()).warningByFragmentId).toEqual({ 'pr-one': 'No analysis for this passage' })
  })

  it('reports both settings that disable automatic analysis', async () => {
    await passage()
    const story = (await (await createApp(dataDir).fetch(new Request(`http://localhost/api/stories/${storyId}`))).json())
    await updateStory(dataDir, { ...story, settings: { ...story.settings, disableLibrarianAutoAnalysis: true } })
    expect((await status()).autoAnalysisDisabled).toBe(true)
    expect((await status()).warningByFragmentId).toEqual({})

    await updateStory(dataDir, { ...story, settings: { ...story.settings, disableLibrarianAutoAnalysis: false } })
    const config = await getAgentBlockConfig(dataDir, storyId, 'librarian.analyze')
    await saveAgentBlockConfig(dataDir, storyId, 'librarian.analyze', { ...config, disableAutoAnalysis: true })
    expect((await status()).autoAnalysisDisabled).toBe(true)
    expect((await status()).warningByFragmentId).toEqual({})
  })
})
