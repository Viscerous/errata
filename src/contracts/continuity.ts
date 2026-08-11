/**
 * Whether a passage advances the narrative present or steps outside it. There is
 * deliberately no value for "set during an ongoing in-story event": every one of
 * the eight `concurrent` frames on record meant that and none meant simultaneity
 * with the present, so the passage's `anchor` is the only home for it.
 */
export type TemporalRelation = 'forward' | 'flashback' | 'flash-forward' | 'uncertain'

export interface AnalysisSourceRevision {
  contentHash: string
  fragmentVersion?: number
  updatedAt: string
}

/**
 * Evidence is recorded as both the sentence numbers the analyst cited and the
 * exact text they resolved to. The citation is what the model produced; the
 * text is what makes a saved projection reviewable and re-checkable after the
 * source prose has moved on.
 */
export interface CitedEvidence {
  evidenceSegments: number[]
  evidenceText: string
}

export interface TemporalFrame extends Partial<CitedEvidence> {
  relation: TemporalRelation
  anchor?: string
}

export interface StateOperation extends CitedEvidence {
  stateKey: string
  action: 'set' | 'clear'
  subject: string
  value?: string
}

export interface ThreadOperation extends CitedEvidence {
  threadKey: string
  action: 'open' | 'advance' | 'resolve' | 'abandon'
  label?: string
  note?: string
  relatedFragmentIds: string[]
}

export interface ThreadFocus {
  threadKey: string
  visibility: 'foreground' | 'background'
}

/**
 * One live identity, numbered so an operation can point at it instead of
 * spelling it. The number is the addressing scheme, so the block the analyst
 * reads and the tool it writes back through must be built from one list.
 */
export interface RegistryEntry {
  /** 1-based within its lane; the model sees this number. */
  index: number
  key: string
  /** Human-readable identity, matched as a fallback when no number is cited. */
  label: string
  /** The lane's extra column: a state value, a thread's focus, a fact's knower. */
  detail?: string
  /** Character id for knowledge, whose keys are scoped per character. */
  scope?: string
}

export interface ContinuityRegistry {
  state: RegistryEntry[]
  thread: RegistryEntry[]
  knowledge: RegistryEntry[]
}

export interface KnowledgeOperation extends CitedEvidence {
  characterId: string
  knowledgeKey: string
  action: 'learn' | 'correct' | 'forget'
  fact?: string
  acquisition: 'witnessed' | 'told' | 'inferred' | 'other'
}

export interface ContinuityProjection {
  version: 1
  temporalFrame: TemporalFrame
  stateOperations: StateOperation[]
  threadOperations: ThreadOperation[]
  /**
   * Snapshot of the still-open threads relevant to the scene after this prose.
   * Any live thread omitted from the latest snapshot is dormant, not resolved.
   */
  threadFocus: ThreadFocus[]
  knowledgeOperations: KnowledgeOperation[]
}
