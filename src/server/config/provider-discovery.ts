import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_PRESETS, type PresetId, type ProviderModelInfo } from '@/contracts/providers'
import { fetchProviderModels } from './model-capabilities'

export interface DiscoveredProvider {
  preset: PresetId
  name: string
  baseURL: string
  models: ProviderModelInfo[]
  status: 'available' | 'unavailable'
  error?: string
}

interface DiscoveryDependencies {
  fetch?: typeof globalThis.fetch
  readText?: (path: string) => Promise<string>
  homeDir?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

const LOCAL_PRESETS: PresetId[] = ['ollama', 'lmstudio', 'llamacpp', 'koboldcpp', 'omlx']

function validPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535
    ? value
    : null
}

function loopbackURL(raw: string): URL | null {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(withScheme)
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host !== 'localhost' && host !== '::1' && !host.startsWith('127.')) return null
    return url
  } catch {
    return null
  }
}

async function readJSON(path: string, readText: (path: string) => Promise<string>): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readText(path))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Resolve only known loopback candidates; discovery never scans the LAN. */
export async function localProviderCandidates(deps: DiscoveryDependencies = {}): Promise<Array<{ preset: PresetId; baseURL: string }>> {
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf8'))
  const home = deps.homeDir ?? homedir()
  const env = deps.env ?? process.env
  const candidates = new Map<PresetId, string>(
    LOCAL_PRESETS.map(preset => [preset, PROVIDER_PRESETS[preset].baseURL]),
  )

  const ollamaRaw = env.OLLAMA_HOST?.trim()
  if (ollamaRaw) {
    const url = loopbackURL(ollamaRaw)
    if (url) {
      const port = url.port || '11434'
      candidates.set('ollama', `${url.protocol}//${url.hostname}:${port}/v1`)
    }
  }

  const lmStudio = await readJSON(join(home, '.lmstudio', '.internal', 'http-server-config.json'), readText)
  const lmPort = validPort(lmStudio.port)
  if (lmPort) candidates.set('lmstudio', `http://127.0.0.1:${lmPort}/v1`)

  const omlx = await readJSON(join(home, '.omlx', 'settings.json'), readText)
  const omlxServer = omlx.server && typeof omlx.server === 'object' ? omlx.server as Record<string, unknown> : {}
  const omlxPort = validPort(omlxServer.port)
  if (omlxPort) candidates.set('omlx', `http://127.0.0.1:${omlxPort}/v1`)

  return [...candidates].map(([preset, baseURL]) => ({ preset, baseURL }))
}

async function probeCandidate(
  candidate: { preset: PresetId; baseURL: string },
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<DiscoveredProvider> {
  try {
    const { models } = await fetchProviderModels({
      ...candidate,
      apiKey: 'local',
    }, { fetch: fetchImpl, timeoutMs })
    return {
      ...candidate,
      name: PROVIDER_PRESETS[candidate.preset].name,
      models,
      status: 'available',
    }
  } catch (error) {
    return {
      ...candidate,
      name: PROVIDER_PRESETS[candidate.preset].name,
      models: [],
      status: 'unavailable',
      error: error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))
        ? 'Timed out'
        : error instanceof Error ? error.message : 'Unavailable',
    }
  }
}

/** Probe every known candidate concurrently so a dead backend delays no other. */
export async function discoverLocalProviders(deps: DiscoveryDependencies = {}): Promise<DiscoveredProvider[]> {
  const candidates = await localProviderCandidates(deps)
  const fetchImpl = deps.fetch ?? globalThis.fetch
  return Promise.all(candidates.map(candidate => probeCandidate(candidate, fetchImpl, deps.timeoutMs ?? 1_500)))
}
