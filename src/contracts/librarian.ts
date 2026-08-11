import type { AnalysisSourceRevision, ContinuityProjection } from './continuity'
import type {
  AppliedChange,
  FragmentChangeOperation,
  OperationValidation,
  RevertResult,
} from './fragment-changes'

export type LibrarianCandidateSource = 'current-observation' | 'writer-context'

export interface LibrarianCandidateFragment {
  fragmentId: string
  sources: LibrarianCandidateSource[]
  reasons?: string[]
  score?: number
}

export type LibrarianMention = { fragmentId: string; text: string }

export type LibrarianAnalyzeLaneRequirement = 'required' | 'conditional' | 'disabled'
export type LibrarianAnalyzeLaneCompletion = 'complete' | 'not-needed' | 'incomplete' | 'disabled'

export interface LibrarianAnalyzeLaneStatus {
  observation: {
    requirement: 'required'
    completion: Exclude<LibrarianAnalyzeLaneCompletion, 'not-needed' | 'disabled'>
  }
  recordMaintenance: {
    requirement: 'conditional' | 'disabled'
    completion: LibrarianAnalyzeLaneCompletion
  }
  directions: {
    requirement: 'required' | 'disabled'
    completion: Exclude<LibrarianAnalyzeLaneCompletion, 'not-needed'>
  }
}

export interface LibrarianPassRecord {
  name: 'observe' | 'proposal' | 'directions' | 'audit' | string
  status: 'complete' | 'skipped' | 'failed'
  startedAt: string
  durationMs?: number
  modelId?: string
  stepCount?: number
  finishReason?: string
  reason?: string
  error?: string
  diagnostics?: Record<string, unknown>
}

export interface LibrarianContradiction {
  description: string
  fragmentIds: string[]
  /** User-reviewed findings remain historical but no longer count as active. */
  dismissed?: boolean
  dismissedAt?: string
  sourceEvidenceText?: string
  conflictingEvidence?: Array<{
    fragmentId: string
    segments?: number[]
    evidenceText: string
  }>
}

export interface LibrarianDirection {
  title: string
  description: string
  instruction: string
}

export interface LibrarianFragmentChangeProposal {
  title?: string
  rationale?: string
  /** Which online maintenance lane queued this proposal. */
  proposalKind?: 'correction' | 'new-fragment'
  /** Sentence numbers the analyst cited in the accepted prose. */
  evidenceSegments?: number[]
  /** Those sentences resolved to exact text, for review and unattended re-checking. */
  evidenceText?: string
  /** Positive eligibility argument supplied by the analyst. */
  eligibilityReason?: string
  /** Set only after the online-analysis contract passes its structural safety gates. */
  autoApplySafe?: boolean
  operations: FragmentChangeOperation[]
  validation: OperationValidation[]
  sourceFragmentId?: string
  accepted?: boolean
  autoApplied?: boolean
  dismissed?: boolean
  /** Pre-apply validation failed against current state; revives if a revert makes it valid again. */
  stale?: boolean
  staleReason?: string
  appliedResults?: OperationValidation[]
  appliedChanges?: AppliedChange[]
  reverted?: boolean
  revertedAt?: string
  revertResults?: RevertResult[]
}

export interface LibrarianAnalysis {
  id: string
  createdAt: string
  fragmentId: string
  /** Material source fingerprint used to reject stale derived continuity. */
  sourceRevision?: AnalysisSourceRevision
  /** The summary text the librarian intended to record. */
  summaryUpdate: string
  summaryContractVersion?: number
  continuityProjection?: ContinuityProjection
  mentions: LibrarianMention[]
  candidateFragmentIds?: string[]
  candidateFragments?: LibrarianCandidateFragment[]
  contradictions: LibrarianContradiction[]
  fragmentChangeProposals: LibrarianFragmentChangeProposal[]
  /**
   * The passage's events, placed by its temporal frame. Derived, not reported.
   * Records written before the frame owned this also carry a `during` position.
   */
  timelineEvents: Array<{
    event: string
    position: 'before' | 'after'
  }>
  directions?: LibrarianDirection[]
  analyzeLanes?: LibrarianAnalyzeLaneStatus
  passes?: LibrarianPassRecord[]
  trace?: Array<{
    type: string
    [key: string]: unknown
  }>
}

export interface LibrarianAnalysisSummary {
  id: string
  createdAt: string
  fragmentId: string
  contradictionCount: number
  suggestionCount: number
  pendingSuggestionCount: number
  timelineEventCount: number
  directionsCount: number
  hasTrace?: boolean
  /** Source prose changed after this analysis, so its continuity is not folded. */
  continuityStale?: boolean
}

export interface StoredLibrarianState {
  lastAnalyzedFragmentId: string | null
  recentMentions: Record<string, string[]>
  timeline: Array<{ event: string; fragmentId: string }>
}

export type LibrarianRunStatus = 'idle' | 'scheduled' | 'running' | 'error'

export interface LibrarianRuntimeStatus {
  runStatus: LibrarianRunStatus
  pendingFragmentId: string | null
  runningFragmentId: string | null
  lastError: string | null
  updatedAt: string
}

export type LibrarianStatusResponse = StoredLibrarianState & LibrarianRuntimeStatus

export interface LibrarianAcceptChangeProposalResponse {
  analysis: LibrarianAnalysis
  appliedResults: OperationValidation[]
  appliedChanges: AppliedChange[]
  createdFragmentIds: string[]
  updatedFragmentIds: string[]
  archivedFragmentIds: string[]
  readFragmentIds: string[]
}

export interface LibrarianRevertChangeProposalResponse {
  analysis: LibrarianAnalysis
  revertResults: RevertResult[]
  updatedFragmentIds: string[]
  archivedFragmentIds: string[]
  restoredFragmentIds: string[]
}
