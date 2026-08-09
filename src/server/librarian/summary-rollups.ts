import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolLoopAgent, stepCountIs, tool } from 'ai'
import { z } from 'zod/v4'
import { getContentRoot, getScopedBranchId, withBranch } from '../fragments/branches'
import { getFragment, getStory } from '../fragments/storage'
import { getActiveProseIds } from '../fragments/prose-chain'
import { writeJsonAtomic } from '../fs-utils'
import { withKeyLock } from '../async-lock'
import { createLogger } from '../logging'
import { drainAgentStream } from '../agents/drain-agent-stream'
import { buildProviderOptions, resolveAgentRuntime } from '../llm/client'
import { resolveAndReportServedUsage } from '../llm/usage-normalizer'
import { getObservedServedModelId } from '../llm/served-models'
import { proseContentHash } from './continuity-source'
import { getAnalysis, getAnalysisIndex } from './storage'
import { SUMMARY_CONTRACT_VERSION } from './summary-projection'
import { DEFAULT_TOOL_LOOP_IDLE_TIMEOUT_MS, terminalToolSucceeded } from './tool-runner'

export const SUMMARY_ROLLUP_CONTRACT_VERSION = 2
export const SUMMARY_ROLLUP_FANOUT = 6
export const SUMMARY_ROLLUP_MAX_TEXT_CHARS = 2400

/**
 * Room for the record (~700 tokens at the character cap) plus its title and
 * tool-call envelope, with headroom so an overshoot still closes the call rather
 * than truncating mid-argument. The previous 1024 sat *below* the character cap,
 * putting the schema limit out of reach.
 */
const SUMMARY_ROLLUP_MAX_OUTPUT_TOKENS = 1536

export interface SummaryRollupLeaf {
  id: string
  proseId: string
  analysisId: string
  sourceHash: string
  summaryHash: string
  contractVersion: number
  text: string
}

export interface SummaryRollupNode {
  id: string
  level: number
  childIds: string[]
  leafIds: string[]
  coverageStart: string
  coverageEnd: string
  title: string
  text: string
  contractVersion: number
  modelConfigKey: string
  tokenCount: number
  artifactHash: string
  createdAt: string
}

export interface SummaryRollupFrontierItem {
  node: SummaryRollupNode
  startIndex: number
  endIndex: number
}

type RollupInput = SummaryRollupLeaf | SummaryRollupNode

interface NodeLocation {
  segment: string | number
  start: number
  end: number
}

const logger = createLogger('summary-rollups')

const ROLLUP_TOOL_NAME = 'recordRollup'
const UNOBSERVED_MODEL_ID = '__unobserved_in_this_process__'

/**
 * Reported through a tool rather than parsed out of free text, so the shape
 * reaches the model as a schema it is decoded against — grammar-constrained on
 * llama.cpp, structured output elsewhere. A malformed record stops being
 * something the call can produce, and an over-long one comes back as a tool
 * error the model can correct.
 */
const rollupInputSchema = z.object({
  title: z.string().trim().min(1).max(120)
    .describe('A short retrospective label for the whole interval, such as "The dike held through the flood".'),
  text: z.string().trim().min(1).max(SUMMARY_ROLLUP_MAX_TEXT_CHARS)
    .describe(`The compressed record, at most ${SUMMARY_ROLLUP_MAX_TEXT_CHARS} characters.`),
})

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export function summaryRollupLeafId(input: {
  proseId: string
  analysisId: string
  sourceHash: string
  summary: string
  contractVersion: number
}): string {
  return `sl-${hash(stableJson({
    proseId: input.proseId,
    analysisId: input.analysisId,
    sourceHash: input.sourceHash,
    summaryHash: hash(input.summary.trim()),
    contractVersion: input.contractVersion,
  }))}`
}

async function rollupsDir(dataDir: string, storyId: string): Promise<string> {
  return join(await getContentRoot(dataDir, storyId), 'librarian', 'summary-rollups')
}

const nodeCache = new Map<string, SummaryRollupNode[]>()

async function rollupsPath(dataDir: string, storyId: string): Promise<string> {
  return join(await rollupsDir(dataDir, storyId), 'index.json')
}

export async function listSummaryRollupNodes(dataDir: string, storyId: string): Promise<SummaryRollupNode[]> {
  const path = await rollupsPath(dataDir, storyId)
  const cached = nodeCache.get(path)
  if (cached) return structuredClone(cached)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { nodes?: SummaryRollupNode[] }
    const nodes = (parsed.nodes ?? []).filter((node) => node?.id && node.level > 0 && Array.isArray(node.leafIds))
    nodeCache.set(path, nodes)
    return structuredClone(nodes)
  } catch {
    // A corrupt cache index is equivalent to a miss; source material remains authoritative.
    return []
  }
}

async function saveSummaryRollupNode(dataDir: string, storyId: string, node: SummaryRollupNode): Promise<void> {
  const dir = await rollupsDir(dataDir, storyId)
  const path = join(dir, 'index.json')
  await mkdir(dir, { recursive: true })
  await withKeyLock(`summary-rollups:${path}`, async () => {
    let nodes: SummaryRollupNode[] = []
    if (existsSync(path)) {
      try {
        nodes = ((JSON.parse(await readFile(path, 'utf8')) as { nodes?: SummaryRollupNode[] }).nodes ?? [])
      } catch {
        nodes = []
      }
    }
    const existing = nodes.findIndex((candidate) => candidate.id === node.id)
    if (existing >= 0) nodes[existing] = node
    else nodes.push(node)
    await writeJsonAtomic(path, { version: 1, nodes })
    nodeCache.set(path, nodes)
  })
}

async function replaceSummaryRollupNodes(dataDir: string, storyId: string, nodes: SummaryRollupNode[]): Promise<void> {
  const dir = await rollupsDir(dataDir, storyId)
  const path = join(dir, 'index.json')
  await mkdir(dir, { recursive: true })
  await withKeyLock(`summary-rollups:${path}`, async () => {
    await writeJsonAtomic(path, { version: 1, nodes })
    nodeCache.set(path, nodes)
  })
}

async function currentLeafSegments(dataDir: string, storyId: string): Promise<SummaryRollupLeaf[][]> {
  const index = await getAnalysisIndex(dataDir, storyId)
  const segments: SummaryRollupLeaf[][] = []
  let current: SummaryRollupLeaf[] = []
  const flush = () => {
    if (current.length > 0) segments.push(current)
    current = []
  }

  for (const proseId of await getActiveProseIds(dataDir, storyId)) {
    const fragment = await getFragment(dataDir, storyId, proseId)
    if (!fragment || fragment.type === 'marker') {
      flush()
      continue
    }
    const analysisId = index?.latestByFragmentId[proseId]?.analysisId
    const analysis = analysisId ? await getAnalysis(dataDir, storyId, analysisId) : null
    const summary = analysis?.summaryUpdate?.trim()
    const sourceHash = proseContentHash(fragment)
    if (
      !analysisId
      || !analysis
      || !summary
      || analysis.summaryContractVersion !== SUMMARY_CONTRACT_VERSION
      || analysis.sourceRevision?.contentHash !== sourceHash
    ) {
      flush()
      continue
    }
    current.push({
      id: summaryRollupLeafId({
        proseId,
        analysisId,
        sourceHash,
        summary,
        contractVersion: analysis.summaryContractVersion,
      }),
      proseId,
      analysisId,
      sourceHash,
      summaryHash: hash(summary),
      contractVersion: analysis.summaryContractVersion,
      text: summary,
    })
  }
  flush()
  return segments
}

function equalIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function validateNodeLocations<T extends NodeLocation>(
  nodes: SummaryRollupNode[],
  located: Map<string, T>,
): Map<string, T> {
  const valid = new Map<string, T>()
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of [...nodes].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))) {
    const location = located.get(node.id)
    if (!location || node.childIds.length !== SUMMARY_ROLLUP_FANOUT) continue
    if (node.level === 1) {
      if (node.leafIds.length === SUMMARY_ROLLUP_FANOUT && equalIds(node.childIds, node.leafIds)) {
        valid.set(node.id, location)
      }
      continue
    }
    const children = node.childIds.map((id) => byId.get(id))
    if (children.some((child) => !child)) continue
    const typedChildren = children as SummaryRollupNode[]
    if (typedChildren.some((child) => (
      child.level !== node.level - 1
      || child.modelConfigKey !== node.modelConfigKey
      || !valid.has(child.id)
    ))) continue
    const childLocations = typedChildren.map((child) => valid.get(child.id)!)
    if (childLocations.some((childLocation, index) => (
      childLocation.segment !== location.segment
      || (index > 0 && childLocations[index - 1].end + 1 !== childLocation.start)
    ))) continue
    const leaves = typedChildren.flatMap((child) => child.leafIds)
    if (
      equalIds(leaves, node.leafIds)
      && location.start === childLocations[0].start
      && location.end === childLocations.at(-1)!.end
    ) valid.set(node.id, location)
  }
  return valid
}

function currentNodeLocations(
  segments: SummaryRollupLeaf[][],
  nodes: SummaryRollupNode[],
  modelConfigKey?: string,
): Map<string, NodeLocation> {
  const located = new Map<string, NodeLocation>()
  for (let segment = 0; segment < segments.length; segment += 1) {
    const ids = segments[segment].map((leaf) => leaf.id)
    const starts = new Map<string, number[]>()
    ids.forEach((id, index) => starts.set(id, [...(starts.get(id) ?? []), index]))
    for (const node of nodes) {
      if (
        node.contractVersion !== SUMMARY_ROLLUP_CONTRACT_VERSION
        || (modelConfigKey && node.modelConfigKey !== modelConfigKey)
      ) continue
      for (const start of starts.get(node.leafIds[0]) ?? []) {
        if (node.leafIds.every((id, offset) => ids[start + offset] === id)) {
          located.set(node.id, { segment, start, end: start + node.leafIds.length - 1 })
          break
        }
      }
    }
  }
  return validateNodeLocations(nodes, located)
}

function planRollup(
  segments: SummaryRollupLeaf[][],
  nodes: SummaryRollupNode[],
  modelConfigKey: string,
): { level: number; children: RollupInput[] } | null {
  const locations = currentNodeLocations(segments, nodes, modelConfigKey)
  const currentNodes = nodes.filter((node) => locations.has(node.id))

  // Fill uncovered level-0 intervals first. Existing exact intervals remain
  // anchors, so an insertion does not repartition every later node.
  for (let segment = 0; segment < segments.length; segment += 1) {
    const leaves = segments[segment]
    const covered = new Set<number>()
    for (const node of currentNodes.filter((candidate) => candidate.level === 1)) {
      const location = locations.get(node.id)!
      if (location.segment !== segment) continue
      for (let i = location.start; i <= location.end; i += 1) covered.add(i)
    }
    for (let start = 0; start + SUMMARY_ROLLUP_FANOUT <= leaves.length; start += 1) {
      const indexes = Array.from({ length: SUMMARY_ROLLUP_FANOUT }, (_, offset) => start + offset)
      if (indexes.some((index) => covered.has(index))) continue
      return { level: 1, children: leaves.slice(start, start + SUMMARY_ROLLUP_FANOUT) }
    }
  }

  const maxLevel = currentNodes.reduce((max, node) => Math.max(max, node.level), 0)
  for (let childLevel = 1; childLevel <= maxLevel; childLevel += 1) {
    for (let segment = 0; segment < segments.length; segment += 1) {
      const candidates = currentNodes
        .filter((node) => node.level === childLevel && locations.get(node.id)?.segment === segment)
        .sort((a, b) => locations.get(a.id)!.start - locations.get(b.id)!.start || a.id.localeCompare(b.id))
      const parentChildIds = new Set(
        currentNodes.filter((node) => node.level === childLevel + 1).flatMap((node) => node.childIds),
      )
      for (let start = 0; start + SUMMARY_ROLLUP_FANOUT <= candidates.length; start += 1) {
        const children = candidates.slice(start, start + SUMMARY_ROLLUP_FANOUT)
        if (children.some((child) => parentChildIds.has(child.id))) continue
        const contiguous = children.every((child, index) => index === 0
          || locations.get(children[index - 1].id)!.end + 1 === locations.get(child.id)!.start)
        if (contiguous) return { level: childLevel + 1, children }
      }
    }
  }
  return null
}

function nodeIdentity(level: number, children: RollupInput[], modelConfigKey: string): string {
  const childKeys = level === 1
    ? (children as SummaryRollupLeaf[]).map((child) => ({
        proseId: child.proseId,
        analysisId: child.analysisId,
        sourceHash: child.sourceHash,
        summaryHash: child.summaryHash,
        contractVersion: child.contractVersion,
      }))
    : (children as SummaryRollupNode[]).map((child) => ({
        childNodeId: child.id,
        childArtifactHash: child.artifactHash,
      }))
  return `sr-${hash(stableJson({ level, childKeys, contractVersion: SUMMARY_ROLLUP_CONTRACT_VERSION, modelConfigKey }))}`
}

function rollupModelConfigKey(runtime: {
  providerId: string | null
  temperature?: number
}, modelId: string): string {
  return hash(stableJson({
    providerId: runtime.providerId,
    modelId,
    temperature: runtime.temperature ?? null,
  }))
}

const ROLLUP_INSTRUCTIONS = `Compress the ordered child story-memory records into one retrospective record, then report it by calling ${ROLLUP_TOOL_NAME}.

- Write in perfect-aspect historical register ("the gate had opened"), never present tense.
- Preserve causality, the named participants, and every thread still unresolved at the end of the interval.
- Deduplicate only within these children. Do not add facts and do not speculate about what follows.
- The record must be shorter than the children it replaces, and at most ${SUMMARY_ROLLUP_MAX_TEXT_CHARS} characters.
- The title labels the interval in retrospect; it is not a chapter heading.`

export async function runSummaryRollupMaintenance(dataDir: string, storyId: string): Promise<SummaryRollupNode | null> {
  return runSummaryRollupMaintenanceInner(dataDir, storyId, true)
}

async function runSummaryRollupMaintenanceInner(
  dataDir: string,
  storyId: string,
  allowIdentityRetry: boolean,
): Promise<SummaryRollupNode | null> {
  const story = await getStory(dataDir, storyId)
  if (!story || story.settings.disableLibrarianAutoAnalysis === true) return null
  const runtime = await resolveAgentRuntime(dataDir, storyId, 'librarian', story)
  // Keyed on what was last served, not what the story asked for: this key has to
  // identify the weights, and a configured id does not. The thinking toggle is
  // deliberately absent — roll-ups always run with reasoning off (see below), so
  // keying on it would evict every node whenever the story toggles it.
  const observedModelId = getObservedServedModelId(runtime.providerId, runtime.modelId)
  // A process restart is also a possible local-model swap. Until one response
  // identifies what is currently behind the endpoint, plan from leaves under a
  // sentinel that can never be persisted or collide with an older model's tree.
  const planningModelConfigKey = rollupModelConfigKey(
    runtime,
    observedModelId ?? UNOBSERVED_MODEL_ID,
  )
  const segments = await currentLeafSegments(dataDir, storyId)
  let nodes = await listSummaryRollupNodes(dataDir, storyId)
  const currentLocations = currentNodeLocations(segments, nodes)
  if (currentLocations.size !== nodes.length) {
    nodes = nodes.filter((node) => currentLocations.has(node.id))
    await replaceSummaryRollupNodes(dataDir, storyId, nodes)
  }
  const plan = planRollup(segments, nodes, planningModelConfigKey)
  if (!plan) return null

  const plannedId = nodeIdentity(plan.level, plan.children, planningModelConfigKey)
  const existing = nodes.find((node) => node.id === plannedId)
  if (existing) return existing
  const childPayload = plan.children.map((child, index) => ({
    order: index + 1,
    title: 'title' in child ? child.title : `Passage ${child.proseId}`,
    text: child.text,
  }))
  const prompt = JSON.stringify({ children: childPayload })
  const agent = new ToolLoopAgent({
    model: runtime.model,
    instructions: ROLLUP_INSTRUCTIONS,
    tools: {
      [ROLLUP_TOOL_NAME]: tool({
        description: 'Report the single compressed record covering all of the child records.',
        inputSchema: rollupInputSchema,
        execute: async () => ({ ok: true }),
      }),
    },
    toolChoice: 'required' as const,
    // One repair round, which is what the analysis lane shows a rejected tool
    // call reliably needs.
    stopWhen: [terminalToolSucceeded(ROLLUP_TOOL_NAME), stepCountIs(2)],
    temperature: runtime.temperature,
    // Compression, not deliberation. Reasoning stays off whatever the story
    // setting says: with it on, the output budget is spent before the record is
    // reached, which is how this tier produced nothing at all.
    providerOptions: buildProviderOptions(true),
    maxOutputTokens: Math.min(runtime.guards.maxOutputTokens, SUMMARY_ROLLUP_MAX_OUTPUT_TOKENS),
  })
  const controller = new AbortController()
  const result = await agent.stream({ prompt, abortSignal: controller.signal })
  const drained = await drainAgentStream(result.fullStream, undefined, {
    abortSignal: controller.signal,
    idleTimeoutMs: DEFAULT_TOOL_LOOP_IDLE_TIMEOUT_MS,
    onIdleTimeout: () => controller.abort(),
  })
  const { modelId: servedModelId } = await resolveAndReportServedUsage(
    dataDir,
    storyId,
    'librarian.rollup',
    result.totalUsage,
    {
      providerId: runtime.providerId,
      configuredModelId: runtime.modelId,
      servedModelId: drained.servedModelId,
    },
  )
  const reported = drained.toolCalls.filter((call) => call.toolName === ROLLUP_TOOL_NAME).at(-1)
  if (!reported) {
    const detail = drained.toolErrors.map((error) => error.error).join('; ')
    throw new Error(`Summary roll-up reported no record (finish: ${drained.finishReason}${detail ? `; ${detail}` : ''})`)
  }
  const output = rollupInputSchema.parse(reported.args)
  const modelConfigKey = rollupModelConfigKey(runtime, servedModelId)
  // The model changed after a previously observed identity was used to select
  // child nodes. Re-plan once under the newly observed tree rather than saving a
  // node whose children belong to another model; alternating identities fail
  // explicitly instead of recursing forever.
  if (observedModelId && modelConfigKey !== planningModelConfigKey) {
    if (allowIdentityRetry) return runSummaryRollupMaintenanceInner(dataDir, storyId, false)
    throw new Error('Summary roll-up served model changed twice while rebuilding its cache identity')
  }
  const id = nodeIdentity(plan.level, plan.children, modelConfigKey)
  const existingForServedModel = nodes.find((node) => node.id === id)
  if (existingForServedModel) return existingForServedModel
  const leafIds = plan.children.flatMap((child) => 'leafIds' in child ? child.leafIds : [child.id])
  const coverageStart = 'coverageStart' in plan.children[0] ? plan.children[0].coverageStart : plan.children[0].proseId
  const lastChild = plan.children.at(-1)!
  const coverageEnd = 'coverageEnd' in lastChild ? lastChild.coverageEnd : lastChild.proseId
  const artifactHash = hash(stableJson({ title: output.title, text: output.text }))
  const node: SummaryRollupNode = {
    id,
    level: plan.level,
    childIds: plan.children.map((child) => child.id),
    leafIds,
    coverageStart,
    coverageEnd,
    title: output.title,
    text: output.text,
    contractVersion: SUMMARY_ROLLUP_CONTRACT_VERSION,
    modelConfigKey,
    tokenCount: Math.max(1, Math.ceil(output.text.length / 4)),
    artifactHash,
    createdAt: new Date().toISOString(),
  }
  await saveSummaryRollupNode(dataDir, storyId, node)
  logger.child({ storyId }).info('Summary roll-up cached', { nodeId: node.id, level: node.level, childCount: node.childIds.length })
  return node
}

const queued = new Set<string>()
const dirty = new Set<string>()
const failures = new Map<string, { at: number; count: number }>()

/**
 * One minute, doubling to half an hour. Demand is re-marked on every
 * budget-truncated projection, so a flat interval means a broken roll-up spends
 * tokens once a minute for as long as the story stays open.
 */
function retryDelayMs(consecutiveFailures: number): number {
  return Math.min(60_000 * 2 ** (consecutiveFailures - 1), 30 * 60_000)
}

function maintenanceKey(dataDir: string, storyId: string, branchId: string): string {
  return `${dataDir}\u0000${storyId}\u0000${branchId}`
}

/** Mark demand during projection without starting model work on the read path. */
export function markSummaryRollupNeeded(dataDir: string, storyId: string): void {
  const branchId = getScopedBranchId(storyId)
  if (branchId) dirty.add(maintenanceKey(dataDir, storyId, branchId))
}

/** Queue one low-priority derivation. It never enters the caller's hot path. */
export function queueSummaryRollupMaintenance(dataDir: string, storyId: string, requestedBranchId?: string): void {
  const branchId = requestedBranchId ?? getScopedBranchId(storyId)
  if (!branchId) return
  const key = maintenanceKey(dataDir, storyId, branchId)
  if (!dirty.has(key) || queued.has(key)) return
  const failure = failures.get(key)
  if (failure && Date.now() - failure.at < retryDelayMs(failure.count)) return
  dirty.delete(key)
  queued.add(key)
  queueMicrotask(() => {
    void withBranch(dataDir, storyId, () => runSummaryRollupMaintenance(dataDir, storyId), branchId)
      .then(() => failures.delete(key))
      .catch((error) => {
        dirty.add(key)
        const count = (failures.get(key)?.count ?? 0) + 1
        failures.set(key, { at: Date.now(), count })
        logger.child({ storyId }).warn('Summary roll-up maintenance failed', {
          consecutiveFailures: count,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => queued.delete(key))
  })
}

export function selectSummaryRollupFrontier(
  leafIds: Array<string | null>,
  nodes: SummaryRollupNode[],
  foldBeforeIndex: number,
  segmentKeys?: string[],
): SummaryRollupFrontierItem[] {
  const located = new Map<string, NodeLocation>()
  const startsByLeafId = new Map<string, number[]>()
  leafIds.forEach((leafId, index) => {
    if (leafId) startsByLeafId.set(leafId, [...(startsByLeafId.get(leafId) ?? []), index])
  })
  for (const node of nodes) {
    if (node.contractVersion !== SUMMARY_ROLLUP_CONTRACT_VERSION || node.leafIds.length === 0) continue
    for (const start of startsByLeafId.get(node.leafIds[0]) ?? []) {
      if (start + node.leafIds.length > foldBeforeIndex) continue
      const sameSegment = !segmentKeys
        || node.leafIds.every((_id, offset) => segmentKeys[start + offset] === segmentKeys[start])
      if (sameSegment && node.leafIds.every((id, offset) => leafIds[start + offset] === id)) {
        located.set(node.id, {
          segment: segmentKeys?.[start] ?? 0,
          start,
          end: start + node.leafIds.length - 1,
        })
        break
      }
    }
  }
  const valid = validateNodeLocations(nodes, located)
  const candidatesByStart = new Map<number, SummaryRollupFrontierItem[]>()
  for (const node of nodes) {
    const location = valid.get(node.id)
    if (!location) continue
    const item = { node, startIndex: location.start, endIndex: location.end }
    candidatesByStart.set(location.start, [...(candidatesByStart.get(location.start) ?? []), item])
  }
  const selected: SummaryRollupFrontierItem[] = []
  for (let index = 0; index < foldBeforeIndex;) {
    const candidate = (candidatesByStart.get(index) ?? [])
      .filter((item) => item.endIndex < foldBeforeIndex)
      .sort((a, b) => b.node.level - a.node.level
        || b.node.leafIds.length - a.node.leafIds.length
        || b.node.createdAt.localeCompare(a.node.createdAt))[0]
    if (!candidate) {
      index += 1
      continue
    }
    selected.push(candidate)
    index = candidate.endIndex + 1
  }
  return selected
}
