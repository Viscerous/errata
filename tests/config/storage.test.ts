import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addProvider,
  deleteProvider,
  getGlobalConfig,
  maskApiKey,
  migrateLegacyPlaintextSecrets,
  redactErratanetConfig,
  updateErratanetConfig,
  updateSharingConfig,
} from '@/server/config/storage'
import type { ProviderConfig } from '@/server/config/schema'
import { createTempDir } from '../setup'

describe('global configuration storage', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const temp = await createTempDir()
    dataDir = temp.path
    cleanup = temp.cleanup
  })

  afterEach(async () => cleanup())

  const provider = (id: string): ProviderConfig => ({
    id,
    name: id,
    preset: 'custom',
    baseURL: 'https://example.com/v1',
    apiKey: 'secret',
    defaultModel: 'model',
    enabled: true,
    customHeaders: {},
    temperature: undefined,
    createdAt: new Date().toISOString(),
  })

  it('serializes concurrent provider additions', async () => {
    await Promise.all([
      addProvider(dataDir, provider('provider-a')),
      addProvider(dataDir, provider('provider-b')),
    ])
    const config = await getGlobalConfig(dataDir)
    expect(config.providers.map((entry) => entry.id).sort()).toEqual(['provider-a', 'provider-b'])
  })

  it('does not replace a corrupt config with defaults', async () => {
    const path = join(dataDir, 'config.json')
    await writeFile(path, '{broken', 'utf-8')
    await expect(getGlobalConfig(dataDir)).rejects.toThrow('original file was left untouched')
    await expect(readFile(path, 'utf-8')).resolves.toBe('{broken')
  })

  describe('secret storage', () => {
    const readJson = async (name: string) =>
      JSON.parse(await readFile(join(dataDir, name), 'utf-8')) as Record<string, any>

    it('keeps API keys out of config.json', async () => {
      await addProvider(dataDir, provider('provider-a'))

      const config = await readJson('config.json')
      expect(config.providers[0]).not.toHaveProperty('apiKey')
      expect(JSON.stringify(config)).not.toContain('secret')

      const secrets = await readJson('secrets.json')
      expect(secrets.providerApiKeys).toEqual({ 'provider-a': 'secret' })
    })

    it('keeps the sharing password hash out of config.json', async () => {
      await updateSharingConfig(dataDir, { authEnabled: true, passwordHash: 'salt:hash' })

      const config = await readJson('config.json')
      expect(config.sharing).not.toHaveProperty('passwordHash')
      expect(config.sharing.authEnabled).toBe(true)
      expect(await readJson('secrets.json')).toMatchObject({ sharingPasswordHash: 'salt:hash' })

      const loaded = await getGlobalConfig(dataDir)
      expect(loaded.sharing.passwordHash).toBe('salt:hash')
    })

    it('keeps the erratanet token out of config.json', async () => {
      await updateErratanetConfig(dataDir, { hubUrl: 'https://hub.example', token: 'hub-token' })

      const config = await readJson('config.json')
      expect(config.erratanet).not.toHaveProperty('token')
      expect(config.erratanet.hubUrl).toBe('https://hub.example')
      expect(await readJson('secrets.json')).toMatchObject({ erratanetToken: 'hub-token' })

      const loaded = await getGlobalConfig(dataDir)
      expect(loaded.erratanet.token).toBe('hub-token')
    })

    it('round-trips secrets through the join', async () => {
      await addProvider(dataDir, provider('provider-a'))
      const loaded = await getGlobalConfig(dataDir)
      expect(loaded.providers[0].apiKey).toBe('secret')
    })

    it('drops a deleted provider’s key from the secrets file', async () => {
      await addProvider(dataDir, provider('provider-a'))
      await addProvider(dataDir, provider('provider-b'))
      await deleteProvider(dataDir, 'provider-a')

      const secrets = await readJson('secrets.json')
      expect(Object.keys(secrets.providerApiKeys)).toEqual(['provider-b'])
    })

    it('loads a provider whose secret is missing rather than failing the whole config', async () => {
      await addProvider(dataDir, provider('provider-a'))
      await writeFile(join(dataDir, 'secrets.json'), JSON.stringify({ version: 1 }), 'utf-8')

      const loaded = await getGlobalConfig(dataDir)
      expect(loaded.providers[0].id).toBe('provider-a')
      expect(loaded.providers[0].apiKey).toBe('')
    })

    it('does not silently discard keys when the secrets file is corrupt', async () => {
      await addProvider(dataDir, provider('provider-a'))
      const path = join(dataDir, 'secrets.json')
      await writeFile(path, '{broken', 'utf-8')

      await expect(getGlobalConfig(dataDir)).rejects.toThrow('original file was left untouched')
      await expect(readFile(path, 'utf-8')).resolves.toBe('{broken')
    })
  })

  describe('redaction', () => {
    it('passes every non-secret field through, so a new one cannot silently vanish', () => {
      const config = {
        hubUrl: 'https://hub.example',
        token: 'hub-token',
        handle: 'me',
        enabled: true,
        introSeen: true,
      }

      const redacted = redactErratanetConfig(config)

      // Rebuilt field-by-field, this is where a newly added field would be dropped.
      expect(Object.keys(redacted).sort()).toEqual(Object.keys(config).sort())
      expect(redacted).toMatchObject({ hubUrl: 'https://hub.example', handle: 'me', enabled: true, introSeen: true })
      expect(redacted.token).not.toBe('hub-token')
    })

    it('reports an absent token as absent rather than masking nothing', () => {
      expect(redactErratanetConfig({ hubUrl: '', token: '', enabled: false, introSeen: false }).token).toBe('')
    })

    it('leaves enough of an API key to recognise it', () => {
      expect(maskApiKey('sk-abcdefgh1234')).toBe('••••1234')
      expect(maskApiKey('abc')).toBe('••••')
    })
  })

  describe('migrating a pre-split config', () => {
    /** config.json as it was written before secrets moved to their own file. */
    const writeLegacyConfig = async () => {
      await writeFile(join(dataDir, 'config.json'), JSON.stringify({
        providers: [{ ...provider('legacy-a'), apiKey: 'legacy-key' }],
        defaultProviderId: 'legacy-a',
        sharing: { authEnabled: true, username: 'errata', passwordHash: 'legacy:hash', lanEnabled: true, tunnelEnabled: false },
        erratanet: { hubUrl: 'https://hub.example', token: 'legacy-token', enabled: true, introSeen: true },
      }), 'utf-8')
    }

    const NOTHING_TO_DO = {
      migrated: false, providerKeys: 0, erratanetToken: false, sharingPasswordHash: false,
    }

    it('reads inline secrets before it has migrated', async () => {
      await writeLegacyConfig()
      const loaded = await getGlobalConfig(dataDir)
      expect(loaded.providers[0].apiKey).toBe('legacy-key')
      expect(loaded.erratanet.token).toBe('legacy-token')
      expect(loaded.sharing.passwordHash).toBe('legacy:hash')
    })

    it('moves them out and leaves no plaintext behind', async () => {
      await writeLegacyConfig()

      expect(await migrateLegacyPlaintextSecrets(dataDir)).toEqual({
        migrated: true, providerKeys: 1, erratanetToken: true, sharingPasswordHash: true,
      })

      const raw = await readFile(join(dataDir, 'config.json'), 'utf-8')
      expect(raw).not.toContain('legacy-key')
      expect(raw).not.toContain('legacy-token')
      expect(raw).not.toContain('legacy:hash')

      // Everything still resolves, and non-secret settings are preserved.
      const loaded = await getGlobalConfig(dataDir)
      expect(loaded.providers[0].apiKey).toBe('legacy-key')
      expect(loaded.sharing).toMatchObject({ passwordHash: 'legacy:hash', authEnabled: true, lanEnabled: true })
      expect(loaded.erratanet).toMatchObject({
        token: 'legacy-token',
        hubUrl: 'https://hub.example',
        enabled: true,
        introSeen: true,
      })
    })

    it('is idempotent and a no-op once there is nothing inline', async () => {
      await writeLegacyConfig()
      await migrateLegacyPlaintextSecrets(dataDir)

      expect(await migrateLegacyPlaintextSecrets(dataDir)).toEqual(NOTHING_TO_DO)
    })

    it('is a no-op on a fresh install', async () => {
      expect(await migrateLegacyPlaintextSecrets(dataDir)).toEqual(NOTHING_TO_DO)
    })
  })
})
