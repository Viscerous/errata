import { z } from 'zod/v4'

export const FragmentIdSchema = z.string().regex(/^[a-z]{2,4}-[a-z0-9]{4,12}$/, {
  message: "Invalid fragment ID format. Must consist of a lowercase type prefix (2-4 letters), a hyphen, and 4-12 lowercase alphanumeric characters (e.g., 'ch-nezeze', 'loca-thehague'). No uppercase letters, spaces, or hyphens inside the suffix are allowed.",
})

export const FRAGMENT_TYPES = ['prose', 'character', 'guideline', 'knowledge', 'image', 'icon', 'marker', 'summary'] as const

export const FragmentTypeSchema = z.string().min(1)

export type FragmentType = z.infer<typeof FragmentTypeSchema>

export const CustomFragmentTypeSchema = z.object({
  type: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(60),
  description: z.string().max(250).default(''),
  icon: z.string().max(40).default('Hash'),
  showInSidebar: z.boolean().default(true),
})

export type CustomFragmentType = z.infer<typeof CustomFragmentTypeSchema>

export const FragmentVersionSchema = z.object({
  version: z.int().min(1),
  name: z.string().max(100),
  description: z.string().max(250),
  content: z.string(),
  createdAt: z.iso.datetime(),
  reason: z.string().optional(),
})

export type FragmentVersion = z.infer<typeof FragmentVersionSchema>

export const FragmentSchema = z.object({
  id: FragmentIdSchema,
  type: FragmentTypeSchema,
  name: z.string().max(100),
  description: z.string().max(250),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  refs: z.array(FragmentIdSchema).default([]),
  sticky: z.boolean().default(false),
  placement: z.enum(['system', 'user']).default('user'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  order: z.int().default(0),
  meta: z.record(z.string(), z.unknown()).default({}),
  archived: z.boolean().default(false),
  version: z.int().min(1).default(1),
  versions: z.array(FragmentVersionSchema).default([]),
})

/** A fragment after schema parsing or storage normalization. */
export type NormalizedFragment = z.infer<typeof FragmentSchema>

/**
 * The domain shape accepted from storage and import paths. Only fields added to
 * legacy records after the original format may be absent before normalization.
 */
export type Fragment = Omit<NormalizedFragment, 'archived' | 'version' | 'versions'> &
  Partial<Pick<NormalizedFragment, 'archived' | 'version' | 'versions'>>

export const StoryMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  coverImage: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  settings: z
    .object({
      outputFormat: z.enum(['plaintext', 'markdown']).default('markdown'),
      enabledPlugins: z.array(z.string()).default([]),
      maxSteps: z.int().min(1).max(50).default(10),
      // Per-generation safety limits for the agent LLM calls. Optional; code
      // applies a sensible default cap (see resolveGenerationGuards) when unset.
      // The cap bounds a runaway/looping generation so it fails fast instead of
      // streaming until the request timeout.
      generationLimits: z.object({
        maxOutputTokens: z.int().min(256).max(32768).optional(),
      }).optional(),
      // Canonical model overrides map: { [roleKey]: { providerId?, modelId? } }
      modelOverrides: z.record(z.string(), z.object({
        providerId: z.string().nullable().optional(),
        modelId: z.string().nullable().optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
      })).default({}),
      // Legacy per-role fields (read for migration, no longer written)
      providerId: z.string().nullable().optional(),
      modelId: z.string().nullable().optional(),
      librarianProviderId: z.string().nullable().optional(),
      librarianModelId: z.string().nullable().optional(),
      characterChatProviderId: z.string().nullable().optional(),
      characterChatModelId: z.string().nullable().optional(),
      proseTransformProviderId: z.string().nullable().optional(),
      proseTransformModelId: z.string().nullable().optional(),
      librarianChatProviderId: z.string().nullable().optional(),
      librarianChatModelId: z.string().nullable().optional(),
      librarianRefineProviderId: z.string().nullable().optional(),
      librarianRefineModelId: z.string().nullable().optional(),
      directionsProviderId: z.string().nullable().optional(),
      directionsModelId: z.string().nullable().optional(),
      generationMode: z.enum(['standard', 'prewriter']).default('standard'),
      // Let the prewriter ask the author clarifying questions before writing.
      // Only takes effect in prewriter mode. Off by default.
      clarifyBeforeGenerate: z.boolean().default(false),
      // How much the prewriter deliberates. 'short' favors speed (terse brief,
      // fewer tool steps), 'extensive' favors depth. Only used in prewriter mode.
      prewriterReasoning: z.enum(['short', 'normal', 'extensive']).default('normal'),
      disableLibrarianAutoAnalysis: z.boolean().default(false),
      autoApplyLibrarianSuggestions: z.boolean().default(false),
      disableLibrarianDirections: z.boolean().default(false),
      disableLibrarianSuggestions: z.boolean().default(false),
      contextOrderMode: z.enum(['simple', 'advanced']).default('simple'),
      fragmentOrder: z.array(z.string()).default([]),
      customFragmentTypes: z.array(CustomFragmentTypeSchema).default([]),
      enabledBuiltinTools: z.array(z.string()).optional(),
      contextCompact: z.object({
        type: z.enum(['proseLimit', 'maxTokens', 'maxCharacters']),
        value: z.number().int().min(1),
      }).default({ type: 'proseLimit', value: 10 }),
      guidedContinuePrompt: z.string().optional(),
      guidedSceneSettingPrompt: z.string().optional(),
      guidedSuggestPrompt: z.string().optional(),
      disableThinking: z.boolean().default(false),
      expandThoughtsByDefault: z.boolean().default(false),
      // erratanet provenance. Absent for purely local stories.
      erratanet: z
        .object({
          // Where this story was installed from (a story pack), if any.
          pack: z.string().optional(),
          version: z.string().optional(),
          // Where this story is published to as a whole story. Drives "sync".
          publishedAs: z.object({ pack: z.string(), version: z.string() }).optional(),
          // Fragment packs published from this story (e.g. a reusable "starter").
          // Each remembers its fragment ids so it can be re-synced as a new version.
          fragmentPacks: z
            .array(
              z.object({
                pack: z.string(),
                version: z.string(),
                fragmentIds: z.array(z.string()).default([]),
              }),
            )
            .optional(),
          // Agent-config packs shared from this story. Each remembers which
          // surfaces it bundled so it can be re-synced as a new version.
          agentConfigs: z
            .array(
              z.object({
                pack: z.string(),
                version: z.string(),
                includes: z.array(z.string()).default([]),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .default({ outputFormat: 'markdown', enabledPlugins: [], maxSteps: 10, modelOverrides: {}, generationMode: 'standard', clarifyBeforeGenerate: false, prewriterReasoning: 'normal', disableLibrarianAutoAnalysis: false, autoApplyLibrarianSuggestions: false, disableLibrarianDirections: false, disableLibrarianSuggestions: false, contextOrderMode: 'simple', fragmentOrder: [], customFragmentTypes: [], enabledBuiltinTools: [], contextCompact: { type: 'proseLimit', value: 10 }, disableThinking: false, expandThoughtsByDefault: false }),
})

export type StoryMeta = z.infer<typeof StoryMetaSchema>

export const AssociationsSchema = z.object({
  tagIndex: z.record(z.string(), z.array(z.string())).default({}),
  refIndex: z.record(z.string(), z.array(z.string())).default({}),
})

export type Associations = z.infer<typeof AssociationsSchema>

// Stored prose chains contain only fragment IDs; the HTTP projection below
// expands those IDs into summaries for the UI.
export const StoredProseChainEntrySchema = z.object({
  proseFragments: z.array(FragmentIdSchema), // All variations/rewrites of this section
  active: FragmentIdSchema, // Currently active variation
})

export type StoredProseChainEntry = z.infer<typeof StoredProseChainEntrySchema>

export const StoredProseChainSchema = z.object({
  entries: z.array(StoredProseChainEntrySchema),
})

export type StoredProseChain = z.infer<typeof StoredProseChainSchema>

export const ProseVariationSummarySchema = z.object({
  id: FragmentIdSchema,
  type: FragmentTypeSchema,
  name: z.string().max(100),
  description: z.string().max(250),
  createdAt: z.iso.datetime(),
  generationMode: z.string().optional(),
})

export type ProseVariationSummary = z.infer<typeof ProseVariationSummarySchema>

export const ProseChainResponseEntrySchema = z.object({
  proseFragments: z.array(ProseVariationSummarySchema),
  active: FragmentIdSchema,
})

export type ProseChainResponseEntry = z.infer<typeof ProseChainResponseEntrySchema>

export const ProseChainResponseSchema = z.object({
  entries: z.array(ProseChainResponseEntrySchema),
})

export type ProseChainResponse = z.infer<typeof ProseChainResponseSchema>

// --- Branch schemas ---

export const BranchMetaSchema = z.object({
  id: z.string(),
  name: z.string().max(100),
  order: z.int().min(0),
  parentBranchId: z.string().optional(),
  forkAfterIndex: z.int().min(0).optional(),
  createdAt: z.iso.datetime(),
})

export type BranchMeta = z.infer<typeof BranchMetaSchema>

export const BranchesIndexSchema = z.object({
  branches: z.array(BranchMetaSchema),
  activeBranchId: z.string(),
  rootBranchId: z.string(),
})

export type BranchesIndex = z.infer<typeof BranchesIndexSchema>
