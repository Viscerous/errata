// @vitest-environment jsdom
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CharacterLiveStatePanel } from '@/components/fragments/CharacterLiveStatePanel'
import type { Fragment } from '@/lib/api'

const { getContinuity, updateCharacterLiveState } = vi.hoisted(() => ({
  getContinuity: vi.fn(),
  updateCharacterLiveState: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    librarian: {
      getContinuity,
      updateCharacterLiveState,
    },
    branches: {
      list: vi.fn().mockResolvedValue({ activeBranchId: 'main' }),
    },
  },
}))

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

describe('CharacterLiveStatePanel', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders seeded live state from fragment meta when continuity is empty', async () => {
    getContinuity.mockResolvedValue({ ledger: null, view: null, latestAnalysisId: null })

    const fragment = makeCharacterFragment({
      meta: {
        liveState: {
          immediate: 'catching breath after a sprint',
          state: { attire: 'dark cloak', gear: 'iron lantern' },
          knowledge: ['the castle gate is locked'],
          secrets: ['harbors a hidden medallion'],
        },
      },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <CharacterLiveStatePanel storyId="story-test" fragment={fragment} />
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Live Character State')).toBeDefined()
    })

    expect(screen.getByText('catching breath after a sprint')).toBeDefined()
    expect(screen.getByText('dark cloak')).toBeDefined()
    expect(screen.getByText('iron lantern')).toBeDefined()
    expect(screen.getByText('the castle gate is locked')).toBeDefined()
    expect(screen.getByText('harbors a hidden medallion')).toBeDefined()
  })

  it('allows entering edit mode and submitting updated live state', async () => {
    getContinuity.mockResolvedValue({ ledger: null, view: null, latestAnalysisId: null })
    updateCharacterLiveState.mockResolvedValue({
      ok: true,
      characterState: {
        characterId: 'ch-test-hero',
        name: 'Hero',
        immediate: 'resting by the fire',
        state: { attire: 'dry tunic' },
        knowledge: [],
        secrets: [],
      },
    })

    const fragment = makeCharacterFragment({
      meta: {
        liveState: {
          immediate: 'weary from the road',
          state: { attire: 'travel-stained cloak' },
        },
      },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <CharacterLiveStatePanel storyId="story-test" fragment={fragment} />
      </QueryClientProvider>,
    )

    const editBtn = await screen.findByRole('button', { name: /edit state/i }, { timeout: 4000 })
    fireEvent.click(editBtn)

    // The immediate posture input should be visible and editable
    const input = await screen.findByPlaceholderText('Immediate posture or action beat...', {}, { timeout: 4000 })
    fireEvent.change(input, { target: { value: 'resting by the fire' } })

    // Click Save State
    const saveBtn = await screen.findByRole('button', { name: /save state/i }, { timeout: 4000 })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(updateCharacterLiveState).toHaveBeenCalledWith(
        'story-test',
        'ch-test-hero',
        expect.objectContaining({
          immediate: 'resting by the fire',
        }),
      )
    })
  })
})
