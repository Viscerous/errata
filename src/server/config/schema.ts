import { z } from 'zod/v4'
export { PROVIDER_PRESETS, type PresetId } from '@/contracts/providers'

export const ProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  preset: z.string().default('custom'),
  baseURL: z.string().url(),
  // Local OpenAI-compatible servers commonly require no credential.
  apiKey: z.string(),
  defaultModel: z.string().min(1),
  enabled: z.boolean().default(true),
  customHeaders: z.record(z.string(), z.string()).optional().default({}),
  temperature: z
    .union([z.number().min(0).max(2), z.null()])
    .optional()
    .transform((v) => v ?? undefined),
  createdAt: z.iso.datetime(),
})

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/**
 * Network sharing: optional Basic Auth, LAN exposure, and a cloudflared tunnel.
 * LAN/tunnel are only honored when `authEnabled` is true — never expose the app
 * without a password.
 */
/** Unwrapped so the stored variant below can `.omit()` the password hash off it. */
const SharingConfigObject = z.object({
  /** Gate. LAN + tunnel only take effect when this is on. */
  authEnabled: z.boolean().default(false),
  username: z.string().min(1).default('errata'),
  /** Salted hash as "salt:hash" (scrypt, hex). Empty = no password. Lives in secrets.json. */
  passwordHash: z.string().default(''),
  /** Expose an auth proxy on 0.0.0.0 for local-network access. */
  lanEnabled: z.boolean().default(false),
  /** Run a cloudflared quick tunnel for internet access (HTTPS). */
  tunnelEnabled: z.boolean().default(false),
})

const SHARING_DEFAULTS = {
  authEnabled: false, username: 'errata', passwordHash: '', lanEnabled: false, tunnelEnabled: false,
} as const

export const SharingConfigSchema = SharingConfigObject.default(SHARING_DEFAULTS)

export type SharingConfig = z.infer<typeof SharingConfigSchema>

/**
 * Erratanet hub connection: the pack-sharing hub URL, an auth token, and the
 * resolved account handle. Empty strings mean "not connected".
 */
/** Unwrapped so the stored variant below can `.omit()` the token off it. */
const ErratanetConfigObject = z.object({
  /** Base URL of the erratanet hub. Empty = not configured. */
  hubUrl: z.string().default(''),
  /** Auth token for the hub. Empty = signed out. Lives in secrets.json. */
  token: z.string().default(''),
  /** Resolved account handle once authenticated. */
  handle: z.string().optional(),
  /** ErrataNet is hidden in the UI until the user enables it. */
  enabled: z.boolean().default(false),
  /** Whether the first-run intro prompt has been shown. */
  introSeen: z.boolean().default(false),
})

export const ErratanetConfigSchema = ErratanetConfigObject
  .default({ hubUrl: '', token: '', enabled: false, introSeen: false })

export type ErratanetConfig = z.infer<typeof ErratanetConfigSchema>

export const GlobalConfigSchema = z.object({
  providers: z.array(ProviderConfigSchema).default([]),
  defaultProviderId: z.string().nullable().default(null),
  sharing: SharingConfigSchema,
  erratanet: ErratanetConfigSchema,
})

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>

/*
 * Secrets live in secrets.json, not config.json — so config.json can be handed
 * to someone (a bug report, a synced folder, the updater's backup) without
 * handing over credentials.
 *
 * Both variants below are derived from GlobalConfigSchema rather than restated,
 * so a section added there cannot go missing here. Zod strips unknown keys, so
 * `.omit()` is what actually drops the secret on write.
 */

/** What lands in config.json. The secret fields do not exist on it. */
export const StoredGlobalConfigSchema = GlobalConfigSchema.extend({
  providers: z.array(ProviderConfigSchema.omit({ apiKey: true })).default([]),
  sharing: SharingConfigObject.omit({ passwordHash: true }).default(SHARING_DEFAULTS),
  erratanet: ErratanetConfigObject.omit({ token: true })
    .default({ hubUrl: '', enabled: false, introSeen: false }),
})

/** What lands in secrets.json (0600). */
export const SecretsFileSchema = z.object({
  version: z.literal(1).default(1),
  /** Provider id -> API key. Orphaned ids are pruned on write. */
  providerApiKeys: z.record(z.string(), z.string()).default({}),
  erratanetToken: z.string().default(''),
  sharingPasswordHash: z.string().default(''),
})

export type SecretsFile = z.infer<typeof SecretsFileSchema>

/**
 * The two joined back together — what the rest of the app works with.
 *
 * `apiKey` is laxer here than on {@link ProviderConfigSchema}: a provider whose
 * secret is missing from the store must load as an empty key, not fail the whole
 * read and lock the user out of settings. Input validation stays strict.
 */
export const LoadedGlobalConfigSchema = GlobalConfigSchema.extend({
  providers: z.array(ProviderConfigSchema.extend({ apiKey: z.string().default('') })).default([]),
})
