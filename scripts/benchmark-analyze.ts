/**
 * Run the real Librarian Analyze agent repeatedly against an isolated copy of
 * one story. Each sample starts from identical persisted state, so model
 * behaviour can be compared without mutating the author's data.
 *
 *   bun run benchmark:analyze -- --story=story-id --fragment=pr-id \
 *     --model="Model name" --runs=3 --label=staged
 *
 * --branch=<id> analyzes against that timeline, --thinking=on|off overrides the
 * story's reasoning setting, --max-run-ms aborts a sample that never ends (a
 * degenerate loop keeps streaming, so the idle timeout cannot catch it), and
 * --capture=<dir> writes each raw completion stream to its own file there.
 * --rebuild-chain first re-analyzes every earlier passage in order, once, so the
 * samples run against a ledger the current code built rather than stored analyses.
 * --mode=single|staged selects the analyze experiment (ERRATA_ANALYZE_MODE).
 */
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { runLibrarian } from '../src/server/librarian/agent'
import { getActiveProseIds } from '../src/server/fragments/prose-chain'
import { registerLibrarianAgents } from '../src/server/librarian/agents'
import { getAnalysis, listAnalyses, type LibrarianAnalysis } from '../src/server/librarian/storage'
import { toolResultOutcome } from '../src/lib/librarian-outcome'

interface Options {
  dataDir: string
  storyId: string
  fragmentId: string
  modelId?: string
  runs: number
  label: string
  idleTimeoutMs: number
  maxRunMs?: number
  branchId?: string
  thinking?: 'on' | 'off'
  captureDir?: string
  rebuildChain: boolean
  inPlace: boolean
}

interface Sample {
  run: number
  durationMs: number
  stepCount: number
  inputTokens?: number
  outputTokens?: number
  workflowComplete: boolean
  error?: string
  toolCalls: string[]
  stages: string[]
  toolErrors: number
  toolErrorDetails: string[]
  lossAttempts: number
  summary: string
  directions: string[]
  timelineEvents: string[]
  mentions: string[]
  contradictions: string[]
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>()
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const separator = arg.indexOf('=')
    if (separator === -1) {
      values.set(arg.slice(2), 'true')
      continue
    }
    values.set(arg.slice(2, separator), arg.slice(separator + 1))
  }
  const storyId = values.get('story')?.trim()
  const fragmentId = values.get('fragment')?.trim()
  if (!storyId || !fragmentId) {
    throw new Error('Both --story=<id> and --fragment=<id> are required.')
  }
  return {
    dataDir: resolve(values.get('data') || './data'),
    storyId,
    fragmentId,
    modelId: values.get('model')?.trim() || undefined,
    runs: Math.max(1, Number.parseInt(values.get('runs') || '3', 10) || 3),
    label: values.get('label')?.trim() || 'analyze',
    idleTimeoutMs: Math.max(1, Number.parseInt(values.get('idle-timeout-ms') || '1800000', 10) || 1_800_000),
    maxRunMs: values.has('max-run-ms') ? Number.parseInt(values.get('max-run-ms')!, 10) || undefined : undefined,
    branchId: values.get('branch')?.trim() || undefined,
    thinking: parseThinking(values.get('thinking')),
    captureDir: values.get('capture') ? resolve(values.get('capture')!) : undefined,
    rebuildChain: values.has('rebuild-chain'),
    inPlace: values.has('in-place') || values.has('persist'),
  }
}

function parseThinking(value: string | undefined): Options['thinking'] {
  if (value === undefined) return undefined
  if (value === 'on' || value === 'off') return value
  throw new Error('--thinking must be "on" or "off".')
}

async function copyFixture(options: Options): Promise<{ root: string; dataDir: string }> {
  if (options.inPlace) {
    return { root: '', dataDir: options.dataDir }
  }
  const root = await mkdtemp(join(tmpdir(), 'errata-analyze-'))
  const dataDir = join(root, 'data')
  await mkdir(join(dataDir, 'stories'), { recursive: true })
  await Promise.all([
    cp(join(options.dataDir, 'config.json'), join(dataDir, 'config.json')),
    cp(join(options.dataDir, 'secrets.json'), join(dataDir, 'secrets.json')),
    cp(
      join(options.dataDir, 'stories', options.storyId),
      join(dataDir, 'stories', options.storyId),
      { recursive: true },
    ),
  ])

  const metaPath = join(dataDir, 'stories', options.storyId, 'meta.json')
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
    settings?: {
      autoApplyLibrarianSuggestions?: boolean
      disableThinking?: boolean
      modelOverrides?: Record<string, unknown>
    }
  }
  meta.settings ??= {}
  meta.settings.autoApplyLibrarianSuggestions = false
  if (options.thinking) meta.settings.disableThinking = options.thinking === 'off'
  if (options.branchId) {
    const branchesPath = join(dataDir, 'stories', options.storyId, 'branches.json')
    const branches = JSON.parse(await readFile(branchesPath, 'utf8')) as { activeBranchId: string }
    branches.activeBranchId = options.branchId
    await writeFile(branchesPath, `${JSON.stringify(branches, null, 2)}
`, 'utf8')
  }
  if (options.modelId) {
    const config = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as {
      defaultProviderId?: string | null
    }
    meta.settings.modelOverrides = {
      ...meta.settings.modelOverrides,
      'librarian.analyze': {
        providerId: config.defaultProviderId ?? null,
        modelId: options.modelId,
      },
    }
  }
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return { root, dataDir }
}

function countTraceLosses(trace: unknown): { toolErrors: number; toolErrorDetails: string[]; lossAttempts: number } {
  if (!Array.isArray(trace)) return { toolErrors: 0, toolErrorDetails: [], lossAttempts: 0 }
  let toolErrors = 0
  const toolErrorDetails: string[] = []
  let lossAttempts = 0
  for (const event of trace) {
    if (!event || typeof event !== 'object') continue
    const item = event as { type?: string; result?: unknown }
    if (item.type === 'tool-error') {
      toolErrors += 1
      const event = item as { toolName?: unknown; error?: unknown }
      const toolName = typeof event.toolName === 'string' ? event.toolName : 'unknown tool'
      const error = typeof event.error === 'string' ? event.error : 'unknown error'
      toolErrorDetails.push(`${toolName}: ${error}`)
    }
    if (item.type === 'tool-result') {
      const outcome = toolResultOutcome(item.result)
      lossAttempts += outcome.dropped
      if (!outcome.ok && outcome.dropped === 0) lossAttempts += 1
    }
  }
  return { toolErrors, toolErrorDetails, lossAttempts }
}

/** One "stage:seconds/outputTokens" entry per request, so slow or runaway stages are visible. */
function stageTimings(stepUsage: unknown): string[] {
  if (!Array.isArray(stepUsage)) return []
  return stepUsage.map((step: Record<string, unknown>) => (
    `${String(step.stage ?? step.stepNumber)}:${Math.round(Number(step.durationMs ?? 0) / 1000)}s/${String(step.outputTokens ?? '?')}out`
  ))
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
}

function jaccard(left: string, right: string): number {
  const a = words(left)
  const b = words(right)
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const word of a) if (b.has(word)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function pairwiseSimilarity(samples: Sample[], select: (sample: Sample) => string): number | null {
  const scores: number[] = []
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      scores.push(jaccard(select(samples[left]), select(samples[right])))
    }
  }
  return scores.length ? mean(scores) : null
}

/**
 * Tee every completion request and its streamed response to a numbered file.
 * The stream is the only record of a run that never finishes: the analysis is
 * saved only after a stage returns.
 */
async function captureCompletionStreams(dir: string, label: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const originalFetch = globalThis.fetch
  let requestNumber = 0
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await originalFetch(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('/chat/completions') || !response.body) return response
    requestNumber += 1
    const file = createWriteStream(join(dir, `${label}-${String(requestNumber).padStart(3, '0')}.log`))
    file.write(`${typeof init?.body === 'string' ? init.body : ''}

--- response ---
`)
    const [forCaller, forFile] = response.body.tee()
    void (async () => {
      const decoder = new TextDecoder()
      const reader = forFile.getReader()
      try {
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
          file.write(decoder.decode(part.value, { stream: true }))
        }
      } catch {
        // An aborted request ends the capture where the stream stopped.
      } finally {
        file.end()
      }
    })()
    return new Response(forCaller, { status: response.status, statusText: response.statusText, headers: response.headers })
  }) as typeof fetch
}

const options = parseArgs(process.argv.slice(2))
const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length)
if (modeArg) process.env.ERRATA_ANALYZE_MODE = modeArg
if (options.captureDir) await captureCompletionStreams(options.captureDir, options.label)
const samples: Sample[] = []
registerLibrarianAgents()

if (options.rebuildChain && !options.inPlace) {
  const base = await copyFixture(options)
  const chain = await getActiveProseIds(base.dataDir, options.storyId)
  const earlier = chain.slice(0, Math.max(chain.indexOf(options.fragmentId), 0))
  for (const [position, fragmentId] of earlier.entries()) {
    const started = performance.now()
    try {
      await runLibrarian(base.dataDir, options.storyId, fragmentId, {
        idleTimeoutMs: options.idleTimeoutMs,
        ...(options.maxRunMs ? { abortSignal: AbortSignal.timeout(options.maxRunMs) } : {}),
      })
      console.info(`[${options.label}] rebuilt ${position + 1}/${earlier.length} ${fragmentId} in ${Math.round(performance.now() - started)} ms`)
    } catch (cause) {
      console.info(`[${options.label}] rebuild of ${fragmentId} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  console.info(`[${options.label}] rebuilt fixture kept at ${base.dataDir}`)
  // Samples copy the rebuilt fixture; its settings are already applied.
  options.dataDir = base.dataDir
}

for (let index = 0; index < options.runs; index += 1) {
  const fixture = await copyFixture(options)
  const wallStart = performance.now()
  const startedAt = new Date().toISOString()
  try {
    console.info(`[${options.label}] run ${index + 1}/${options.runs} starting`)
    let analysis: LibrarianAnalysis | null = null
    let error: string | undefined
    try {
      analysis = await runLibrarian(fixture.dataDir, options.storyId, options.fragmentId, {
        idleTimeoutMs: options.idleTimeoutMs,
        ...(options.maxRunMs ? { abortSignal: AbortSignal.timeout(options.maxRunMs) } : {}),
      })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
      // Analyze intentionally saves inspectable partial work when observation
      // succeeded but a later lane failed. Recover that artifact so a failed
      // sample remains useful benchmark evidence instead of stopping the run.
      const latest = (await listAnalyses(fixture.dataDir, options.storyId))
        .filter((candidate) => candidate.fragmentId === options.fragmentId && candidate.createdAt >= startedAt)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      if (latest) analysis = await getAnalysis(fixture.dataDir, options.storyId, latest.id)
    }
    if (!analysis) {
      const sample: Sample = {
        run: index + 1,
        durationMs: Math.round(performance.now() - wallStart),
        stepCount: 0,
        workflowComplete: false,
        ...(error ? { error } : {}),
        toolCalls: [],
        stages: [],
        toolErrors: 0,
        toolErrorDetails: [],
        lossAttempts: 0,
        summary: '',
        directions: [],
        timelineEvents: [],
        mentions: [],
        contradictions: [],
      }
      samples.push(sample)
      console.info(`[${options.label}] run ${index + 1}/${options.runs} failed before producing an analysis (${sample.durationMs} ms): ${error ?? 'unknown'}`)
      continue
    }
    const pass = analysis.passes?.find((candidate) => candidate.name === 'analyze')
    const diagnostics = (pass?.diagnostics ?? {}) as Record<string, unknown>
    const losses = countTraceLosses(analysis.trace)
    const sample: Sample = {
      run: index + 1,
      durationMs: pass?.durationMs ?? Math.round(performance.now() - wallStart),
      stepCount: pass?.stepCount ?? 0,
      inputTokens: typeof diagnostics.inputTokens === 'number' ? diagnostics.inputTokens : undefined,
      outputTokens: typeof diagnostics.outputTokens === 'number' ? diagnostics.outputTokens : undefined,
      workflowComplete: diagnostics.workflowComplete === true || pass?.status === 'complete',
      ...(error ? { error } : {}),
      toolCalls: Array.isArray(diagnostics.toolCallNames)
        ? diagnostics.toolCallNames.filter((name): name is string => typeof name === 'string')
        : [],
      stages: stageTimings(diagnostics.stepUsage),
      ...losses,
      summary: analysis.summaryUpdate,
      directions: (analysis.directions ?? []).map((direction) =>
        `${direction.title}\n${direction.description}\n${direction.instruction}`,
      ),
      timelineEvents: (analysis.timelineEvents ?? []).map((event) => event.event),
      mentions: (analysis.mentions ?? []).map((mention) => mention.fragmentId).sort(),
      contradictions: (analysis.contradictions ?? []).map((contradiction) => contradiction.description),
    }
    samples.push(sample)
    console.info(
      `[${options.label}] run ${index + 1}/${options.runs} ${sample.workflowComplete ? 'finished' : 'failed'} in ${sample.durationMs} ms (${sample.stepCount} steps)`,
    )
  } finally {
    if (fixture.root) {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
}

const durations = samples.map((sample) => sample.durationMs)
const inputTokens = samples.flatMap((sample) => sample.inputTokens === undefined ? [] : [sample.inputTokens])
const outputTokens = samples.flatMap((sample) => sample.outputTokens === undefined ? [] : [sample.outputTokens])
const report = {
  label: options.label,
  source: basename(resolve('.')),
  storyId: options.storyId,
  fragmentId: options.fragmentId,
  modelId: options.modelId,
  aggregate: {
    runs: samples.length,
    successfulRuns: samples.filter((sample) => sample.workflowComplete).length,
    medianDurationMs: Math.round(median(durations)),
    meanDurationMs: Math.round(mean(durations)),
    meanInputTokens: inputTokens.length ? Math.round(mean(inputTokens)) : null,
    meanOutputTokens: outputTokens.length ? Math.round(mean(outputTokens)) : null,
    meanSteps: Number(mean(samples.map((sample) => sample.stepCount)).toFixed(2)),
    totalToolErrors: samples.reduce((sum, sample) => sum + sample.toolErrors, 0),
    totalLossAttempts: samples.reduce((sum, sample) => sum + sample.lossAttempts, 0),
    summaryWordSimilarity: pairwiseSimilarity(samples, (sample) => sample.summary),
    directionWordSimilarity: pairwiseSimilarity(samples, (sample) => sample.directions.join(' ')),
  },
  samples: samples.map(({ summary, directions, timelineEvents, mentions, contradictions, ...sample }) => ({
    ...sample,
    outputShape: {
      summaryWords: words(summary).size,
      directions: directions.length,
      timelineEvents: timelineEvents.length,
      mentions: mentions.length,
      contradictions: contradictions.length,
    },
  })),
}

console.info(JSON.stringify(report, null, 2))
process.exit(0)
