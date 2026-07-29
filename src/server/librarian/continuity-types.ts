export type TemporalRelation = 'forward' | 'flashback' | 'flash-forward' | 'concurrent' | 'uncertain'

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
