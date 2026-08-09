import type { AnalysisSourceRevision, ContinuityProjection } from './continuity'

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

export interface LibrarianAnalysis<TFragmentChangeProposal> {
  id: string
  createdAt: string
  fragmentId: string
  /** Material source fingerprint used to reject stale derived continuity. */
  sourceRevision?: AnalysisSourceRevision
  /** The summary text the librarian intended to record. */
  summaryUpdate: string
  summaryContractVersion?: number
  structuredSummary?: {
    events: string[]
    stateChanges: string[]
    openThreads: string[]
  }
  continuityProjection?: ContinuityProjection
  mentions: LibrarianMention[]
  candidateFragmentIds?: string[]
  candidateFragments?: LibrarianCandidateFragment[]
  contradictions: LibrarianContradiction[]
  fragmentChangeProposals: TFragmentChangeProposal[]
  timelineEvents: Array<{
    event: string
    position: 'before' | 'during' | 'after'
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
