import { z } from 'zod/v4'
import { LiveStateReportSchema, type FoldedLiveState, type LiveStateRegistryEntry } from './live-state'
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
  // A blank calendar means none was stated, not an invalid calendar.
  calendar: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).max(80).optional(),
  ),
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

/**
 * Threads are reported as a snapshot of what is in the foreground plus what this
 * passage settles; opening and advancing differ only in whether the key was
 * already live.
 */
export const ThreadOperationSchema = z.strictObject({
  threadKey: z.string().trim().min(1).max(100),
  action: z.enum(['open', 'advance', 'resolve']),
  label: z.string().trim().min(1).max(240).optional(),
})

export type ThreadOperation = z.infer<typeof ThreadOperationSchema>

export const ThreadFocusSchema = z.strictObject({
  threadKey: z.string().trim().min(1).max(100),
  visibility: z.enum(['foreground', 'background', 'dormant']),
})

export type ThreadFocus = z.infer<typeof ThreadFocusSchema>

/** A live thread as the analyst may address it: by key, or by its label. */
export interface ThreadRegistryEntry {
  key: string
  label: string
}

export interface ContinuityRegistry {
  thread: ThreadRegistryEntry[]
  /** Live-state items of the subjects shown to the analyst, in rendered order. */
  items: LiveStateRegistryEntry[]
}

export const ContinuityProjectionSchema = z.strictObject({
  version: z.literal(4),
  scene: SceneUpdateSchema,
  // Producer and prompt budgets are policy, not persisted truth invariants.
  threadOperations: z.array(ThreadOperationSchema).default([]),
  /** Sparse prominence updates; omission retains the prior value. */
  threadFocus: z.array(ThreadFocusSchema).default([]),
  /**
   * Characters and entities this passage reports and what changed for them.
   * Those reported present are the scene's roster; everyone else is elsewhere.
   */
  liveStates: z.array(LiveStateReportSchema).max(32).default([]),
})

export type ContinuityProjection = z.infer<typeof ContinuityProjectionSchema>

export interface ProjectionSource {
  sourceFragmentId: string
  analysisId: string
  narrativePosition: number
}

export interface SceneFrame extends ProjectionSource {
  line: 'present' | 'flashback' | 'flash-forward'
  location?: SceneLocation
  time?: NarrativeTime
}

export interface LiveThreadEntry extends ProjectionSource {
  threadKey: string
  label: string
  visibility: 'foreground' | 'background' | 'dormant'
}

export interface ContinuityLedger {
  liveThreads: LiveThreadEntry[]
  liveStates?: FoldedLiveState[]
  currentScene?: SceneFrame
  staleProjectionCount: number
}

export interface ContinuityView {
  liveThreads: LiveThreadEntry[]
  liveStates?: FoldedLiveState[]
  currentScene?: SceneFrame
  staleProjectionCount: number
}
