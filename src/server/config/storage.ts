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
import { writeJsonAtomic } from '../fs-utils'
import { withStorageLock } from '../fs-utils'

function configPath(dataDir: string): string {
  return join(dataDir, 'config.json')
}

function secretsPath(dataDir: string): string {
  return join(dataDir, 'secrets.json')
}

/** Owner-only where the OS enforces it; on Windows the separate file is the protection, not the bits. */
const SECRETS_FILE_MODE = 0o600

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf-8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Unable to read configuration at ${path}; the original file was left untouched`, { cause: error })
  }
}

async function readSecretsFile(dataDir: string): Promise<SecretsFile> {
  const raw = await readJsonFile(secretsPath(dataDir))
  // A corrupt secrets file must fail loudly. Defaulting to "no secrets" would
  // silently sign the user out of every provider and then overwrite the file
  // that still held the only copy of their keys.
  return SecretsFileSchema.parse(raw ?? {})
}

/**
 * Join config.json with secrets.json.
 *
 * Configs written before the split still carry their secrets inline; those are
 * honoured as a fallback so an un-migrated install keeps working, and the first
 * write clears them. The secrets file wins wherever it has a value.
 */
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
      apiKey: secrets.providerApiKeys[provider.id] || provider.apiKey,
    })),
    sharing: { ...config.sharing, passwordHash: secrets.sharingPasswordHash || config.sharing.passwordHash },
    erratanet: { ...config.erratanet, token: secrets.erratanetToken || config.erratanet.token },
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

export interface SecretsMigrationResult {
  migrated: boolean
  providerKeys: number
  erratanetToken: boolean
  sharingPasswordHash: boolean
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

/** Secrets left inline in a config.json written before the split. */
function countInlineSecrets(raw: unknown): Omit<SecretsMigrationResult, 'migrated'> {
  const obj = raw as {
    providers?: Array<{ apiKey?: unknown }>
    erratanet?: { token?: unknown }
    sharing?: { passwordHash?: unknown }
  } | null
  const providers = Array.isArray(obj?.providers) ? obj.providers : []
  return {
    providerKeys: providers.filter((p) => isNonEmptyString(p?.apiKey)).length,
    erratanetToken: isNonEmptyString(obj?.erratanet?.token),
    sharingPasswordHash: isNonEmptyString(obj?.sharing?.passwordHash),
  }
}

/**
 * Lift secrets out of a pre-split config.json into secrets.json and rewrite
 * config.json without them.
 *
 * The plaintext is not kept anywhere: the point is that the old file stops
 * holding secrets, and a backup beside it would defeat that.
 */
export async function migrateLegacyPlaintextSecrets(dataDir: string): Promise<SecretsMigrationResult> {
  return withStorageLock(configPath(dataDir), async () => {
    const inline = countInlineSecrets(await readJsonFile(configPath(dataDir)))
    if (!inline.providerKeys && !inline.erratanetToken && !inline.sharingPasswordHash) {
      return { migrated: false, ...inline }
    }
    // The join folds the inline values in; writing the result splits them out.
    await writeGlobalConfigUnlocked(dataDir, await getGlobalConfig(dataDir))
    return { migrated: true, ...inline }
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
