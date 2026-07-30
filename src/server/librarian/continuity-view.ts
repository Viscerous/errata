import type { Fragment } from '../fragments/schema'
import { getAnalysis, getAnalysisIndex, type LibrarianAnalysis } from './storage'
import { proseContentHash } from './continuity-source'
import { continuityKeyLabel, normalizeContinuityKey } from '@/lib/continuity-keys'
import type { TemporalFrame } from './continuity-types'

const MAX_CURRENT_STATE = 24
const MAX_KNOWLEDGE_PER_CHARACTER = 16
/**
 * Threads only leave this list when resolved or abandoned, so an unbounded list
 * grows for the life of the story. It is not just a rendering concern: the live
 * registry becomes a closed enum in the analysis tool schema, so every extra
 * key costs prompt budget on the model least able to spare it.
 */
const MAX_LIVE_THREADS = 24
const MAX_CACHE_ENTRIES = 32

interface ProjectionSource {
  sourceFragmentId: string
  analysisId: string
  narrativePosition: number
}

export interface CurrentStateEntry extends ProjectionSource {
  stateKey: string
  subject: string
  value: string
}

export interface LiveThreadEntry extends ProjectionSource {
  threadKey: string
  label: string
  note?: string
  relatedFragmentIds: string[]
  visibility: 'foreground' | 'background' | 'dormant'
}

export interface CharacterKnowledgeEntry extends ProjectionSource {
  characterId: string
  knowledgeKey: string
  fact: string
  acquisition: 'witnessed' | 'told' | 'inferred' | 'other'
}

export interface ContinuityView {
  currentState: CurrentStateEntry[]
  liveThreads: LiveThreadEntry[]
  characterKnowledge: CharacterKnowledgeEntry[]
  temporalFrame?: TemporalFrame
  staleProjectionCount: number
}

interface LoadedAnalysis {
  source: Fragment
  narrativePosition: number
  analysisId: string
  projection: CachedProjection
  projectionIsCurrent: boolean
}

const viewCache = new Map<string, { signature: string; view: ContinuityView | undefined }>()

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

function cloneView(view: ContinuityView | undefined): ContinuityView | undefined {
  return view ? structuredClone(view) : undefined
}

function takeLatest<T>(items: T[], maxItems: number): T[] {
  return items.slice(-maxItems)
}

function cacheSet(key: string, signature: string, view: ContinuityView | undefined): void {
  viewCache.delete(key)
  viewCache.set(key, { signature, view })
  while (viewCache.size > MAX_CACHE_ENTRIES) {
    const oldest = viewCache.keys().next().value
    if (typeof oldest !== 'string') break
    viewCache.delete(oldest)
  }
}

function sourceOf(item: LoadedAnalysis): ProjectionSource {
  return {
    sourceFragmentId: item.source.id,
    analysisId: item.analysisId,
    narrativePosition: item.narrativePosition,
  }
}

function isPresentLine(frame: TemporalFrame): boolean {
  return frame.relation === 'forward' || frame.relation === 'concurrent'
}

function projectionCurrent(projection: CachedProjection, fragment: Fragment): boolean {
  if (!projection.sourceRevision) return true
  return projection.sourceRevision.contentHash === proseContentHash(fragment)
}

/**
 * Deterministically folds the latest source-current Analysis projections on the
 * active branch. Legacy event/state-change prose and scene rosters remain in old
 * Analysis files but are intentionally not part of this Writer-facing view.
 */
export async function buildContinuityView(params: {
  dataDir: string
  storyId: string
  activeProseFragments: Fragment[]
}): Promise<ContinuityView | undefined> {
  const index = await getAnalysisIndex(params.dataDir, params.storyId)
  if (!index) return undefined

  const fragmentHashes = new Map(
    params.activeProseFragments.map((fragment) => [fragment.id, proseContentHash(fragment)]),
  )
  const signature = [
    index.updatedAt,
    ...params.activeProseFragments.map((fragment) => (
      `${fragment.id}:${fragmentHashes.get(fragment.id)}:${index.latestByFragmentId[fragment.id]?.analysisId ?? ''}`
    )),
  ].join('|')
  const cacheKey = `${params.dataDir}\u0000${params.storyId}`
  const cached = viewCache.get(cacheKey)
  if (cached?.signature === signature) return cloneView(cached.view)

  const sources = params.activeProseFragments
    .map((source, indexInChain) => ({
      source,
      narrativePosition: indexInChain + 1,
      analysisId: index.latestByFragmentId[source.id]?.analysisId,
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

  const currentState = new Map<string, CurrentStateEntry>()
  const liveThreads = new Map<string, LiveThreadEntry>()
  const characterKnowledge = new Map<string, CharacterKnowledgeEntry>()
  let latestThreadFocus = new Map<string, 'foreground' | 'background'>()
  let temporalFrame: TemporalFrame | undefined
  let staleProjectionCount = 0

  for (const item of loaded) {
    const source = sourceOf(item)
    if (item.projection.sourceRevision && !item.projectionIsCurrent) {
      staleProjectionCount += 1
      continue
    }

    // Staleness was settled above: a projection without a `sourceRevision` is
    // legacy and counts as current, so the only thing left to check is whether
    // there is a projection at all.
    const projection = item.projection.continuityProjection
    if (!projection) continue
    temporalFrame = projection.temporalFrame
    // A thread omitted from a snapshot is dormant; an analysis that supplied no
    // snapshot at all asserted nothing about focus, so the last real one stands.
    // Conflating the two let any analysis reporting no focus — 8 of 23 on
    // Timeline 10 — silently empty the Writer's unresolved-continuity section.
    if (projection.threadFocus.length > 0) {
      latestThreadFocus = new Map(
        projection.threadFocus.map((focus) => [normalizeContinuityKey(focus.threadKey), focus.visibility]),
      )
    }

    if (isPresentLine(projection.temporalFrame)) {
      for (const operation of projection.stateOperations) {
        // Keys are normalized on the fold as well as at ingest so projections
        // written before normalization do not fork the registry.
        const stateKey = normalizeContinuityKey(operation.stateKey)
        if (operation.action === 'clear') {
          currentState.delete(stateKey)
          continue
        }
        if (!operation.value) continue
        // Re-setting an existing key must move it to the end: the cap below
        // keeps the most recently *updated* entries, not the earliest created.
        currentState.delete(stateKey)
        currentState.set(stateKey, {
          ...source,
          stateKey,
          subject: operation.subject,
          value: operation.value,
        })
      }
    }

    // Narrative threads are reader-facing continuity and can be opened or
    // resolved by any temporal frame. Their focus remains a separate snapshot.
    for (const operation of projection.threadOperations) {
      const threadKey = normalizeContinuityKey(operation.threadKey)
      if (operation.action === 'resolve' || operation.action === 'abandon') {
        liveThreads.delete(threadKey)
        continue
      }
      const existing = liveThreads.get(threadKey)
      liveThreads.delete(threadKey)
      liveThreads.set(threadKey, {
        ...source,
        threadKey,
        label: operation.label ?? existing?.label ?? continuityKeyLabel(threadKey),
        ...(operation.note ? { note: operation.note } : existing?.note ? { note: existing.note } : {}),
        relatedFragmentIds: operation.relatedFragmentIds.length > 0
          ? operation.relatedFragmentIds
          : existing?.relatedFragmentIds ?? [],
        visibility: 'dormant',
      })
    }

    if (projection.temporalFrame.relation !== 'flash-forward') {
      for (const operation of projection.knowledgeOperations) {
        const key = `${operation.characterId}\u0000${normalizeContinuityKey(operation.knowledgeKey)}`
        if (operation.action === 'forget') {
          characterKnowledge.delete(key)
          continue
        }
        if (!operation.fact) continue
        characterKnowledge.delete(key)
        characterKnowledge.set(key, {
          ...source,
          characterId: operation.characterId,
          knowledgeKey: normalizeContinuityKey(operation.knowledgeKey),
          fact: operation.fact,
          acquisition: operation.acquisition,
        })
      }
    }
  }

  const allThreads: LiveThreadEntry[] = [...liveThreads.values()].map((thread) => ({
    ...thread,
    visibility: latestThreadFocus.get(thread.threadKey) ?? ('dormant' as const),
  }))
  // A thread the latest passage still has in view outranks an older dormant one
  // regardless of when it was last touched, so cap the dormant tail rather than
  // the list as a whole. Insertion order is recency of update either way.
  const focused = allThreads.filter((thread) => thread.visibility !== 'dormant')
  const retainedDormant = new Set(takeLatest(
    allThreads.filter((thread) => thread.visibility === 'dormant'),
    Math.max(MAX_LIVE_THREADS - focused.length, 0),
  ))
  const threads = allThreads.length <= MAX_LIVE_THREADS
    ? allThreads
    : allThreads.filter((thread) => thread.visibility !== 'dormant' || retainedDormant.has(thread))

  // Per-character rather than overall: one talkative character must not crowd
  // the rest out of the registry the analyst reuses keys from.
  const knowledgeByCharacterId = new Map<string, CharacterKnowledgeEntry[]>()
  for (const entry of characterKnowledge.values()) {
    knowledgeByCharacterId.set(entry.characterId, [...(knowledgeByCharacterId.get(entry.characterId) ?? []), entry])
  }
  const knowledge = [...knowledgeByCharacterId.values()]
    .flatMap((entries) => takeLatest(entries, MAX_KNOWLEDGE_PER_CHARACTER))
  const view: ContinuityView | undefined = (
    currentState.size > 0
    || threads.length > 0
    || knowledge.length > 0
    || (temporalFrame !== undefined && temporalFrame.relation !== 'forward')
  ) ? {
      currentState: takeLatest([...currentState.values()], MAX_CURRENT_STATE),
      liveThreads: threads,
      characterKnowledge: knowledge,
      temporalFrame,
      staleProjectionCount,
    } : undefined

  cacheSet(cacheKey, signature, cloneView(view))
  return view
}

/**
 * The agents that read folded continuity.
 *
 * A caller states which one it is; it does not get to state how the records
 * should be framed. The two framings are contradictory — "let these lie" for
 * whoever writes the next passage, "here is what you could pick up" for whoever
 * only proposes one — so pairing a reader with the wrong one is a mistake worth
 * making unavailable rather than documenting. Adding a reader here is a
 * deliberate choice about what that agent is allowed to see.
 */
export type ContinuityReader =
  | 'generation.writer'
  | 'generation.prewriter'
  | 'directions.suggest'
  | 'librarian.analyze'
  | 'character-chat.chat'

type ContinuityPresentation = 'constraints' | 'candidates' | 'registry' | 'self'

const PRESENTATION_BY_READER: Record<ContinuityReader, ContinuityPresentation> = {
  // Limits, focused threads only. A dormant thread dragged into the present
  // scene is precisely the failure mode for whoever writes the next passage.
  'generation.writer': 'constraints',
  'generation.prewriter': 'constraints',
  // Latent material, every thread including dormant. A question the story raised
  // and let go is the richest source of a next move for a reader that proposes
  // moves and writes none of them.
  'directions.suggest': 'candidates',
  // The keyed registry, because this reader writes the records back and has to
  // address them by the keys they already carry.
  'librarian.analyze': 'registry',
  // Second person, own knowledge only. This reader *is* the character, and one
  // given the authorial records starts answering from offstage facts.
  'character-chat.chat': 'self',
}

/**
 * What the renderer needs, stated as the minimum rather than as a context type:
 * ids to scope knowledge by, and the folded view itself. Every agent's block
 * context already satisfies this, so a call site passes itself.
 */
export interface ContinuitySource {
  continuityView?: ContinuityView
  stickyCharacters?: Array<{ id: string }>
  recentCharacters?: Array<{ id: string }>
  attentionCandidateIds?: string[]
  /** The character a `self` reader is speaking as. */
  character?: { id: string }
}

/**
 * Which characters' awareness the reader is entitled to see.
 *
 * Derived here rather than at each call site, where the same spread was written
 * three times and could drift independently. It encodes today's behaviour; it
 * does not settle whether these are the right characters — but it makes that one
 * question answerable in one place per reader instead of three.
 */
function charactersInScope(source: ContinuitySource, presentation: ContinuityPresentation): Set<string> {
  if (presentation === 'registry') {
    // Analysis scopes knowledge to who this passage is actually about.
    return new Set([
      ...(source.attentionCandidateIds ?? []),
      ...(source.recentCharacters ?? []).map((fragment) => fragment.id),
    ])
  }
  // Pinned, or active in the recent window: the cast the author is working with.
  return new Set([
    ...(source.stickyCharacters ?? []).map((fragment) => fragment.id),
    ...(source.recentCharacters ?? []).map((fragment) => fragment.id),
  ])
}

/**
 * The single way an agent gets folded continuity. Returns null when there is
 * nothing to show — nothing folded yet, or a `self` reader with no character —
 * so a call site guards once on the content instead of on the inputs.
 */
export function renderContinuity(source: ContinuitySource, reader: ContinuityReader): string | null {
  const view = source.continuityView
  if (!view) return null

  const presentation = PRESENTATION_BY_READER[reader]
  if (presentation === 'self') {
    return source.character ? renderSelfAwareness(view, source.character.id) : null
  }
  if (presentation === 'registry') {
    return renderContinuityRegistry(view, charactersInScope(source, presentation))
  }
  return renderAuthorialContinuity(view, presentation, charactersInScope(source, presentation))
}

function renderAuthorialContinuity(
  view: ContinuityView,
  presentation: Extract<ContinuityPresentation, 'constraints' | 'candidates'>,
  characterIds: Set<string>,
): string {
  const asCandidates = presentation === 'candidates'
  const parts = [
    '## Continuity',
    'This is source-linked memory from accepted prose. It constrains continuity but does not dictate what the next passage must do. Information shown to the Writer is not automatically known by every character.',
  ]

  if (view.temporalFrame && view.temporalFrame.relation !== 'forward') {
    const anchor = view.temporalFrame.anchor ? ` — ${view.temporalFrame.anchor}` : ''
    parts.push(`### Current temporal frame\n- ${view.temporalFrame.relation}${anchor}`)
  }
  if (view.currentState.length > 0) {
    parts.push([
      '### Current durable state',
      ...view.currentState.map((item) => `- ${item.subject}: ${item.value}`),
    ].join('\n'))
  }

  const threads = asCandidates
    ? view.liveThreads
    : view.liveThreads.filter((thread) => thread.visibility !== 'dormant')
  if (threads.length > 0) {
    parts.push([
      asCandidates ? '### Unresolved continuity available to engage' : '### Relevant unresolved continuity',
      asCandidates
        ? 'These are open questions the story has raised and not answered. A dormant one has simply gone quiet, not been resolved; deliberately picking one up is a legitimate direction. None of them is owed an answer.'
        : 'These are not tasks, promised beats, or instructions to advance or resolve anything. Let them remain unresolved unless the present scene naturally engages them.',
      ...threads.map((thread) => `- [${thread.visibility}] ${thread.label}${thread.note ? ` — ${thread.note}` : ''}`),
    ].join('\n'))
  }

  const knowledge = view.characterKnowledge.filter((entry) => characterIds.has(entry.characterId))
  if (knowledge.length > 0) {
    const knowledgeByCharacter = new Map<string, CharacterKnowledgeEntry[]>()
    for (const entry of knowledge) {
      const entries = knowledgeByCharacter.get(entry.characterId) ?? []
      entries.push(entry)
      knowledgeByCharacter.set(entry.characterId, entries)
    }
    parts.push([
      '### Character awareness boundaries',
      ...[...knowledgeByCharacter].map(([characterId, entries]) => [
        `${characterId} explicitly knows:`,
        ...entries.map((entry) => `- ${entry.fact}`),
      ].join('\n')),
    ].filter((line): line is string => Boolean(line)).join('\n\n'))
  }

  return parts.join('\n\n')
}

/**
 * What one character knows, addressed to them.
 *
 * Deliberately narrower than the authorial view: durable state and story threads
 * are authorial records, and a character allowed to read them starts acting on
 * offstage facts. The awareness boundary is the part that is theirs — and the
 * part that stops a reply from treating the story summary, which sits in the same
 * prompt, as the character's own memory.
 */
function renderSelfAwareness(view: ContinuityView, characterId: string): string {
  const known = view.characterKnowledge.filter((entry) => entry.characterId === characterId)
  return [
    '## What You Know',
    'Your character sheet and the list below are your memory. The story summary and events elsewhere in this prompt are context for the author, not for you: if something appears there and not here, you have not learned it.',
    ...(known.length > 0
      ? known.map((entry) => `- ${entry.fact} (${entry.acquisition})`)
      : ['- (nothing beyond your character sheet and the present conversation)']),
  ].join('\n')
}

/** Full keyed registry for the Librarian, including dormant unresolved threads. */
function renderContinuityRegistry(view: ContinuityView, characterIds: Set<string>): string {
  const parts = [
    '## Continuity Registry Before This Passage',
    'Reuse the exact keys below. Thread omission means dormancy, never resolution; resolve or abandon only with explicit source evidence.',
  ]
  if (view.currentState.length > 0) {
    parts.push([
      '### Current state keys',
      ...view.currentState.map((item) => `- ${item.stateKey} | ${item.subject} | ${item.value}`),
    ].join('\n'))
  }
  if (view.liveThreads.length > 0) {
    parts.push([
      '### Live thread keys',
      ...view.liveThreads.map((thread) => `- ${thread.threadKey} | ${thread.visibility} | ${thread.label}${thread.note ? ` | ${thread.note}` : ''}`),
    ].join('\n'))
  }
  const knowledge = characterIds.size > 0
    ? view.characterKnowledge.filter((entry) => characterIds.has(entry.characterId))
    : []
  if (knowledge.length > 0) {
    parts.push([
      '### Character knowledge keys',
      ...knowledge.map((entry) => `- ${entry.characterId} | ${entry.knowledgeKey} | ${entry.fact}`),
    ].join('\n'))
  }
  return parts.join('\n\n')
}
