import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getContentRoot } from '../fragments/branches'
import { getFragment } from '../fragments/storage'
import { proseContentHash } from './continuity-source'
import { generateConversationId } from '@/lib/fragment-ids'
import { writeJsonAtomic } from '../fs-utils'
import { withKeyLock } from '../async-lock'
import type { FragmentChangeOperation, OperationValidation } from '../fragments/change-operations'
import type { AppliedChange, AppliedFieldChange, RevertResult } from '../fragments/change-apply'
import type {
  LibrarianAnalysis as SharedLibrarianAnalysis,
  LibrarianAnalysisSummary,
  LibrarianPassRecord,
  StoredLibrarianState,
} from '@/contracts/librarian'

export type {
  LibrarianAnalysisSummary,
  LibrarianAnalyzeLaneCompletion,
  LibrarianAnalyzeLaneRequirement,
  LibrarianAnalyzeLaneStatus,
  LibrarianMention,
  LibrarianPassRecord,
} from '@/contracts/librarian'

/**
 * The librarian analysis proposals reuse the shared apply/revert snapshot types.
 * Aliased here so existing references (and the client type mirror) keep their
 * librarian-flavoured names while the shape lives in one place.
 */
export type LibrarianAppliedFieldChange = AppliedFieldChange
export type LibrarianAppliedProposalChange = AppliedChange
export type LibrarianProposalRevertResult = RevertResult

/** Serializes read-modify-write of a story's analysis index against concurrent saves. */
function withIndexLock<T>(storyId: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`librarian-index:${storyId}`, fn)
}

// --- Types ---

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
  /**
   * Set only after the online-analysis contract passes its structural safety
   * gates. Required for unattended application.
   */
  autoApplySafe?: boolean
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

export type LibrarianAnalysis = SharedLibrarianAnalysis<LibrarianFragmentChangeProposal>

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

/** Compatibility name for the on-disk state shape. */
export type LibrarianState = StoredLibrarianState

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

const MAX_ANALYSIS_READ_CACHE_ENTRIES = 512
const analysisReadCache = new Map<string, Promise<LibrarianAnalysis | null>>()

function cloneAnalysis(analysis: LibrarianAnalysis | null): LibrarianAnalysis | null {
  return analysis ? structuredClone(analysis) : null
}

function cacheAnalysisRead(path: string, pending: Promise<LibrarianAnalysis | null>): void {
  analysisReadCache.delete(path)
  analysisReadCache.set(path, pending)
  while (analysisReadCache.size > MAX_ANALYSIS_READ_CACHE_ENTRIES) {
    const oldest = analysisReadCache.keys().next().value
    if (typeof oldest !== 'string') break
    analysisReadCache.delete(oldest)
  }
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
  const path = await analysisPath(dataDir, storyId, analysis.id)
  await writeJsonAtomic(
    path,
    analysis,
  )
  cacheAnalysisRead(path, Promise.resolve(cloneAnalysis(analysis)))

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
  const cached = analysisReadCache.get(path)
  if (cached) {
    cacheAnalysisRead(path, cached)
    return cloneAnalysis(await cached)
  }

  const pending = (async () => {
    if (!existsSync(path)) return null
    const raw = await readFile(path, 'utf-8')
    return normalizeAnalysis(JSON.parse(raw))
  })()
  cacheAnalysisRead(path, pending)
  try {
    return cloneAnalysis(await pending)
  } catch (error) {
    if (analysisReadCache.get(path) === pending) analysisReadCache.delete(path)
    throw error
  }
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
  analysisReadCache.delete(path)

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

/**
 * The panel polls this list every five seconds, and the counts it needs are a
 * few integers off each analysis — but the analysis file also carries the whole
 * agent trace, which is most of its bulk. Re-reading and re-parsing all of it on
 * every poll cost 28ms across 5.3MB on a 36-analysis branch, growing linearly
 * with the story, for rows that had not changed.
 *
 * Files are written atomically and never mutated in place, so size and mtime
 * settle the question of whether a parse can be skipped. `continuityStale` is
 * deliberately not cached: it compares the analysis against the *live* prose,
 * which moves without the analysis file changing at all.
 */
interface CachedAnalysisSummary {
  signature: string
  summary: LibrarianAnalysisSummary
  /** Present only when the analysis carries a projection worth staleness-checking. */
  projectionContentHash: string | null
}

const MAX_SUMMARY_CACHE_ENTRIES = 512
const summaryCache = new Map<string, CachedAnalysisSummary>()

async function readAnalysisSummary(path: string): Promise<CachedAnalysisSummary> {
  const stats = await stat(path)
  const signature = `${stats.mtimeMs}:${stats.size}`
  const cached = summaryCache.get(path)
  if (cached?.signature === signature) return cached

  const analysis = normalizeAnalysis(JSON.parse(await readFile(path, 'utf-8')))
  const entry: CachedAnalysisSummary = {
    signature,
    summary: {
      id: analysis.id,
      createdAt: analysis.createdAt,
      fragmentId: analysis.fragmentId,
      contradictionCount: analysis.contradictions.filter((contradiction) => !contradiction.dismissed).length,
      suggestionCount: analysis.fragmentChangeProposals.length,
      pendingSuggestionCount: analysis.fragmentChangeProposals.filter((s) => !s.accepted && !s.dismissed).length,
      timelineEventCount: analysis.timelineEvents.length,
      directionsCount: analysis.directions?.length ?? 0,
      hasTrace: !!analysis.trace?.length,
    },
    projectionContentHash: analysis.sourceRevision && analysis.continuityProjection
      ? analysis.sourceRevision.contentHash
      : null,
  }

  summaryCache.set(path, entry)
  while (summaryCache.size > MAX_SUMMARY_CACHE_ENTRIES) {
    const oldest = summaryCache.keys().next().value
    if (typeof oldest !== 'string') break
    summaryCache.delete(oldest)
  }
  return entry
}

export async function listAnalyses(
  dataDir: string,
  storyId: string,
): Promise<LibrarianAnalysisSummary[]> {
  const dir = await analysesDir(dataDir, storyId)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const summaries: LibrarianAnalysisSummary[] = []
  const sourceHashes = new Map<string, string | null>()

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const { summary, projectionContentHash } = await readAnalysisSummary(join(dir, entry))

    let continuityStale = false
    if (projectionContentHash) {
      if (!sourceHashes.has(summary.fragmentId)) {
        const source = await getFragment(dataDir, storyId, summary.fragmentId)
        sourceHashes.set(summary.fragmentId, source ? proseContentHash(source) : null)
      }
      const hash = sourceHashes.get(summary.fragmentId)
      continuityStale = hash != null && hash !== projectionContentHash
    }

    summaries.push(continuityStale ? { ...summary, continuityStale } : summary)
  }

  // Sort newest first
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return summaries
}

export async function getState(
  dataDir: string,
  storyId: string,
): Promise<StoredLibrarianState> {
  const path = await statePath(dataDir, storyId)
  if (!existsSync(path)) {
    return {
      lastAnalyzedFragmentId: null,
      recentMentions: {},
      timeline: [],
    }
  }
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as StoredLibrarianState
}

export async function saveState(
  dataDir: string,
  storyId: string,
  state: StoredLibrarianState,
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
