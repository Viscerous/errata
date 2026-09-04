import { z } from 'zod/v4'
import { FragmentIdSchema } from './story'

export const AnalysisSourceRevisionSchema = z.strictObject({
  contentHash: z.string().min(1),
  fragmentVersion: z.number().int().positive().optional(),
  updatedAt: z.iso.datetime(),
})

export type AnalysisSourceRevision = z.infer<typeof AnalysisSourceRevisionSchema>

const citedEvidenceShape = {
  evidenceSegments: z.array(z.number().int().positive()).max(8),
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
  ...narrativeTimeShape,
  certainty: narrativeTimeShape.certainty.default('unknown'),
}).superRefine(validateNarrativeTimeBounds)

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
export const SceneLocationInputSchema = z.object(sceneLocationShape)

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

export const ContinuityProjectionSchema = z.strictObject({
  version: z.literal(2),
  scene: SceneUpdateSchema,
  // Producer and prompt budgets are policy, not persisted truth invariants.
  stateOperations: z.array(StateOperationSchema),
  threadOperations: z.array(ThreadOperationSchema),
  /** Sparse prominence updates; omission retains the prior value. */
  threadFocus: z.array(ThreadFocusSchema),
  knowledgeOperations: z.array(KnowledgeOperationSchema),
})

export type ContinuityProjection = z.infer<typeof ContinuityProjectionSchema>
