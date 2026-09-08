import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  LoadedGlobalConfigSchema,
  SecretsFileSchema,
  StoredGlobalConfigSchema,
  type GlobalConfig,
  type ProviderConfig,
  type SecretsFile,
  type SharingConfig,
  type ErratanetConfig,
} from './schema'
import { readJsonFile, writeJsonAtomic, withStorageLock } from '../fs-utils'

function configPath(dataDir: string): string {
  return join(dataDir, 'config.json')
}

function secretsPath(dataDir: string): string {
  return join(dataDir, 'secrets.json')
}

/** Owner-only where the OS enforces it; on Windows the separate file is the protection, not the bits. */
const SECRETS_FILE_MODE = 0o600

async function readSecretsFile(dataDir: string): Promise<SecretsFile> {
  const raw = await readJsonFile(secretsPath(dataDir))
  // A corrupt secrets file must fail loudly. Defaulting to "no secrets" would
  // silently sign the user out of every provider and then overwrite the file
  // that still held the only copy of their keys.
  return SecretsFileSchema.parse(raw ?? {})
}

/** Join public configuration with its separately stored secrets. */
export async function getGlobalConfig(dataDir: string): Promise<GlobalConfig> {
  const [raw, secrets] = await Promise.all([
    readJsonFile(configPath(dataDir)),
    readSecretsFile(dataDir),
  ])
  const config = LoadedGlobalConfigSchema.parse(raw ?? {})
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKey: secrets.providerApiKeys[provider.id] ?? '',
    })),
    sharing: { ...config.sharing, passwordHash: secrets.sharingPasswordHash },
    erratanet: { ...config.erratanet, token: secrets.erratanetToken },
  }
}

async function writeGlobalConfigUnlocked(dataDir: string, config: GlobalConfig): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  const stored = StoredGlobalConfigSchema.parse(config)
  const secrets: SecretsFile = {
    version: 1,
    // Orphans are dropped by construction: deleting a provider deletes its key.
    providerApiKeys: Object.fromEntries(
      config.providers.filter((p) => p.apiKey).map((p) => [p.id, p.apiKey]),
    ),
    erratanetToken: config.erratanet.token,
    sharingPasswordHash: config.sharing.passwordHash,
  }
  // Secrets first: a crash between the two writes leaves keys recoverable, and
  // the join tolerates a secrets file that is ahead of config.json.
  await writeJsonAtomic(secretsPath(dataDir), secrets, SECRETS_FILE_MODE)
  await writeJsonAtomic(configPath(dataDir), stored)
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

/** Stand-in for a secret the client must never receive. */
export const MASK = '••••'

export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 4) return MASK
  return MASK + key.slice(-4)
}

/** Present-or-not, without revealing the value. */
function maskPresence(secret: string): string {
  return secret ? MASK : ''
}

export function maskProviders<T extends { apiKey: string }>(providers: T[]): T[] {
  return providers.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) }))
}

/**
 * Spread-and-override rather than rebuilt field by field, so a field added to
 * the erratanet schema reaches clients instead of silently vanishing here.
 */
export function redactErratanetConfig(erratanet: ErratanetConfig): ErratanetConfig {
  return { ...erratanet, token: maskPresence(erratanet.token) }
}

export async function getGlobalConfigSafe(dataDir: string): Promise<GlobalConfig> {
  const config = await getGlobalConfig(dataDir)
  return {
    ...config,
    providers: maskProviders(config.providers),
    sharing: { ...config.sharing, passwordHash: maskPresence(config.sharing.passwordHash) },
    erratanet: redactErratanetConfig(config.erratanet),
  }
}
