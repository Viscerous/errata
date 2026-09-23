// @vitest-environment jsdom
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CharacterLiveStatePanel } from '@/components/fragments/CharacterLiveStatePanel'
import type { FoldedLiveState, Fragment } from '@/lib/api'

const { getContinuity, updateLiveState } = vi.hoisted(() => ({
  getContinuity: vi.fn(),
  updateLiveState: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    librarian: {
      getContinuity,
      updateLiveState,
    },
    branches: {
      list: vi.fn().mockResolvedValue({ activeBranchId: 'main' }),
    },
  },
}))

const source = { sourceFragmentId: 'pr-0001', analysisId: 'la-1', narrativePosition: 1 }

function makeCharacterFragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: 'ch-test-hero',
    type: 'character',
    name: 'Hero',
    description: 'A generic protagonist',
    content: 'Hero content.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    order: 0,
    meta: {},
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function heroState(overrides: Partial<FoldedLiveState> = {}): FoldedLiveState {
  return {
    ...source,
    kind: 'character',
    key: 'ch-test-hero',
    fragmentId: 'ch-test-hero',
    name: 'Hero',
    present: true,
    fields: [
      { ...source, field: 'Where', value: 'the castle gate', holds: 'lastKnown', visibility: 'outward', scenesAgo: 2 },
      { ...source, field: 'Currently', value: 'driving a cart', holds: 'moment', visibility: 'outward', scenesAgo: 0 },
    ],
    items: [
      { ...source, id: 'k1', field: 'Knows', text: 'the castle gate is locked', visibility: 'inner' },
    ],
    ended: [
      {
        ...source,
        id: 's1',
        field: 'Secrets',
        text: 'harbors a hidden medallion',
        visibility: 'inner',
        happened: 'revealed',
        to: ['ch-guard'],
        endedAt: source,
      },
    ],
    ...overrides,
  }
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <CharacterLiveStatePanel storyId="story-test" fragment={makeCharacterFragment()} />
    </QueryClientProvider>,
  )
}

describe('CharacterLiveStatePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows entries directly, the moment first, with what ended and how', async () => {
    const guard = { ...heroState(), key: 'ch-guard', fragmentId: 'ch-guard', name: 'The Guard', fields: [], items: [], ended: [] }
    getContinuity.mockResolvedValue({ ledger: null, view: { liveStates: [heroState(), guard] }, latestAnalysisId: null })
    renderPanel()

    await waitFor(() => expect(screen.getByText('driving a cart')).toBeDefined())
    // The moment leads, then last-known fields with their age.
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Currently:')).toBeLessThan(text.indexOf('Where:'))
    expect(screen.getByText(/2 scenes ago/)).toBeDefined()
    expect(screen.getByText('the castle gate is locked')).toBeDefined()
    expect(screen.getByText('harbors a hidden medallion')).toBeDefined()
    expect(screen.getByText(/Revealed to The Guard/)).toBeDefined()
  })

  it('sends the edited state with each kept entry\'s identity', async () => {
    getContinuity.mockResolvedValue({ ledger: null, view: { liveStates: [heroState()] }, latestAnalysisId: null })
    updateLiveState.mockResolvedValue({ ok: true, liveState: null })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    fireEvent.change(await screen.findByDisplayValue('driving a cart'), { target: { value: 'resting by the fire' } })
    fireEvent.change(screen.getByDisplayValue('the castle gate is locked'), { target: { value: 'the castle gate is barred' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(updateLiveState).toHaveBeenCalledWith('story-test', 'character', 'ch-test-hero', {
        fields: [
          { field: 'Currently', value: 'resting by the fire' },
          { field: 'Where', value: 'the castle gate' },
        ],
        items: [{ id: 'k1', field: 'Knows', text: 'the castle gate is barred' }],
      })
    })
  })

  it('shows only a way to add state when nothing is recorded yet', async () => {
    getContinuity.mockResolvedValue({ ledger: null, view: null, latestAnalysisId: null })
    renderPanel()

    expect(await screen.findByRole('button', { name: /add state/i })).toBeDefined()
    expect(screen.queryByText(/Currently:/)).toBeNull()
  })
})
