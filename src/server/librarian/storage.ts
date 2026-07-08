import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getContentRoot } from '../fragments/branches'
import { generateConversationId } from '@/lib/fragment-ids'
import { writeJsonAtomic } from '../fs-utils'
import { withKeyLock } from '../async-lock'
import type { EditableField, FragmentChangeOperation, OperationValidation } from '../fragments/change-operations'
import type { MergedFragmentCandidate } from './candidates'

/** Serializes read-modify-write of a story's analysis index against concurrent saves. */
function withIndexLock<T>(storyId: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`librarian-index:${storyId}`, fn)
}

// --- Types ---

export interface LibrarianFragmentChangeProposal {
  title?: string
  rationale?: string
  operations: FragmentChangeOperation[]
  validation: OperationValidation[]
  sourceFragmentId?: string
  accepted?: boolean
  autoApplied?: boolean
  dismissed?: boolean
  /** Pre-apply validation failed against current state; renders as dismissed but revives if a revert makes it valid again. */
  stale?: boolean
  staleReason?: string
  appliedResults?: OperationValidation[]
  appliedChanges?: LibrarianAppliedProposalChange[]
  reverted?: boolean
  revertedAt?: string
  revertResults?: LibrarianProposalRevertResult[]
}

export interface LibrarianAppliedFieldChange {
  before: string
  after: string
}

export type LibrarianAppliedProposalChange =
  | {
      kind: 'create'
      fragmentId: string
      afterHash: string
      fields: Partial<Record<EditableField, LibrarianAppliedFieldChange>>
    }
  | {
      kind: 'update'
      fragmentId: string
      beforeHash: string
      afterHash: string
      fields: Partial<Record<EditableField, LibrarianAppliedFieldChange>>
      addedRefs?: string[]
      previousLastLibrarianChangeProposal?: unknown
    }
  | {
      kind: 'archive'
      fragmentId: string
      beforeHash: string
      afterHash: string
    }

export interface LibrarianProposalRevertResult {
  kind: LibrarianAppliedProposalChange['kind']
  fragmentId: string
  status: 'reverted' | 'skipped'
  message?: string
}

export interface LibrarianAnalysis {
  id: string
  createdAt: string
  fragmentId: string
  /** The summary text the librarian intended to record (intent). */
  summaryUpdate: string
  /**
   * ID of the summary fragment this analysis contributed to (artifact).
   * Set when the deferred-summary application creates or appends to a
   * chapter summary fragment. Undefined for legacy analyses written before
   * summary fragments existed.
   */
  summaryFragmentId?: string
  structuredSummary?: {
    events: string[]
    stateChanges: string[]
    openThreads: string[]
  }
  mentions: LibrarianMention[]
  candidateFragmentIds?: string[]
  candidateFragments?: MergedFragmentCandidate[]
  contradictions: Array<{
    description: string
    fragmentIds: string[]
  }>
  fragmentChangeProposals: LibrarianFragmentChangeProposal[]
  timelineEvents: Array<{
    event: string
    position: 'before' | 'during' | 'after'
  }>
  directions?: Array<{
    title: string
    description: string
    instruction: string
  }>
  passes?: LibrarianPassRecord[]
  trace?: Array<{
    type: string
    [key: string]: unknown
  }>
}

export type LibrarianMention = { fragmentId: string; text: string }

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

export function passRecord(params: {
  name: LibrarianPassRecord['name']
  status: LibrarianPassRecord['status']
  startedAt: string
  durationMs?: number
  modelId?: string
  stepCount?: number
  finishReason?: string
  reason?: string
  error?: string
  diagnostics?: Record<string, unknown>
}): LibrarianPassRecord {
  return {
    name: params.name,
    status: params.status,
    startedAt: params.startedAt,
    ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.stepCount !== undefined ? { stepCount: params.stepCount } : {}),
    ...(params.finishReason ? { finishReason: params.finishReason } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.error ? { error: params.error } : {}),
    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
  }
}

export function selectLatestAnalysesByFragment(
  summaries: LibrarianAnalysisSummary[],
): Map<string, LibrarianAnalysisSummary> {
  const latest = new Map<string, LibrarianAnalysisSummary>()

  for (const summary of summaries) {
    const prev = latest.get(summary.fragmentId)
    if (!prev) {
      latest.set(summary.fragmentId, summary)
      continue
    }

    if (
      summary.createdAt > prev.createdAt
      || (summary.createdAt === prev.createdAt && summary.id > prev.id)
    ) {
      latest.set(summary.fragmentId, summary)
    }
  }

  return latest
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
}

export interface LibrarianState {
  lastAnalyzedFragmentId: string | null
  /** Fragment ID up to which analysis summaries have been applied to summary fragments. */
  summarizedUpTo: string | null
  recentMentions: Record<string, string[]>
  timeline: Array<{ event: string; fragmentId: string }>
}

export interface LibrarianAnalysisIndexEntry {
  analysisId: string
  createdAt: string
}

export interface LibrarianAnalysisIndex {
  version: 1
  updatedAt: string
  latestByFragmentId: Record<string, LibrarianAnalysisIndexEntry>
  appliedSummarySequence?: string[]
}

export interface LibrarianBackfillJob {
  id: string
  storyId: string
  createdAt: string
  updatedAt: string
  status: 'queued' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled'
  fragmentIds: string[]
  cursor: number
  completedFragmentIds: string[]
  failedFragments: Array<{
    fragmentId: string
    error: string
    at: string
  }>
  options?: {
    source?: 'import' | 'historical' | 'manual'
  }
  lastAnalysisId?: string
  error?: string
}

// --- Path helpers ---

async function librarianDir(dataDir: string, storyId: string): Promise<string> {
  const root = await getContentRoot(dataDir, storyId)
  return join(root, 'librarian')
}

async function analysesDir(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'analyses')
}

async function analysisPath(dataDir: string, storyId: string, analysisId: string): Promise<string> {
  const dir = await analysesDir(dataDir, storyId)
  return join(dir, `${analysisId}.json`)
}

async function statePath(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'state.json')
}

async function analysisIndexPath(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'index.json')
}

async function backfillJobsDir(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'backfill-jobs')
}

async function backfillJobPath(dataDir: string, storyId: string, jobId: string): Promise<string> {
  const dir = await backfillJobsDir(dataDir, storyId)
  return join(dir, `${jobId}.json`)
}

function shouldReplaceIndexEntry(
  previous: LibrarianAnalysisIndexEntry | undefined,
  incoming: { createdAt: string; analysisId: string },
): boolean {
  if (!previous) return true
  if (incoming.createdAt > previous.createdAt) return true
  if (incoming.createdAt < previous.createdAt) return false
  return incoming.analysisId > previous.analysisId
}

function defaultAnalysisIndex(): LibrarianAnalysisIndex {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    latestByFragmentId: {},
  }
}

async function saveAnalysisIndex(
  dataDir: string,
  storyId: string,
  index: LibrarianAnalysisIndex,
): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(await analysisIndexPath(dataDir, storyId), index)
}

export async function getAnalysisIndex(
  dataDir: string,
  storyId: string,
): Promise<LibrarianAnalysisIndex | null> {
  const path = await analysisIndexPath(dataDir, storyId)
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<LibrarianAnalysisIndex>
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    latestByFragmentId: parsed.latestByFragmentId ?? {},
    appliedSummarySequence: Array.isArray(parsed.appliedSummarySequence) ? parsed.appliedSummarySequence : undefined,
  }
}

function analysisSummaryToIndexEntry(summary: LibrarianAnalysisSummary): LibrarianAnalysisIndexEntry {
  return {
    analysisId: summary.id,
    createdAt: summary.createdAt,
  }
}

export async function rebuildAnalysisIndex(
  dataDir: string,
  storyId: string,
): Promise<LibrarianAnalysisIndex> {
  const summaries = await listAnalyses(dataDir, storyId)
  const latest = selectLatestAnalysesByFragment(summaries)
  const rebuilt: LibrarianAnalysisIndex = defaultAnalysisIndex()
  for (const [fragmentId, summary] of latest.entries()) {
    rebuilt.latestByFragmentId[fragmentId] = analysisSummaryToIndexEntry(summary)
  }
  rebuilt.updatedAt = new Date().toISOString()
  await saveAnalysisIndex(dataDir, storyId, rebuilt)
  return rebuilt
}

export async function clearAnalysisIndexEntry(
  dataDir: string,
  storyId: string,
  fragmentId: string,
): Promise<void> {
  await withIndexLock(storyId, async () => {
    const index = await getAnalysisIndex(dataDir, storyId)
    if (!index) return
    if (!(fragmentId in index.latestByFragmentId)) return
    delete index.latestByFragmentId[fragmentId]
    index.updatedAt = new Date().toISOString()
    await saveAnalysisIndex(dataDir, storyId, index)
  })
}

export async function getLatestAnalysisIdsByFragment(
  dataDir: string,
  storyId: string,
): Promise<Map<string, string>> {
  const index = await getAnalysisIndex(dataDir, storyId) ?? await rebuildAnalysisIndex(dataDir, storyId)
  return new Map(
    Object.entries(index.latestByFragmentId)
      .map(([fragmentId, entry]) => [fragmentId, entry.analysisId]),
  )
}

// --- Storage functions ---

export async function saveAnalysis(
  dataDir: string,
  storyId: string,
  analysis: LibrarianAnalysis,
): Promise<void> {
  const dir = await analysesDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(
    await analysisPath(dataDir, storyId, analysis.id),
    analysis,
  )

  // Index read-modify-write must be serialized: concurrent saves would each read
  // the same index and the later write would drop the earlier entry.
  await withIndexLock(storyId, async () => {
    const currentIndex = await getAnalysisIndex(dataDir, storyId) ?? defaultAnalysisIndex()
    const previous = currentIndex.latestByFragmentId[analysis.fragmentId]
    if (shouldReplaceIndexEntry(previous, { createdAt: analysis.createdAt, analysisId: analysis.id })) {
      currentIndex.latestByFragmentId[analysis.fragmentId] = {
        analysisId: analysis.id,
        createdAt: analysis.createdAt,
      }
    }
    currentIndex.updatedAt = new Date().toISOString()
    await saveAnalysisIndex(dataDir, storyId, currentIndex)
  })
}

export async function getAnalysis(
  dataDir: string,
  storyId: string,
  analysisId: string,
): Promise<LibrarianAnalysis | null> {
  const path = await analysisPath(dataDir, storyId, analysisId)
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  return normalizeAnalysis(JSON.parse(raw))
}

function normalizeAnalysis(data: Record<string, unknown>): LibrarianAnalysis {
  const analysis = data as unknown as LibrarianAnalysis
  if (!analysis.fragmentChangeProposals) {
    analysis.fragmentChangeProposals = []
  }
  return analysis
}

export async function deleteAnalysis(
  dataDir: string,
  storyId: string,
  analysisId: string,
): Promise<boolean> {
  const path = await analysisPath(dataDir, storyId, analysisId)
  if (!existsSync(path)) return false

  // Read the analysis to get fragmentId for index cleanup
  const raw = await readFile(path, 'utf-8')
  const analysis = normalizeAnalysis(JSON.parse(raw))

  await unlink(path)

  // Clean up index entry if it points to this analysis
  await withIndexLock(storyId, async () => {
    const index = await getAnalysisIndex(dataDir, storyId)
    if (index) {
      const entry = index.latestByFragmentId[analysis.fragmentId]
      if (entry && entry.analysisId === analysisId) {
        delete index.latestByFragmentId[analysis.fragmentId]
        index.updatedAt = new Date().toISOString()
        await saveAnalysisIndex(dataDir, storyId, index)
      }
    }
  })

  return true
}

export async function listAnalyses(
  dataDir: string,
  storyId: string,
): Promise<LibrarianAnalysisSummary[]> {
  const dir = await analysesDir(dataDir, storyId)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const summaries: LibrarianAnalysisSummary[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const raw = await readFile(join(dir, entry), 'utf-8')
    const analysis = normalizeAnalysis(JSON.parse(raw))
    const suggestionCount = analysis.fragmentChangeProposals.length
    const pendingSuggestionCount = analysis.fragmentChangeProposals.filter((s) => !s.accepted && !s.dismissed).length

    summaries.push({
      id: analysis.id,
      createdAt: analysis.createdAt,
      fragmentId: analysis.fragmentId,
      contradictionCount: analysis.contradictions.length,
      suggestionCount,
      pendingSuggestionCount,
      timelineEventCount: analysis.timelineEvents.length,
      directionsCount: analysis.directions?.length ?? 0,
      hasTrace: !!analysis.trace?.length,
    })
  }

  // Sort newest first
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return summaries
}

export async function getState(
  dataDir: string,
  storyId: string,
): Promise<LibrarianState> {
  const path = await statePath(dataDir, storyId)
  if (!existsSync(path)) {
    return {
      lastAnalyzedFragmentId: null,
      summarizedUpTo: null,
      recentMentions: {},
      timeline: [],
    }
  }
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as LibrarianState
}

export async function saveState(
  dataDir: string,
  storyId: string,
  state: LibrarianState,
): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(await statePath(dataDir, storyId), state)
}

// --- Backfill jobs ---

function normalizeBackfillJob(data: Record<string, unknown>): LibrarianBackfillJob {
  const job = data as unknown as LibrarianBackfillJob
  return {
    ...job,
    status: job.status ?? 'queued',
    fragmentIds: Array.isArray(job.fragmentIds) ? job.fragmentIds : [],
    cursor: Number.isInteger(job.cursor) ? job.cursor : 0,
    completedFragmentIds: Array.isArray(job.completedFragmentIds) ? job.completedFragmentIds : [],
    failedFragments: Array.isArray(job.failedFragments) ? job.failedFragments : [],
  }
}

export async function saveBackfillJob(
  dataDir: string,
  storyId: string,
  job: LibrarianBackfillJob,
): Promise<void> {
  const dir = await backfillJobsDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  job.storyId = storyId
  job.updatedAt = new Date().toISOString()
  await writeJsonAtomic(await backfillJobPath(dataDir, storyId, job.id), job)
}

export async function getBackfillJob(
  dataDir: string,
  storyId: string,
  jobId: string,
): Promise<LibrarianBackfillJob | null> {
  const path = await backfillJobPath(dataDir, storyId, jobId)
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  return normalizeBackfillJob(JSON.parse(raw))
}

export async function listBackfillJobs(
  dataDir: string,
  storyId: string,
): Promise<LibrarianBackfillJob[]> {
  const dir = await backfillJobsDir(dataDir, storyId)
  if (!existsSync(dir)) return []
  const entries = await readdir(dir)
  const jobs: LibrarianBackfillJob[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const raw = await readFile(join(dir, entry), 'utf-8')
    jobs.push(normalizeBackfillJob(JSON.parse(raw)))
  }
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return jobs
}

// --- Chat history ---

export interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
}

export interface ChatHistory {
  messages: ChatHistoryMessage[]
  updatedAt: string
}

async function chatHistoryPath(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'chat-history.json')
}

export async function getChatHistory(
  dataDir: string,
  storyId: string,
): Promise<ChatHistory> {
  const path = await chatHistoryPath(dataDir, storyId)
  if (!existsSync(path)) {
    return { messages: [], updatedAt: new Date().toISOString() }
  }
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as ChatHistory
}

export async function saveChatHistory(
  dataDir: string,
  storyId: string,
  messages: ChatHistoryMessage[],
): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  const history: ChatHistory = {
    messages,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(await chatHistoryPath(dataDir, storyId), history)
}

export async function clearChatHistory(
  dataDir: string,
  storyId: string,
): Promise<void> {
  const path = await chatHistoryPath(dataDir, storyId)
  if (existsSync(path)) {
    await unlink(path)
  }
}

// --- Conversations ---

export interface ConversationMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

interface ConversationsIndex {
  conversations: ConversationMeta[]
}

async function conversationsIndexPath(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'conversations.json')
}

function conversationHistoryPath(dir: string, conversationId: string): string {
  return join(dir, `chat-${conversationId}.json`)
}

async function readConversationsIndex(dataDir: string, storyId: string): Promise<ConversationsIndex> {
  const path = await conversationsIndexPath(dataDir, storyId)
  if (!existsSync(path)) return { conversations: [] }
  const raw = await readFile(path, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<ConversationsIndex>
  return { conversations: parsed.conversations ?? [] }
}

async function writeConversationsIndex(dataDir: string, storyId: string, index: ConversationsIndex): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(await conversationsIndexPath(dataDir, storyId), index)
}

export async function listConversations(dataDir: string, storyId: string): Promise<ConversationMeta[]> {
  const index = await readConversationsIndex(dataDir, storyId)
  // Most recently updated first
  return index.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function createConversation(dataDir: string, storyId: string, title: string): Promise<ConversationMeta> {
  const index = await readConversationsIndex(dataDir, storyId)
  const now = new Date().toISOString()
  const conversation: ConversationMeta = {
    id: generateConversationId(),
    title,
    createdAt: now,
    updatedAt: now,
  }
  index.conversations.push(conversation)
  await writeConversationsIndex(dataDir, storyId, index)
  return conversation
}

export async function updateConversationTitle(
  dataDir: string,
  storyId: string,
  conversationId: string,
  title: string,
): Promise<ConversationMeta | null> {
  const index = await readConversationsIndex(dataDir, storyId)
  const conv = index.conversations.find(c => c.id === conversationId)
  if (!conv) return null
  conv.title = title
  conv.updatedAt = new Date().toISOString()
  await writeConversationsIndex(dataDir, storyId, index)
  return conv
}

export async function deleteConversation(dataDir: string, storyId: string, conversationId: string): Promise<boolean> {
  const index = await readConversationsIndex(dataDir, storyId)
  const idx = index.conversations.findIndex(c => c.id === conversationId)
  if (idx === -1) return false
  index.conversations.splice(idx, 1)
  await writeConversationsIndex(dataDir, storyId, index)
  // Delete history file
  const dir = await librarianDir(dataDir, storyId)
  const historyFile = conversationHistoryPath(dir, conversationId)
  if (existsSync(historyFile)) await unlink(historyFile)
  return true
}

export async function getConversationHistory(
  dataDir: string,
  storyId: string,
  conversationId: string,
): Promise<ChatHistory> {
  const dir = await librarianDir(dataDir, storyId)
  const path = conversationHistoryPath(dir, conversationId)
  if (!existsSync(path)) return { messages: [], updatedAt: new Date().toISOString() }
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as ChatHistory
}

export async function saveConversationHistory(
  dataDir: string,
  storyId: string,
  conversationId: string,
  messages: ChatHistoryMessage[],
): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  const history: ChatHistory = { messages, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(conversationHistoryPath(dir, conversationId), history)
  // Update conversation timestamp
  const index = await readConversationsIndex(dataDir, storyId)
  const conv = index.conversations.find(c => c.id === conversationId)
  if (conv) {
    conv.updatedAt = history.updatedAt
    // Auto-title from first user message if still default
    if (conv.title === 'New chat' && messages.length > 0) {
      const firstUser = messages.find(m => m.role === 'user')
      if (firstUser) conv.title = firstUser.content.slice(0, 60).trim() || 'New chat'
    }
    await writeConversationsIndex(dataDir, storyId, index)
  }
}
