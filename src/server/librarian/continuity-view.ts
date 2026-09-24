import type { Fragment } from '@/contracts/story'
import {
  getAnalysis,
  getAnalysisIndex,
  getLiveStateEditLog,
  type LibrarianAnalysis,
  type LibrarianAnalysisIndex,
} from './storage'
import { LiveStateFold, type LiveStateCatalogRecord } from './live-state-fold'
import { listFragments } from '../fragments/storage'
import {
  type FoldedLiveState,
  type LiveStateEdit,
  type LiveStateRegistryEntry,
  type LiveStateSource,
} from '@/contracts/live-state'
import { proseContentHash } from './continuity-source'
import { continuityKeyLabel, normalizeContinuityKey } from '@/lib/continuity-keys'
import type {
  ContinuityLedger,
  ContinuityRegistry,
  ContinuityView,
  LiveThreadEntry,
  ProjectionSource,
  SceneFrame,
} from '@/contracts/continuity'

export type {
  ContinuityLedger,
  ContinuityView,
  FoldedLiveState,
  LiveThreadEntry,
  ProjectionSource,
  SceneFrame,
}

const MAX_LIVE_STATES = 48
/**
 * Threads only leave this list when resolved, so an unbounded list
 * grows for the life of the story. It is not just a rendering concern: the live
 * registry is rendered into the analyst prompt, so every extra key still costs
 * context budget on the model least able to spare it.
 */
const MAX_LIVE_THREADS = 24
const MAX_CACHE_ENTRIES = 32

interface LoadedAnalysis {
  source: Fragment
  narrativePosition: number
  analysisId: string
  projection: CachedProjection
  projectionIsCurrent: boolean
}

const ledgerCache = new Map<string, { signature: string; ledger: ContinuityLedger | undefined }>()

/**
 * Only the fields the fold consumes, memoized per analysis ID.
 *
 * The view cache alone is not enough: its signature includes every prose hash,
 * so it misses after every accepted passage and the fold then re-read one
 * analysis file per passage on the writer's critical path — linear in story
 * length. Analysis IDs are generated fresh per run and never reused, and
 * nothing mutates a saved projection, so a hit here is always current. Deleted
 * analyses leave the index and are therefore never requested again.
 */
interface CachedProjection {
  sourceRevision: LibrarianAnalysis['sourceRevision']
  continuityProjection: LibrarianAnalysis['continuityProjection']
}

const MAX_PROJECTION_CACHE_ENTRIES = 512
const projectionCache = new Map<string, CachedProjection | null>()

async function loadProjection(
  dataDir: string,
  storyId: string,
  analysisId: string,
): Promise<CachedProjection | null> {
  // The separator is escaped, not literal: an embedded NUL byte makes the
  // whole file binary to git, grep, and every code-search tool, so a 400-line
  // source stops being diffable and reviewable.
  const key = `${dataDir}\u0000${storyId}\u0000${analysisId}`
  const cached = projectionCache.get(key)
  if (cached !== undefined) return cached

  const analysis = await getAnalysis(dataDir, storyId, analysisId)
  const entry: CachedProjection | null = analysis
    ? { sourceRevision: analysis.sourceRevision, continuityProjection: analysis.continuityProjection }
    : null
  projectionCache.set(key, entry)
  while (projectionCache.size > MAX_PROJECTION_CACHE_ENTRIES) {
    const oldest = projectionCache.keys().next().value
    if (typeof oldest !== 'string') break
    projectionCache.delete(oldest)
  }
  return entry
}

function cloneLedger(ledger: ContinuityLedger | undefined): ContinuityLedger | undefined {
  return ledger ? structuredClone(ledger) : undefined
}

function takeLatest<T>(items: T[], maxItems: number): T[] {
  return items.slice(-maxItems)
}

function takeMostRecentlySourced<T extends { narrativePosition: number }>(items: T[], maxItems: number): T[] {
  return [...items]
    .sort((left, right) => left.narrativePosition - right.narrativePosition)
    .slice(-maxItems)
}

function cacheSet(key: string, signature: string, ledger: ContinuityLedger | undefined): void {
  ledgerCache.delete(key)
  ledgerCache.set(key, { signature, ledger })
  while (ledgerCache.size > MAX_CACHE_ENTRIES) {
    const oldest = ledgerCache.keys().next().value
    if (typeof oldest !== 'string') break
    ledgerCache.delete(oldest)
  }
}

export function invalidateContinuityCache(dataDir?: string, storyId?: string, analysisId?: string): void {
  if (dataDir && storyId && analysisId) {
    projectionCache.delete(`${dataDir}\u0000${storyId}\u0000${analysisId}`)
  } else {
    projectionCache.clear()
  }
  if (dataDir && storyId) {
    ledgerCache.delete(`${dataDir}\u0000${storyId}`)
  } else {
    ledgerCache.clear()
  }
}

function sourceOf(item: LoadedAnalysis): ProjectionSource {
  return {
    sourceFragmentId: item.source.id,
    analysisId: item.analysisId,
    narrativePosition: item.narrativePosition,
  }
}

function editSource(edit: LiveStateEdit, narrativePosition: number): LiveStateSource {
  return {
    sourceFragmentId: edit.afterFragmentId ?? '',
    analysisId: `edit:${edit.id}`,
    narrativePosition,
  }
}

function hasSceneSignal(frame: SceneFrame | undefined): frame is SceneFrame {
  return frame !== undefined && (
    frame.line !== 'present'
    || Boolean(frame.location)
    || Boolean(frame.time)
  )
}

function projectionCurrent(projection: CachedProjection, fragment: Fragment): boolean {
  return projection.sourceRevision?.contentHash === proseContentHash(fragment)
}

/**
 * Deterministically folds the latest source-current Analysis projections on the
 * active branch. Narrative events and scene rosters have their own consumers;
 * this fold reads only the first-class continuity projection.
 *
 * `throughFragmentId` stops the fold after that passage: continuity as it stood
 * there. Author corrections keep their place in the whole chain, so one made
 * later in the story does not reach back into it.
 *
 * `catalog` is the story's records, which decide who a reported subject is; a
 * caller that already holds them passes them, otherwise they are read here.
 */
export async function buildContinuityLedger(params: {
  dataDir: string
  storyId: string
  activeProseFragments: Fragment[]
  analysisIndex?: LibrarianAnalysisIndex | null
  throughFragmentId?: string
  catalog?: LiveStateCatalogRecord[]
}): Promise<ContinuityLedger | undefined> {
  const index = ('analysisIndex' in params
    ? params.analysisIndex
    : await getAnalysisIndex(params.dataDir, params.storyId))
    ?? {
      version: 2 as const,
      updatedAt: '',
      latestByFragmentId: {},
      latestProjectionByFragmentId: {},
      failedByFragmentId: {},
    }

  const editLog = await getLiveStateEditLog(params.dataDir, params.storyId)
  const catalog = (params.catalog ?? await listFragments(params.dataDir, params.storyId))
    .filter((record) => record.type !== 'prose')
  const fragmentHashes = new Map(
    params.activeProseFragments.map((fragment) => [fragment.id, proseContentHash(fragment)]),
  )
  const signature = [
    ...params.activeProseFragments.map((fragment) => (
      `${fragment.id}:${fragmentHashes.get(fragment.id)}:${index.latestProjectionByFragmentId[fragment.id]?.analysisId ?? ''}`
    )),
    `edits:${editLog.edits.length}:${editLog.edits.at(-1)?.id ?? ''}`,
    // A record created or renamed changes who a reported name belongs to.
    `catalog:${catalog.map((record) => `${record.id}:${record.type}:${record.name}`).join(',')}`,
  ].join('|')
  const chainPositions = new Map(params.activeProseFragments.map((fragment, indexInChain) => [fragment.id, indexInChain + 1]))
  const chainEnd = params.activeProseFragments.length
  const through = params.throughFragmentId === undefined
    ? chainEnd
    : chainPositions.get(params.throughFragmentId) ?? 0
  // Only the whole chain is cached: it is what every generation reads, and a
  // partial fold must not evict it.
  const cacheKey = through === chainEnd ? `${params.dataDir}\u0000${params.storyId}` : undefined
  const cached = cacheKey ? ledgerCache.get(cacheKey) : undefined
  if (cached?.signature === signature) return cloneLedger(cached.ledger)

  const sources = params.activeProseFragments
    .slice(0, through)
    .map((source, indexInChain) => ({
      source,
      narrativePosition: indexInChain + 1,
      analysisId: index.latestProjectionByFragmentId[source.id]?.analysisId,
    }))
    .filter((item): item is typeof item & { analysisId: string } => typeof item.analysisId === 'string')

  const loaded = (await Promise.all(sources.map(async (item): Promise<LoadedAnalysis | null> => {
    const projection = await loadProjection(params.dataDir, params.storyId, item.analysisId)
    if (!projection) return null
    return {
      source: item.source,
      narrativePosition: item.narrativePosition,
      analysisId: item.analysisId,
      projectionIsCurrent: projectionCurrent(projection, item.source),
      projection,
    }
  }))).filter((item): item is LoadedAnalysis => item !== null)

  // The scene frame of the line being read; entering a time overlay suspends it.
  let frame: SceneFrame | undefined
  const suspended: Array<SceneFrame | undefined> = []
  const liveThreads = new Map<string, LiveThreadEntry>()
  const liveStates = new LiveStateFold(catalog)
  const threadVisibility = new Map<string, LiveThreadEntry['visibility']>()
  let staleProjectionCount = 0

  // Author corrections apply after the passage they were made at, so a later
  // passage builds on them and a rerun analysis of an earlier one cannot erase
  // them. A correction whose passage has left the chain applies at the end.
  const pendingEdits = editLog.edits
    .map((edit) => ({
      edit,
      position: edit.afterFragmentId === null ? 0 : chainPositions.get(edit.afterFragmentId) ?? Number.POSITIVE_INFINITY,
    }))
    .filter(({ position }) => position <= through || through === chainEnd)
    .sort((left, right) => left.position - right.position)
  let nextEdit = 0
  const applyEditsBefore = (position: number) => {
    while (nextEdit < pendingEdits.length && (pendingEdits[nextEdit].position < position || position === Number.POSITIVE_INFINITY)) {
      const { edit, position: editPosition } = pendingEdits[nextEdit]
      liveStates.applyEdit(edit, editSource(edit, Number.isFinite(editPosition) ? editPosition : chainEnd))
      nextEdit += 1
    }
  }

  for (const item of loaded) {
    applyEditsBefore(item.narrativePosition)
    const source = sourceOf(item)
    if (!item.projectionIsCurrent) {
      staleProjectionCount += 1
      continue
    }

    const projection = item.projection.continuityProjection
    if (!projection) continue
    const scene = projection.scene
    const transition = scene.transition === 'uncertain' ? 'continue' : scene.transition
    if (transition === 'enter-flashback' || transition === 'enter-flash-forward') {
      suspended.push(frame)
      frame = undefined
      liveStates.enterLine(transition === 'enter-flashback' ? 'flashback' : 'flash-forward')
    } else if (transition === 'return') {
      frame = suspended.pop()
      liveStates.returnToPriorLine()
    } else if (transition === 'cut' || transition === 'advance') {
      liveStates.sceneBoundary()
    }

    const impliedLine = transition === 'enter-flashback'
      ? 'flashback'
      : transition === 'enter-flash-forward'
        ? 'flash-forward'
        : undefined
    const line = transition === 'return'
      ? frame?.line ?? 'present'
      : impliedLine ?? (scene.line && scene.line !== 'uncertain' ? scene.line : frame?.line ?? 'present')
    const priorFrame = frame
    let resultingTime = scene.time ?? priorFrame?.time
    if (!scene.time && transition === 'advance' && scene.elapsed && priorFrame?.time) {
      const advanceBound = (value: string | undefined, seconds: number | undefined): string | undefined => {
        if (!value || seconds === undefined) return undefined
        const instant = Date.parse(value)
        return Number.isFinite(instant) ? new Date(instant + seconds * 1000).toISOString() : undefined
      }
      const earliest = advanceBound(priorFrame.time.earliest, scene.elapsed.minimumSeconds)
      const latest = advanceBound(
        priorFrame.time.latest ?? priorFrame.time.earliest,
        scene.elapsed.maximumSeconds ?? scene.elapsed.minimumSeconds,
      )
      resultingTime = {
        ...priorFrame.time,
        label: `${scene.elapsed.label} after ${priorFrame.time.label}`,
        ...(earliest ? { earliest } : {}),
        ...(latest ? { latest } : {}),
        ...((earliest || latest) ? { certainty: earliest === latest ? 'exact' : 'bounded' as const } : {}),
      }
    }
    frame = {
      ...source,
      line,
      ...(scene.location ? { location: scene.location } : priorFrame?.location ? { location: priorFrame.location } : {}),
      ...(resultingTime ? { time: resultingTime } : {}),
    }

    // Prominence is a sparse update, not a snapshot. Omission retains the prior
    // value; dormant is explicit, so an empty model report cannot silently hide
    // every unresolved thread from the Writer.
    for (const focus of projection.threadFocus) {
      threadVisibility.set(normalizeContinuityKey(focus.threadKey), focus.visibility)
    }

    // Narrative threads are reader-facing continuity and can be opened or
    // resolved by any scene. Their prominence remains a separate sparse delta.
    for (const operation of projection.threadOperations) {
      const threadKey = normalizeContinuityKey(operation.threadKey)
      if (operation.action === 'resolve') {
        liveThreads.delete(threadKey)
        threadVisibility.delete(threadKey)
        continue
      }
      const existing = liveThreads.get(threadKey)
      liveThreads.delete(threadKey)
      liveThreads.set(threadKey, {
        ...source,
        threadKey,
        label: operation.label ?? existing?.label ?? continuityKeyLabel(threadKey),
        visibility: 'dormant',
      })
    }

    liveStates.applyReports(projection.liveStates, source)
  }
  applyEditsBefore(Number.POSITIVE_INFINITY)

  const allThreads: LiveThreadEntry[] = [...liveThreads.values()].map((thread) => ({
    ...thread,
    visibility: threadVisibility.get(thread.threadKey) ?? ('dormant' as const),
  }))
  const foldedLiveStates = liveStates.result()
  const ledger: ContinuityLedger | undefined = (
    allThreads.length > 0
    || foldedLiveStates.length > 0
    || hasSceneSignal(frame)
  ) ? {
      liveThreads: allThreads,
      ...(foldedLiveStates.length > 0 ? { liveStates: foldedLiveStates } : {}),
      currentScene: frame,
      staleProjectionCount,
    } : undefined

  if (cacheKey) cacheSet(cacheKey, signature, cloneLedger(ledger))
  return ledger
}

/**
 * Project the complete ledger into the bounded shape supplied to prompt readers.
 * Selection is deliberately mechanical. Semantic relevance belongs to an LLM
 * reader, never to lexical matching hidden in program code.
 */
export function projectContinuityView(
  ledger: ContinuityLedger | undefined,
): ContinuityView | undefined {
  if (!ledger) return undefined

  // A focused thread always survives; fill the remainder from the recent
  // dormant tail. Insertion order is recency of update.
  const focusedThreads = ledger.liveThreads.filter((thread) => thread.visibility !== 'dormant')
  const dormantThreads = ledger.liveThreads.filter((thread) => thread.visibility === 'dormant')
  const retainedDormant = new Set(takeLatest(
    dormantThreads,
    Math.max(MAX_LIVE_THREADS - focusedThreads.length, 0),
  ))
  const liveThreads = ledger.liveThreads.length <= MAX_LIVE_THREADS
    ? ledger.liveThreads
    : ledger.liveThreads.filter((thread) => thread.visibility !== 'dormant' || retainedDormant.has(thread))

  // A subject with nothing to say is a heading in the prompt and a slot taken
  // from one that has something.
  const informative = ledger.liveStates?.filter((subject) => subject.fields.length > 0 || subject.items.length > 0)
  const liveStates = informative?.length
    ? takeMostRecentlySourced(informative, MAX_LIVE_STATES)
    : undefined

  return {
    liveThreads,
    ...(liveStates ? { liveStates } : {}),
    currentScene: ledger.currentScene,
    staleProjectionCount: ledger.staleProjectionCount,
  }
}

/**
 * The agents that read folded continuity.
 *
 * A caller states which one it is; it does not get to choose how the records are
 * framed or whose awareness is in scope. Writing, proposing, editing, analysis,
 * and roleplay ask different questions of the same fold, so pairing a reader
 * with the wrong policy is a mistake worth making unavailable rather than
 * documenting. Adding a reader here is a deliberate choice about what that
 * agent is allowed to see and what it may do with the records.
 */
export type ContinuityReader =
  | 'generation.writer'
  | 'generation.prewriter'
  | 'directions.suggest'
  | 'librarian.analyze'
  | 'librarian.chat'
  | 'librarian.refine'
  | 'librarian.optimize-character'
  | 'character-chat.chat'

type ContinuityPresentation =
  | 'writing-constraints'
  | 'direction-candidates'
  | 'editing-reference'
  | 'full-reference'
  | 'self'
type AuthorialPresentation = Exclude<ContinuityPresentation, 'self'>
type CharacterScope = 'all' | 'active-cast' | 'target-related-cast' | 'target-character'

type ContinuityPolicy =
  | { presentation: Exclude<ContinuityPresentation, 'self'>; characterScope: CharacterScope }
  | { presentation: 'self' }

const POLICY_BY_READER: Record<ContinuityReader, ContinuityPolicy> = {
  // Limits, focused threads only. A dormant thread dragged into the present
  // scene is precisely the failure mode for whoever writes the next passage.
  'generation.writer': { presentation: 'writing-constraints', characterScope: 'active-cast' },
  'generation.prewriter': { presentation: 'writing-constraints', characterScope: 'active-cast' },
  // Latent material, every thread including dormant.
  'directions.suggest': { presentation: 'direction-candidates', characterScope: 'active-cast' },
  // Authorial fold (scene, characters, entities, open threads) so the analyzer
  // observes narrative continuity naturally instead of parsing numbered registry tables.
  'librarian.analyze': { presentation: 'direction-candidates', characterScope: 'active-cast' },
  // General Librarian chat reads the fold only on demand, but when asked it
  // needs the whole ledger rather than a passage-local subset.
  'librarian.chat': { presentation: 'full-reference', characterScope: 'all' },
  'librarian.refine': { presentation: 'editing-reference', characterScope: 'target-related-cast' },
  // Character optimization is explicitly about one sheet. Pinning and recency
  // must not decide whether that character's own knowledge reaches the editor.
  'librarian.optimize-character': { presentation: 'editing-reference', characterScope: 'target-character' },
  // Second person, own knowledge only. This reader *is* the character, and one
  // given the authorial records starts answering from offstage facts.
  'character-chat.chat': { presentation: 'self' },
}

const THREAD_VISIBILITY_ORDER = ['foreground', 'background', 'dormant'] as const satisfies ReadonlyArray<LiveThreadEntry['visibility']>

const THREAD_VISIBILITY_LABELS: Record<LiveThreadEntry['visibility'], string> = {
  foreground: 'Foreground',
  background: 'Background',
  dormant: 'Dormant',
}

interface AuthorialPresentationCopy {
  introduction: string
  includeDormantThreads: boolean
  threadHeading: string
  threadGuidance: string
}

const AUTHORIAL_PRESENTATION_COPY: Record<AuthorialPresentation, AuthorialPresentationCopy> = {
  'writing-constraints': {
    introduction: 'It constrains continuity but does not dictate what the next passage must do.',
    includeDormantThreads: false,
    threadHeading: '### Relevant unresolved continuity',
    threadGuidance: 'These are not tasks, promised beats, or instructions to advance or resolve anything. Let them remain unresolved unless the present scene naturally engages them.',
  },
  'direction-candidates': {
    introduction: 'It is material for proposing possible next moves, not a requirement that any one move happen.',
    includeDormantThreads: true,
    threadHeading: '### Unresolved continuity available to engage',
    threadGuidance: 'These are open questions the story has raised and not answered. A dormant one has simply gone quiet, not been resolved; deliberately picking one up is a legitimate direction. None of them is owed an answer.',
  },
  'editing-reference': {
    introduction: 'Respect it as evidence while editing, but do not copy transient state or unresolved questions into the target fragment.',
    includeDormantThreads: false,
    threadHeading: '### Open continuity relevant to this edit',
    threadGuidance: 'These are unresolved story questions, not facts to bake into the target fragment. Do not advance, resolve, or turn them into permanent traits or lore while editing.',
  },
  'full-reference': {
    introduction: 'It is the whole ledger as tracked, including characters elsewhere and threads that have gone quiet.',
    includeDormantThreads: true,
    threadHeading: '### Unresolved threads',
    threadGuidance: 'Open questions the story has raised and not answered. A dormant one has gone quiet, not been resolved.',
  },
}

/**
 * What the renderer needs, stated as the minimum rather than as a context type:
 * ids to scope characters by, and the folded view itself. Every agent's block
 * context already satisfies this, so a call site passes itself.
 */
export interface ContinuitySource {
  continuityView?: ContinuityView
  /** Complete fold for readers that need identity access beyond prompt values. */
  continuityLedger?: ContinuityLedger
  stickyCharacters?: Array<{ id: string }>
  recentCharacters?: Array<{ id: string }>
  /** The character a `self` reader is speaking as. */
  character?: { id: string }
  /** The fragment an editing reader is changing. */
  targetFragment?: { id: string; type: string; refs?: string[] }
}

/**
 * Which characters' state the reader is entitled to see beyond the scene.
 *
 * Derived here rather than at each call site, where the same spread was written
 * three times and could drift independently. It encodes today's behaviour; it
 * does not settle whether these are the right characters — but it makes that one
 * question answerable in one place per reader instead of three.
 */
function activeCast(source: ContinuitySource): Set<string> {
  return new Set([
    ...(source.stickyCharacters ?? []).map((fragment) => fragment.id),
    ...(source.recentCharacters ?? []).map((fragment) => fragment.id),
    ...(source.continuityView?.liveStates ?? [])
      .filter((subject) => subject.kind === 'character' && subject.present && Boolean(subject.fragmentId))
      .map((subject) => subject.fragmentId!),
  ])
}

function charactersInScope(source: ContinuitySource, scope: CharacterScope): Set<string> {
  if (scope === 'all') {
    return new Set((source.continuityView?.liveStates ?? [])
      .filter((subject) => subject.kind === 'character')
      .map((subject) => subject.fragmentId)
      .filter((id): id is string => Boolean(id)))
  }
  if (scope === 'target-character') {
    return new Set(source.targetFragment?.type === 'character' ? [source.targetFragment.id] : [])
  }
  if (scope === 'target-related-cast') {
    const characters = activeCast(source)
    if (source.targetFragment?.type === 'character') characters.add(source.targetFragment.id)
    for (const referencedId of source.targetFragment?.refs ?? []) characters.add(referencedId)
    return characters
  }
  return activeCast(source)
}

/**
 * The single way an agent gets folded continuity. Returns null when there is
 * nothing to show — nothing folded yet, or a `self` reader with no character —
 * so a call site guards once on the content instead of on the inputs.
 */
export function renderContinuity(source: ContinuitySource, reader: ContinuityReader): string | null {
  const view = source.continuityView
  const policy = POLICY_BY_READER[reader]
  const presentation = policy.presentation
  if (presentation === 'self') {
    return source.character ? renderSelfAwareness(view, source.character.id) : null
  }
  if (!view) return null
  return renderAuthorialContinuity(
    view,
    presentation,
    charactersInScope(source, policy.characterScope),
    reader === 'librarian.analyze',
  )
}

function renderAuthorialContinuity(
  view: ContinuityView,
  presentation: AuthorialPresentation,
  characterIds: Set<string>,
  /** The analyst reports against ids and item numbers; no other reader needs them. */
  forAnalyst: boolean,
): string {
  const copy = AUTHORIAL_PRESENTATION_COPY[presentation]
  const parts = [
    '## Continuity',
    `This is authorial, source-linked memory from accepted prose. ${copy.introduction} Information in this view is not automatically known by every character.`,
  ]

  if (hasSceneSignal(view.currentScene)) {
    const frame = view.currentScene
    parts.push([
      '### Current scene frame',
      `- Narrative line: ${frame.line}`,
      ...(frame.location ? [`- Location: ${frame.location.label}`] : []),
      ...(frame.time ? [`- Time: ${frame.time.label} (${frame.time.certainty})`] : []),
    ].join('\n'))
  }
  const threads = copy.includeDormantThreads
    ? view.liveThreads
    : view.liveThreads.filter((thread) => thread.visibility !== 'dormant')
  if (threads.length > 0) {
    // Grouped rather than tagged, and addressed by label alone: a thread line
    // carries nothing but the text a reader would repeat to name it.
    const groups = THREAD_VISIBILITY_ORDER
      .map((visibility) => [visibility, threads.filter((thread) => thread.visibility === visibility)] as const)
      .filter(([, members]) => members.length > 0)
    parts.push([
      copy.threadHeading,
      copy.threadGuidance,
      ...groups.flatMap(([visibility, members]) => [
        `**${THREAD_VISIBILITY_LABELS[visibility]}**`,
        ...members.map((thread) => `- ${thread.label}`),
      ]),
    ].join('\n'))
  }

  const liveStates = renderLiveStates(view, characterIds, forAnalyst)
  if (liveStates) parts.push(liveStates)

  return parts.join('\n\n')
}

/**
 * The subjects an authorial reader is shown: everyone in the scene, plus
 * in-scope characters who are elsewhere, whose last-known state is exactly what
 * keeps them from acting on a scene they did not witness.
 */
function shownLiveStates(view: ContinuityView, characterIds: Set<string>): FoldedLiveState[] {
  const subjects = view.liveStates ?? []
  const inScope = (subject: FoldedLiveState) => subject.kind === 'character'
    && Boolean(subject.fragmentId && characterIds.has(subject.fragmentId))
  return [
    ...subjects.filter((subject) => subject.present),
    ...subjects.filter((subject) => !subject.present && inScope(subject)),
  ]
}

/** Item numbers run across every shown subject, in the order they are rendered. */
function numberLiveStateItems(subjects: FoldedLiveState[]): LiveStateRegistryEntry[] {
  return subjects.flatMap((subject) => subject.items.map((item) => ({ item, subject })))
    .map(({ item, subject }, index) => ({
      index: index + 1,
      kind: subject.kind,
      subjectKey: subject.key,
      subjectName: subject.name,
      id: item.id,
      field: item.field,
      text: item.text,
    }))
}

function describeAge(field: FoldedLiveState['fields'][number]): string {
  if (field.holds !== 'lastKnown' || field.scenesAgo === 0) return ''
  return field.scenesAgo === 1 ? ' (previous scene)' : ` (${field.scenesAgo} scenes ago)`
}

function describeEnding(ended: FoldedLiveState['ended'][number], names: Map<string, string>): string {
  if (ended.happened === 'revealed') {
    const to = (ended.to ?? []).map((key) => names.get(key) ?? key)
    return to.length > 0 ? `revealed to ${to.join(', ')}` : 'revealed'
  }
  if (ended.happened === 'changed') return ended.now ? `changed; now: ${ended.now}` : 'changed'
  return 'resolved'
}

/** Groups list items under their field in first-seen order. */
function itemsByField(items: FoldedLiveState['items']): Array<[string, FoldedLiveState['items']]> {
  const groups = new Map<string, FoldedLiveState['items']>()
  for (const item of items) groups.set(item.field, [...(groups.get(item.field) ?? []), item])
  return [...groups]
}

function renderLiveStates(
  view: ContinuityView,
  characterIds: Set<string>,
  forAnalyst: boolean,
): string | null {
  const shown = shownLiveStates(view, characterIds)
  if (shown.length === 0) return null
  const numbers = forAnalyst
    ? new Map(numberLiveStateItems(shown).map((entry) => [`${entry.kind}:${entry.subjectKey}:${entry.id}`, entry.index]))
    : undefined
  const names = new Map((view.liveStates ?? []).map((subject) => [subject.key, subject.name]))
  const latestPosition = view.currentScene?.narrativePosition
    ?? Math.max(0, ...(view.liveStates ?? []).map((subject) => subject.narrativePosition))

  const lines = ['### Where things stand']
  for (const subject of shown) {
    const header = [
      `**${subject.name}**`,
      forAnalyst && subject.fragmentId ? ` (\`${subject.fragmentId}\`)` : '',
      subject.category ? ` [${subject.category}]` : '',
      subject.present ? '' : ' — not in the current scene',
    ].join('')
    const details = subject.fields.map((field) => `- ${field.field}: ${field.value}${describeAge(field)}`)
    for (const [field, items] of itemsByField(subject.items)) {
      details.push(`- ${field}:`)
      for (const item of items) {
        const number = numbers?.get(`${subject.kind}:${subject.key}:${item.id}`)
        details.push(`  - ${number !== undefined ? `[${number}] ` : ''}${item.text}`)
      }
    }
    for (const ended of subject.ended.filter((item) => item.endedAt.narrativePosition >= latestPosition)) {
      details.push(`- No longer (${ended.field}): ${ended.text} — ${describeEnding(ended, names)}`)
    }
    lines.push([header, ...details].join('\n'))
  }
  if (numbers && numbers.size > 0) {
    lines.splice(1, 0, 'Numbered items can be ended by number when this passage reveals, changes, or resolves them.')
  }
  return lines.join('\n\n')
}

/**
 * What one character knows, addressed to them.
 *
 * Deliberately narrower than the authorial view: other characters' state and
 * story threads are authorial records, and a character allowed to read them
 * starts acting on offstage facts. Their own live state is the part that is
 * theirs — and the part that stops a reply from treating the story summary,
 * which sits in the same prompt, as the character's own memory.
 */
function renderSelfAwareness(view: ContinuityView | undefined, characterId: string): string {
  const charState = view?.liveStates?.find((subject) => subject.kind === 'character' && subject.fragmentId === characterId)
  const lines = [
    '## What You Know',
    'Your character sheet and the list below are your memory. Do not infer knowledge from authorial story material or from what other characters know: if something does not appear here, you have not learned it.',
  ]
  if (charState) {
    lines.push(...charState.fields.map((field) => `- ${field.field}: ${field.value}`))
    for (const [field, items] of itemsByField(charState.items)) {
      lines.push(`- ${field}:`, ...items.map((item) => `  - ${item.text}`))
    }
  }
  if (!charState) {
    lines.push('- (nothing beyond your character sheet and the present conversation)')
  }
  return lines.join('\n')
}

/**
 * What the analyst may address, exactly as its continuity block renders it:
 * live threads by key or label, and live-state items by the numbers shown
 * beside them. The block and the report are built from this one derivation, so
 * a number means the same thing on both sides.
 */
export function continuityRegistry(source: ContinuitySource): ContinuityRegistry {
  const view = source.continuityView
  const ledger = source.continuityLedger ?? view
  if (!ledger) return { thread: [], items: [] }
  const analyzePolicy = POLICY_BY_READER['librarian.analyze']
  const items = view && analyzePolicy.presentation !== 'self'
    ? numberLiveStateItems(shownLiveStates(view, charactersInScope(source, analyzePolicy.characterScope)))
    : []
  return {
    thread: ledger.liveThreads.map((thread) => ({ key: thread.threadKey, label: thread.label })),
    items,
  }
}
