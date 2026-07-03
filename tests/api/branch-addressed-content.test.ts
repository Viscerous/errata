import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir } from '../setup'
import { createApp } from '@/server/api'

// Regression guard for the timeline "stale prose" bug: the content GET endpoints
// must return the branch named by `?branch=`, NOT whatever branch happens to be
// active. When they resolved the active branch instead, per-branch React Query
// caches held other timelines' prose and switching served stale content.

let dataDir: string
let cleanup: () => Promise<void>
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  const tmp = await createTempDir()
  dataDir = tmp.path
  cleanup = tmp.cleanup
  app = createApp(dataDir)
})

afterEach(async () => {
  await cleanup()
})

async function api(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, init))
  return { status: res.status, json: async () => res.json() }
}

async function apiJson(path: string, body: unknown, method = 'POST') {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Story where `main` has one prose passage and a child timeline `alt` (which is
 * left active, since createBranch auto-switches) has two. `main`'s single
 * passage fragment is shared by both branches (branch creation copies it).
 */
async function setupDivergedTimelines() {
  const story = await (await apiJson('/stories', { name: 'S', description: '' })).json()
  const id: string = story.id

  const f1 = await (await apiJson(`/stories/${id}/fragments`, {
    type: 'prose', name: '', description: '', content: 'MAIN-ONLY',
  })).json()
  await apiJson(`/stories/${id}/prose-chain`, { fragmentId: f1.id })

  // Auto-switches active to the new branch.
  const branch = await (await apiJson(`/stories/${id}/branches`, {
    name: 'Alt', parentBranchId: 'main',
  })).json()

  const f2 = await (await apiJson(`/stories/${id}/fragments`, {
    type: 'prose', name: '', description: '', content: 'ALT-EXTRA',
  })).json()
  await apiJson(`/stories/${id}/prose-chain`, { fragmentId: f2.id })

  return { id, altId: branch.id as string, sharedFragmentId: f1.id as string }
}

async function setActive(id: string, branchId: string) {
  await apiJson(`/stories/${id}/branches/active`, { branchId }, 'PATCH')
}

describe('branch-addressed content endpoints', () => {
  it('GET /prose-chain?branch= returns the named branch regardless of active', async () => {
    const { id, altId } = await setupDivergedTimelines() // active = alt

    const mainChain = await (await api(`/stories/${id}/prose-chain?branch=main`)).json()
    const altChain = await (await api(`/stories/${id}/prose-chain?branch=${altId}`)).json()
    expect(mainChain.entries).toHaveLength(1)
    expect(altChain.entries).toHaveLength(2)

    // Flip the active branch — the param must still win, not the active branch.
    await setActive(id, 'main')
    const mainChain2 = await (await api(`/stories/${id}/prose-chain?branch=main`)).json()
    const altChain2 = await (await api(`/stories/${id}/prose-chain?branch=${altId}`)).json()
    expect(mainChain2.entries).toHaveLength(1)
    expect(altChain2.entries).toHaveLength(2)
  })

  it('GET /prose-chain without ?branch= follows the active branch (back-compat)', async () => {
    const { id, altId } = await setupDivergedTimelines() // active = alt
    expect((await (await api(`/stories/${id}/prose-chain`)).json()).entries).toHaveLength(2)

    await setActive(id, 'main')
    expect((await (await api(`/stories/${id}/prose-chain`)).json()).entries).toHaveLength(1)

    await setActive(id, altId)
    expect((await (await api(`/stories/${id}/prose-chain`)).json()).entries).toHaveLength(2)
  })

  it('GET /fragments?branch= returns the named branch regardless of active', async () => {
    const { id, altId } = await setupDivergedTimelines() // active = alt

    const mainProse = await (await api(`/stories/${id}/fragments?type=prose&branch=main`)).json()
    const altProse = await (await api(`/stories/${id}/fragments?type=prose&branch=${altId}`)).json()
    expect(mainProse).toHaveLength(1)
    expect(altProse).toHaveLength(2)

    await setActive(id, 'main')
    const mainProse2 = await (await api(`/stories/${id}/fragments?type=prose&branch=main`)).json()
    const altProse2 = await (await api(`/stories/${id}/fragments?type=prose&branch=${altId}`)).json()
    expect(mainProse2).toHaveLength(1)
    expect(altProse2).toHaveLength(2)
  })

  it('GET /fragments/:id/versions?branch= is branch-addressed', async () => {
    const { id, altId, sharedFragmentId } = await setupDivergedTimelines() // active = alt

    // Edit the shared fragment on the active (alt) branch → adds a version there
    // only; main keeps its single version.
    await apiJson(`/stories/${id}/fragments/${sharedFragmentId}`, {
      name: '', description: '', content: 'MAIN-ONLY (revised on alt)',
    }, 'PUT')

    const altVersions = await (await api(`/stories/${id}/fragments/${sharedFragmentId}/versions?branch=${altId}`)).json()
    const mainVersions = await (await api(`/stories/${id}/fragments/${sharedFragmentId}/versions?branch=main`)).json()
    expect(altVersions.versions.length).toBeGreaterThan(mainVersions.versions.length)

    // Param wins even after switching active away from alt.
    await setActive(id, 'main')
    const altVersions2 = await (await api(`/stories/${id}/fragments/${sharedFragmentId}/versions?branch=${altId}`)).json()
    expect(altVersions2.versions.length).toBe(altVersions.versions.length)
  })
})
