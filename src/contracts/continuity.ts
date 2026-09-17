import { z } from 'zod/v4'
import { FragmentIdSchema } from './story'

export const AnalysisSourceRevisionSchema = z.strictObject({
  contentHash: z.string().min(1),
  fragmentVersion: z.number().int().positive().optional(),
  updatedAt: z.iso.datetime(),
})

export type AnalysisSourceRevision = z.infer<typeof AnalysisSourceRevisionSchema>

const citedEvidenceShape = {
  evidenceSegments: z.array(z.number().int().positive()).max(32),
  evidenceText: z.string(),
}

export const CitedEvidenceSchema = z.strictObject(citedEvidenceShape)
export type CitedEvidence = z.infer<typeof CitedEvidenceSchema>

export const SceneTransitionKindSchema = z.enum([
  'continue',
  'advance',
  'cut',
  'enter-flashback',
  'enter-flash-forward',
  'return',
  'uncertain',
])

export type SceneTransitionKind = z.infer<typeof SceneTransitionKindSchema>

const resolvedInstantSchema = z.string().trim().max(80)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Resolved time bounds must be parseable absolute instants.')

const narrativeTimeShape = {
  label: z.string().trim().min(1).max(200),
  certainty: z.enum(['exact', 'bounded', 'approximate', 'unknown']),
  calendar: z.string().trim().min(1).max(80).optional(),
  earliest: resolvedInstantSchema.optional(),
  latest: resolvedInstantSchema.optional(),
}

type NarrativeTimeBounds = Pick<z.infer<z.ZodObject<typeof narrativeTimeShape>>, 'earliest' | 'latest'>

function validateNarrativeTimeBounds(time: NarrativeTimeBounds, ctx: z.RefinementCtx<NarrativeTimeBounds>): void {
  if (time.earliest && time.latest && Date.parse(time.earliest) > Date.parse(time.latest)) {
    ctx.addIssue({ code: 'custom', path: ['latest'], message: 'The latest bound cannot precede the earliest bound.' })
  }
}

/** Human wording is canonical; resolved bounds are optional machine knowledge. */
export const NarrativeTimeSchema = z.strictObject(narrativeTimeShape)
  .superRefine(validateNarrativeTimeBounds)

export type NarrativeTime = z.infer<typeof NarrativeTimeSchema>

/** Forgiving producer boundary; persistence still validates the strict schema. */
export const NarrativeTimeInputSchema = z.object({
  label: z.string().trim().min(1).max(200)
    .describe('Descriptive story time (e.g. "early morning", "three days later", "at dusk").'),
  certainty: narrativeTimeShape.certainty.default('unknown'),
  calendar: z.string().trim().min(1).max(80).optional(),
})

const narrativeDurationShape = {
  label: z.string().trim().min(1).max(160),
  minimumSeconds: z.number().nonnegative().optional(),
  maximumSeconds: z.number().nonnegative().optional(),
}

type NarrativeDurationBounds = Pick<z.infer<z.ZodObject<typeof narrativeDurationShape>>, 'minimumSeconds' | 'maximumSeconds'>

function validateNarrativeDurationBounds(
  duration: NarrativeDurationBounds,
  ctx: z.RefinementCtx<NarrativeDurationBounds>,
): void {
  if (duration.minimumSeconds !== undefined
    && duration.maximumSeconds !== undefined
    && duration.minimumSeconds > duration.maximumSeconds) {
    ctx.addIssue({ code: 'custom', path: ['maximumSeconds'], message: 'The maximum duration cannot be shorter than the minimum.' })
  }
}

export const NarrativeDurationSchema = z.strictObject(narrativeDurationShape)
  .superRefine(validateNarrativeDurationBounds)

export type NarrativeDuration = z.infer<typeof NarrativeDurationSchema>

/** Forgiving producer boundary; persistence still validates the strict schema. */
export const NarrativeDurationInputSchema = z.object(narrativeDurationShape)
  .superRefine(validateNarrativeDurationBounds)

const sceneLocationShape = {
  key: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(160),
  fragmentId: FragmentIdSchema.optional(),
}

export const SceneLocationSchema = z.strictObject(sceneLocationShape)

export type SceneLocation = z.infer<typeof SceneLocationSchema>

/** Forgiving producer boundary; persistence still validates the strict schema. */
export const SceneLocationInputSchema = z.object({
  key: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(160),
  fragmentId: z.string().trim().max(64).optional(),
})

/**
 * Transition and resulting-frame data are separate: `cut` is an operation;
 * "late afternoon in the archive" is state.
 */
export const SceneUpdateSchema = z.strictObject({
  transition: SceneTransitionKindSchema,
  /** Resulting narrative line, only when this passage changes or establishes it. */
  line: z.enum(['present', 'flashback', 'flash-forward', 'uncertain']).optional(),
  location: SceneLocationSchema.optional(),
  time: NarrativeTimeSchema.optional(),
  elapsed: NarrativeDurationSchema.optional(),
  evidenceSegments: citedEvidenceShape.evidenceSegments.optional(),
  evidenceText: citedEvidenceShape.evidenceText.optional(),
}).superRefine((scene, ctx) => {
  if ((scene.evidenceSegments === undefined) !== (scene.evidenceText === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Scene evidence segments and text must be stored together.' })
  }
  if (scene.transition === 'enter-flashback' && scene.line !== 'flashback') {
    ctx.addIssue({ code: 'custom', path: ['line'], message: 'Entering a flashback must result in the flashback line.' })
  }
  if (scene.transition === 'enter-flash-forward' && scene.line !== 'flash-forward') {
    ctx.addIssue({ code: 'custom', path: ['line'], message: 'Entering a flash-forward must result in the flash-forward line.' })
  }
})

export type SceneUpdate = z.infer<typeof SceneUpdateSchema>

export const StateSubjectSchema = z.strictObject({
  key: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(160),
  fragmentId: FragmentIdSchema.optional(),
})

export type StateSubject = z.infer<typeof StateSubjectSchema>

export const StateScopeSchema = z.enum(['scene', 'cross-scene'])
export type StateScope = z.infer<typeof StateScopeSchema>

const stateOperationBaseShape = {
  ...citedEvidenceShape,
  stateKey: z.string().trim().min(1).max(100),
}

export const StateSetOperationSchema = z.strictObject({
  ...stateOperationBaseShape,
  action: z.literal('set'),
  subject: StateSubjectSchema,
  facet: z.string().trim().min(1).max(100),
  /** Distinguishes simultaneous values of one facet, such as two injuries. */
  slot: z.string().trim().min(1).max(100).optional(),
  value: z.string().trim().min(1).max(300),
  certainty: z.enum(['explicit', 'implied']),
  /** Scene is the ordinary case; cross-scene is an explicit durable claim. */
  scope: StateScopeSchema,
  /** Optional story-time expiry for a cross-scene condition. */
  until: NarrativeTimeSchema.optional(),
})

export type StateSetOperation = z.infer<typeof StateSetOperationSchema>

export const StateClearOperationSchema = z.strictObject({
  ...stateOperationBaseShape,
  action: z.literal('clear'),
})

export type StateClearOperation = z.infer<typeof StateClearOperationSchema>

export const StateOperationSchema = z.discriminatedUnion('action', [
  StateSetOperationSchema,
  StateClearOperationSchema,
])

export type StateOperation = z.infer<typeof StateOperationSchema>

export const ThreadOperationSchema = z.strictObject({
  ...citedEvidenceShape,
  threadKey: z.string().trim().min(1).max(100),
  action: z.enum(['open', 'advance', 'resolve', 'abandon']),
  label: z.string().trim().min(1).max(240).optional(),
  note: z.string().trim().min(1).max(300).optional(),
  relatedFragmentIds: z.array(FragmentIdSchema).max(20),
})

export type ThreadOperation = z.infer<typeof ThreadOperationSchema>

export const ThreadFocusSchema = z.strictObject({
  threadKey: z.string().trim().min(1).max(100),
  visibility: z.enum(['foreground', 'background', 'dormant']),
})

export type ThreadFocus = z.infer<typeof ThreadFocusSchema>

/** One live identity, numbered so an operation can address it exactly. */
export interface RegistryEntry {
  index: number
  key: string
  label: string
  detail?: string
  /** Character id for knowledge, whose keys are scoped per character. */
  scope?: string
  /** Exact structured identity, present only for state-lane entries. */
  subject?: StateSubject
  facet?: string
  slot?: string
}

export interface ContinuityRegistry {
  state: RegistryEntry[]
  thread: RegistryEntry[]
  knowledge: RegistryEntry[]
}

export const KnowledgeOperationSchema = z.strictObject({
  ...citedEvidenceShape,
  characterId: FragmentIdSchema,
  knowledgeKey: z.string().trim().min(1).max(100),
  action: z.enum(['learn', 'correct', 'forget']),
  fact: z.string().trim().min(1).max(400).optional(),
  acquisition: z.enum(['witnessed', 'told', 'inferred', 'other']),
})

export type KnowledgeOperation = z.infer<typeof KnowledgeOperationSchema>

export const CharacterLiveStateSchema = z.strictObject({
  characterId: FragmentIdSchema.optional(),
  name: z.string().trim().min(1).max(160),
  /** Immediate kinetic/tactile beat (overwritten each scene). E.g. "tense posture; catching breath after sprint" */
  immediate: z.string().trim().max(300).optional(),
  /** Persistent dynamic keys (survives until explicitly modified or cleared). E.g. attire, injuries, gear, wings */
  state: z.record(z.string().trim().min(1).max(100), z.string().trim().max(500)).optional(),
  /** Facts learned, witnessed, or deduced in this scene */
  knowledge: z.array(z.string().trim().max(500)).optional(),
  /** Secrets withheld, active deceptions, or unrevealed goals */
  secrets: z.array(z.string().trim().max(500)).optional(),
})

export type CharacterLiveState = z.infer<typeof CharacterLiveStateSchema>

export const EntityLiveStateSchema = z.strictObject({
  entityId: FragmentIdSchema.optional(),
  name: z.string().trim().min(1).max(160),
  category: z.enum(['location', 'artefact', 'faction', 'other']).optional(),
  immediate: z.string().trim().max(300).optional(),
  state: z.record(z.string().trim().min(1).max(100), z.string().trim().max(500)).optional(),
  notes: z.array(z.string().trim().max(500)).optional(),
})

export type EntityLiveState = z.infer<typeof EntityLiveStateSchema>

export const stateKeyValuePairSchema = z.object({
  key: z.string().trim().min(1).max(100),
  value: z.string().trim().max(500),
})

// Grammar-safe sparse state: GBNF (llama.cpp's default PEG generator) cannot
// bound the key count of an object with free-form additionalProperties, so an
// unbounded z.record leaves an open key loop in the tool grammar that weak
// models degenerate into. A bounded array of key/value pairs expresses the
// same dictionary while staying grammatically finite; the forgiving
// preprocess still accepts plain records from non-grammar clients.
export function forgivingDynamicState() {
  return z.preprocess((val) => {
    if (val === null || val === undefined) return []
    if (Array.isArray(val)) return val
    if (typeof val === 'object') {
      return Object.entries(val as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => ({ key: String(k), value: String(v) }))
    }
    return []
  }, z.array(stateKeyValuePairSchema).max(32))
}

export function forgivingStringArray(maxLen = 500, options?: { min?: number; max?: number }) {
  let arr = z.array(z.string().trim().max(maxLen))
  if (options?.min !== undefined) arr = arr.min(options.min)
  if (options?.max !== undefined) arr = arr.max(options.max)
  return z.preprocess((val) => {
    if (val === null || val === undefined) return []
    if (Array.isArray(val)) {
      return val
        .map((v) => (v === null || v === undefined ? '' : String(v)))
        .filter((s) => s.trim().length > 0)
    }
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'n/a') return []
      return [trimmed]
    }
    return []
  }, arr)
}

export const CharacterLiveStateInputSchema = z.object({
  id: z.string().trim().max(64).optional(),
  characterId: z.string().trim().max(64).optional(),
  // Optional so a model that cites the catalog id need not restate the name;
  // normalization resolves it from the delivered character record.
  name: z.string().trim().min(1).max(160).optional(),
  immediate: z.string().trim().max(300).optional()
    .describe('Immediate kinetic/tactile beat right now (e.g. "tense posture; catching breath against the wall").'),
  state: forgivingDynamicState().optional()
    .describe('Sparse dynamic state as key/value pairs, e.g. [{"key":"weapon","value":"broken"}]. Note ONLY important physical or gear changes of note (e.g. broken weapon, acquired item, severe injury). Omit or leave empty [] if no changes occurred in this passage. Do not record mundane inventory.'),
  knowledge: forgivingStringArray(500, { max: 12 }).default([]).optional()
    .describe('New facts learned, witnessed, or deduced in this scene. Omit or leave empty [] if none.'),
  secrets: forgivingStringArray(500, { max: 12 }).default([]).optional()
    .describe('Active deceptions, hidden motives, or withheld truths. Omit or leave empty [] if none.'),
})

export type CharacterLiveStateInput = z.infer<typeof CharacterLiveStateInputSchema>

export const EntityLiveStateInputSchema = z.object({
  id: z.string().trim().max(64).optional(),
  entityId: z.string().trim().max(64).optional(),
  // Optional so a model that cites the catalog id need not restate the name;
  // normalization resolves it from the delivered record.
  name: z.string().trim().min(1).max(160).optional(),
  category: z.enum(['location', 'artefact', 'faction', 'other']).optional(),
  immediate: z.string().trim().max(300).optional()
    .describe('Immediate kinetic or visual state in this scene.'),
  state: forgivingDynamicState().optional()
    .describe('Sparse dynamic state as key/value pairs for notable entity changes, e.g. [{"key":"condition","value":"damaged"}]. Omit or leave empty [] if no changes.'),
  notes: forgivingStringArray(500, { max: 12 }).default([]).optional(),
})

export type EntityLiveStateInput = z.infer<typeof EntityLiveStateInputSchema>

export const ContinuityProjectionSchema = z.strictObject({
  version: z.literal(2),
  scene: SceneUpdateSchema,
  // Producer and prompt budgets are policy, not persisted truth invariants.
  stateOperations: z.array(StateOperationSchema).default([]),
  threadOperations: z.array(ThreadOperationSchema).default([]),
  /** Sparse prominence updates; omission retains the prior value. */
  threadFocus: z.array(ThreadFocusSchema).default([]),
  knowledgeOperations: z.array(KnowledgeOperationSchema).default([]),
  characterStates: z.record(z.string(), CharacterLiveStateSchema).optional(),
  entityStates: z.record(z.string(), EntityLiveStateSchema).optional(),
})

export type ContinuityProjection = z.infer<typeof ContinuityProjectionSchema>

export interface ProjectionSource {
  sourceFragmentId: string
  analysisId: string
  narrativePosition: number
}

export interface CurrentStateEntry extends ProjectionSource {
  stateKey: string
  subject: StateSubject
  facet: string
  slot?: string
  value: string
  certainty: 'explicit' | 'implied'
  scope: StateScope
  until?: NarrativeTime
}

export interface SceneFrame extends ProjectionSource {
  line: 'present' | 'flashback' | 'flash-forward'
  location?: SceneLocation
  time?: NarrativeTime
}

export interface LiveThreadEntry extends ProjectionSource {
  threadKey: string
  label: string
  note?: string
  relatedFragmentIds: string[]
  visibility: 'foreground' | 'background' | 'dormant'
}

export interface CharacterKnowledgeEntry extends ProjectionSource {
  characterId: string
  knowledgeKey: string
  fact: string
  acquisition: 'witnessed' | 'told' | 'inferred' | 'other'
}

export interface FoldedCharacterLiveState extends ProjectionSource {
  characterId?: string
  name: string
  immediate?: string
  state: Record<string, string>
  knowledge: string[]
  secrets: string[]
}

export interface FoldedEntityLiveState extends ProjectionSource {
  entityId?: string
  name: string
  category?: 'location' | 'artefact' | 'faction' | 'other'
  immediate?: string
  state: Record<string, string>
  notes: string[]
}

export interface ContinuityLedger {
  currentState: CurrentStateEntry[]
  liveThreads: LiveThreadEntry[]
  characterKnowledge: CharacterKnowledgeEntry[]
  characterStates?: FoldedCharacterLiveState[]
  entityStates?: FoldedEntityLiveState[]
  currentScene?: SceneFrame
  staleProjectionCount: number
}

export interface ContinuityView {
  currentState: CurrentStateEntry[]
  liveThreads: LiveThreadEntry[]
  characterKnowledge: CharacterKnowledgeEntry[]
  characterStates?: FoldedCharacterLiveState[]
  entityStates?: FoldedEntityLiveState[]
  currentScene?: SceneFrame
  staleProjectionCount: number
}
