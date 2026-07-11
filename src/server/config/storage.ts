import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { GlobalConfigSchema, type GlobalConfig, type ProviderConfig, type SharingConfig, type ErratanetConfig } from './schema'
import { writeJsonAtomic } from '../fs-utils'
import { withStorageLock } from '../fs-utils'

function configPath(dataDir: string): string {
  return join(dataDir, 'config.json')
}

export async function getGlobalConfig(dataDir: string): Promise<GlobalConfig> {
  try {
    const raw = await fs.readFile(configPath(dataDir), 'utf-8')
    return GlobalConfigSchema.parse(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return GlobalConfigSchema.parse({})
    }
    throw new Error(`Unable to read configuration at ${configPath(dataDir)}; the original file was left untouched`, { cause: error })
  }
}

async function writeGlobalConfigUnlocked(dataDir: string, config: GlobalConfig): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  await writeJsonAtomic(configPath(dataDir), GlobalConfigSchema.parse(config))
}

export async function mutateGlobalConfig(
  dataDir: string,
  mutate: (config: GlobalConfig) => void,
): Promise<GlobalConfig> {
  return withStorageLock(configPath(dataDir), async () => {
    const config = await getGlobalConfig(dataDir)
    mutate(config)
    await writeGlobalConfigUnlocked(dataDir, config)
    return config
  })
}

export async function getSharingConfig(dataDir: string): Promise<SharingConfig> {
  return (await getGlobalConfig(dataDir)).sharing
}

export async function updateSharingConfig(dataDir: string, patch: Partial<SharingConfig>): Promise<SharingConfig> {
  const config = await mutateGlobalConfig(dataDir, (current) => {
    current.sharing = { ...current.sharing, ...patch }
  })
  return config.sharing
}

export async function getErratanetConfig(dataDir: string): Promise<ErratanetConfig> {
  return (await getGlobalConfig(dataDir)).erratanet
}

export async function updateErratanetConfig(dataDir: string, patch: Partial<ErratanetConfig>): Promise<ErratanetConfig> {
  const config = await mutateGlobalConfig(dataDir, (current) => {
    current.erratanet = { ...current.erratanet, ...patch }
  })
  return config.erratanet
}

export async function saveGlobalConfig(dataDir: string, config: GlobalConfig): Promise<void> {
  await withStorageLock(configPath(dataDir), () => writeGlobalConfigUnlocked(dataDir, config))
}

export async function addProvider(dataDir: string, provider: ProviderConfig): Promise<GlobalConfig> {
  return mutateGlobalConfig(dataDir, (config) => {
    config.providers.push(provider)
    if (config.providers.length === 1) config.defaultProviderId = provider.id
  })
}

export async function updateProvider(dataDir: string, providerId: string, updates: Partial<Omit<ProviderConfig, 'id' | 'createdAt'>>): Promise<GlobalConfig> {
  return mutateGlobalConfig(dataDir, (config) => {
    const idx = config.providers.findIndex((p) => p.id === providerId)
    if (idx === -1) throw new Error(`Provider ${providerId} not found`)
    config.providers[idx] = { ...config.providers[idx], ...updates }
  })
}

export async function deleteProvider(dataDir: string, providerId: string): Promise<GlobalConfig> {
  return mutateGlobalConfig(dataDir, (config) => {
    config.providers = config.providers.filter((p) => p.id !== providerId)
    if (config.defaultProviderId === providerId) config.defaultProviderId = config.providers[0]?.id ?? null
  })
}

export async function getProvider(dataDir: string, providerId: string): Promise<ProviderConfig | undefined> {
  const config = await getGlobalConfig(dataDir)
  return config.providers.find((p) => p.id === providerId)
}

export async function duplicateProvider(dataDir: string, providerId: string): Promise<GlobalConfig> {
  return mutateGlobalConfig(dataDir, (config) => {
    const source = config.providers.find((p) => p.id === providerId)
    if (!source) throw new Error(`Provider ${providerId} not found`)
    config.providers.push({
      ...source,
      id: `prov-${Date.now().toString(36)}`,
      name: `${source.name} (copy)`,
      createdAt: new Date().toISOString(),
    })
  })
}

export function maskApiKey(key: string): string {
  if (key.length <= 4) return '••••'
  return '••••' + key.slice(-4)
}

export async function getGlobalConfigSafe(dataDir: string): Promise<GlobalConfig> {
  const config = await getGlobalConfig(dataDir)
  return {
    ...config,
    providers: config.providers.map((p) => ({
      ...p,
      apiKey: maskApiKey(p.apiKey),
    })),
    // Never expose the password hash to clients.
    sharing: { ...config.sharing, passwordHash: config.sharing.passwordHash ? '••••' : '' },
    // Never expose the hub token to clients.
    erratanet: { ...config.erratanet, token: config.erratanet.token ? '••••' : '' },
  }
}
