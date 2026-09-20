import type { Fragment } from '@/contracts/story'
import { listFragments } from '../fragments/storage'
import {
  getAnalysis,
  getAnalysisIndex,
  type LibrarianAnalysis,
  type LibrarianAnalysisIndex,
} from './storage'
import { proseContentHash } from './continuity-source'
import { continuityKeyLabel, normalizeContinuityKey, scopedContinuityIdentity } from '@/lib/continuity-keys'
import type {
  CharacterKnowledgeEntry,
  ContinuityLedger,
  ContinuityRegistry,
  ContinuityView,
  CurrentStateEntry,
  FoldedCharacterLiveState,
  FoldedEntityLiveState,
  LiveThreadEntry,
  ProjectionSource,
  RegistryEntry,
  SceneFrame,
} from '@/contracts/continuity'

export type {
  CharacterKnowledgeEntry,
  ContinuityLedger,
  ContinuityView,
  CurrentStateEntry,
  FoldedCharacterLiveState,
  FoldedEntityLiveState,
  LiveThreadEntry,
  ProjectionSource,
  SceneFrame,
}

const MAX_CURRENT_STATE = 24
const MAX_KNOWLEDGE_PER_CHARACTER = 16
const MAX_LIVE_LIST_ITEMS = 24
const MAX_CHARACTER_STATES = 24
const MAX_ENTITY_STATES = 24
/**
 * Threads only leave this list when resolved or abandoned, so an unbounded list
 * grows for the life of the story. It is not just a rendering concern: the live
 * registry is rendered into the analyst prompt, so every extra key still costs
 * context budget on the model least able to spare it.
 */
const MAX_LIVE_THREADS = 24
const MAX_CACHE_ENTRIES = 32
const CLEARED_STATE_VALUES = new Set(['none', 'cleared', 'removed', 'healed', 'empty', 'normal', 'default', 'null', 'undefined'])

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
 */
export async function buildContinuityLedger(params: {
  dataDir: string
  storyId: string
  activeProseFragments: Fragment[]
  analysisIndex?: LibrarianAnalysisIndex | null
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

  const fragmentHashes = new Map(
    params.activeProseFragments.map((fragment) => [fragment.id, proseContentHash(fragment)]),
  )
  const signature = [
    ...params.activeProseFragments.map((fragment) => (
      `${fragment.id}:${fragmentHashes.get(fragment.id)}:${index.latestProjectionByFragmentId[fragment.id]?.analysisId ?? ''}`
    )),
  ].join('|')
  const cacheKey = `${params.dataDir}\u0000${params.storyId}`
  const cached = ledgerCache.get(cacheKey)
  if (cached?.signature === signature) return cloneLedger(cached.ledger)

  const sources = params.activeProseFragments
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

  type SceneCursor = { frame?: SceneFrame; state: Map<string, CurrentStateEntry> }
  let cursor: SceneCursor = { state: new Map() }
  const suspended: SceneCursor[] = []
  const liveThreads = new Map<string, LiveThreadEntry>()
  const characterKnowledge = new Map<string, CharacterKnowledgeEntry>()
  const liveCharacters = new Map<string, FoldedCharacterLiveState>()
  const liveEntities = new Map<string, FoldedEntityLiveState>()
  const threadVisibility = new Map<string, LiveThreadEntry['visibility']>()
  let staleProjectionCount = 0
  let sawCharacterRoster = false

  for (const item of loaded) {
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
      suspended.push(cursor)
      cursor = { state: new Map() }
    } else if (transition === 'return') {
      cursor = suspended.pop() ?? { state: new Map() }
    }

    if (transition === 'cut') {
      for (const [key, entry] of cursor.state) {
        if (entry.scope === 'scene') cursor.state.delete(key)
      }
      for (const [_, char] of liveCharacters) {
        char.immediate = undefined
        char.present = false
      }
      for (const [_, ent] of liveEntities) {
        ent.immediate = undefined
        ent.present = false
      }
    }
    const impliedLine = transition === 'enter-flashback'
      ? 'flashback'
      : transition === 'enter-flash-forward'
        ? 'flash-forward'
        : undefined
    const line = transition === 'return'
      ? cursor.frame?.line ?? 'present'
      : impliedLine ?? (scene.line && scene.line !== 'uncertain' ? scene.line : cursor.frame?.line ?? 'present')
    const priorFrame = cursor.frame
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
    cursor.frame = {
      ...source,
      line,
      ...(scene.location ? { location: scene.location } : priorFrame?.location ? { location: priorFrame.location } : {}),
      ...(resultingTime ? { time: resultingTime } : {}),
    }

    // Time expiry is deliberately conservative. Human labels and unresolved
    // calendars never trigger deletion; only a current lower bound strictly
    // beyond a deadline upper bound proves that an assertion expired.
    const currentEarliest = cursor.frame.time?.earliest
      ? Date.parse(cursor.frame.time.earliest)
      : Number.NaN
    if (Number.isFinite(currentEarliest)) {
      for (const [key, entry] of cursor.state) {
        if (!entry.until) continue
        const deadline = entry.until.latest ?? entry.until.earliest
        const deadlineLatest = deadline ? Date.parse(deadline) : Number.NaN
        if (Number.isFinite(deadlineLatest) && currentEarliest > deadlineLatest) cursor.state.delete(key)
      }
    }

    // Prominence is a sparse update, not a snapshot. Omission retains the prior
    // value; dormant is explicit, so an empty model report cannot silently hide
    // every unresolved thread from the Writer.
    for (const focus of projection.threadFocus) {
      threadVisibility.set(normalizeContinuityKey(focus.threadKey), focus.visibility)
    }

    for (const operation of projection.stateOperations) {
      const stateKey = normalizeContinuityKey(operation.stateKey)
      if (operation.action === 'clear') {
        cursor.state.delete(stateKey)
        continue
      }
      cursor.state.delete(stateKey)
      cursor.state.set(stateKey, {
        ...source,
        stateKey,
        subject: operation.subject,
        facet: operation.facet,
        ...(operation.slot ? { slot: operation.slot } : {}),
        value: operation.value,
        certainty: operation.certainty,
        scope: operation.scope,
        ...(operation.until ? { until: operation.until } : {}),
      })
    }

    // Narrative threads are reader-facing continuity and can be opened or
    // resolved by any scene. Their prominence remains a separate sparse delta.
    for (const operation of projection.threadOperations) {
      const threadKey = normalizeContinuityKey(operation.threadKey)
      if (operation.action === 'resolve' || operation.action === 'abandon') {
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
        ...(operation.note ? { note: operation.note } : existing?.note ? { note: existing.note } : {}),
        relatedFragmentIds: operation.relatedFragmentIds.length > 0
          ? operation.relatedFragmentIds
          : existing?.relatedFragmentIds ?? [],
        visibility: 'dormant',
      })
    }

    if (cursor.frame.line !== 'flash-forward') {
      for (const operation of projection.knowledgeOperations) {
        const key = scopedContinuityIdentity(operation.knowledgeKey, operation.characterId)
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

    const presentCharacterKeys = projection.presentCharacterKeys
      ?? (projection.characterStates ? Object.keys(projection.characterStates) : undefined)
    if (presentCharacterKeys) {
      sawCharacterRoster = true
      for (const character of liveCharacters.values()) {
        character.present = false
        character.immediate = undefined
      }
    }
    const presentCharacterSet = new Set((presentCharacterKeys ?? []).map(normalizeContinuityKey))

    if (projection.characterStates) {
      for (const [key, update] of Object.entries(projection.characterStates)) {
        const charKey = normalizeContinuityKey(key)
        const existing = liveCharacters.get(charKey)
        const state = existing ? { ...existing.state } : {}
        if (update.state) {
          for (const [sKey, sVal] of Object.entries(update.state)) {
            const normalizedStateKey = sKey.trim()
            if (!sVal || CLEARED_STATE_VALUES.has(sVal.toLowerCase())) {
              delete state[normalizedStateKey]
            } else {
              state[normalizedStateKey] = sVal
            }
          }
        }
        const knowledge = takeLatest([...new Set([
          ...(existing?.knowledge ?? []),
          ...(update.knowledge ?? []),
        ])], MAX_LIVE_LIST_ITEMS)
        const secrets = takeLatest([...new Set([
          ...(existing?.secrets ?? []),
          ...(update.secrets ?? []),
        ])], MAX_LIVE_LIST_ITEMS)
        liveCharacters.set(charKey, {
          ...source,
          characterId: update.characterId ?? existing?.characterId,
          name: update.name || existing?.name || key,
          immediate: update.immediate ?? existing?.immediate,
          state,
          knowledge,
          secrets,
          ...(presentCharacterKeys ? { present: presentCharacterSet.has(charKey) } : existing?.present !== undefined ? { present: existing.present } : {}),
        })
      }
    }

    const presentEntityKeys = projection.presentEntityKeys
      ?? (projection.entityStates ? Object.keys(projection.entityStates) : undefined)
    if (presentEntityKeys) {
      for (const entity of liveEntities.values()) {
        entity.present = false
        entity.immediate = undefined
      }
    }
    const presentEntitySet = new Set((presentEntityKeys ?? []).map(normalizeContinuityKey))

    if (projection.entityStates) {
      for (const [key, update] of Object.entries(projection.entityStates)) {
        const entityKey = normalizeContinuityKey(key)
        const existing = liveEntities.get(entityKey)
        const state = existing ? { ...existing.state } : {}
        if (update.state) {
          for (const [sKey, sVal] of Object.entries(update.state)) {
            const normalizedStateKey = sKey.trim()
            if (!sVal || CLEARED_STATE_VALUES.has(sVal.toLowerCase())) {
              delete state[normalizedStateKey]
            } else {
              state[normalizedStateKey] = sVal
            }
          }
        }
        const notes = takeLatest([...new Set([
          ...(existing?.notes ?? []),
          ...(update.notes ?? []),
        ])], MAX_LIVE_LIST_ITEMS)
        liveEntities.set(entityKey, {
          ...source,
          entityId: update.entityId ?? existing?.entityId,
          name: update.name || existing?.name || key,
          category: update.category ?? existing?.category,
          immediate: update.immediate ?? existing?.immediate,
          state,
          notes,
          ...(presentEntityKeys ? { present: presentEntitySet.has(entityKey) } : existing?.present !== undefined ? { present: existing.present } : {}),
        })
      }
    }
  }

  const allThreads: LiveThreadEntry[] = [...liveThreads.values()].map((thread) => ({
    ...thread,
    visibility: threadVisibility.get(thread.threadKey) ?? ('dormant' as const),
  }))
  const characters = await listFragments(params.dataDir, params.storyId, 'character').catch(() => [])
  for (const char of characters) {
    const existingKey = [...liveCharacters].find(([, entry]) => entry.characterId === char.id)?.[0]
      ?? normalizeContinuityKey(char.name)
    if (liveCharacters.has(existingKey)) continue
    const liveState = char.meta?.liveState as {
      immediate?: string
      state?: Record<string, string>
      knowledge?: string[]
      secrets?: string[]
    } | undefined
    if (liveState && (liveState.immediate || (liveState.state && Object.keys(liveState.state).length > 0) || (liveState.knowledge && liveState.knowledge.length > 0) || (liveState.secrets && liveState.secrets.length > 0))) {
      liveCharacters.set(normalizeContinuityKey(char.name), {
        sourceFragmentId: char.id,
        analysisId: '',
        narrativePosition: 0,
        characterId: char.id,
        name: char.name,
        immediate: liveState.immediate,
        state: liveState.state ?? {},
        knowledge: liveState.knowledge ?? [],
        secrets: liveState.secrets ?? [],
        ...(sawCharacterRoster ? { present: false } : {}),
      })
    }
  }

  const allCharacters = [...liveCharacters.values()]
  const allEntities = [...liveEntities.values()]
  const ledger: ContinuityLedger | undefined = (
    cursor.state.size > 0
    || allThreads.length > 0
    || characterKnowledge.size > 0
    || allCharacters.length > 0
    || allEntities.length > 0
    || hasSceneSignal(cursor.frame)
  ) ? {
      currentState: [...cursor.state.values()],
      liveThreads: allThreads,
      characterKnowledge: [...characterKnowledge.values()],
      ...(allCharacters.length > 0 ? { characterStates: allCharacters } : {}),
      ...(allEntities.length > 0 ? { entityStates: allEntities } : {}),
      currentScene: cursor.frame,
      staleProjectionCount,
    } : undefined

  cacheSet(cacheKey, signature, cloneLedger(ledger))
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
  const currentState = takeLatest(ledger.currentState, MAX_CURRENT_STATE)

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

  // Per-character rather than overall: one talkative character must not crowd
  // the rest out of the registry the analyst reuses keys from.
  const knowledgeByCharacterId = new Map<string, CharacterKnowledgeEntry[]>()
  for (const entry of ledger.characterKnowledge) {
    knowledgeByCharacterId.set(entry.characterId, [...(knowledgeByCharacterId.get(entry.characterId) ?? []), entry])
  }
  const characterKnowledge = [...knowledgeByCharacterId.values()]
    .flatMap((entries) => takeLatest(entries, MAX_KNOWLEDGE_PER_CHARACTER))
  const characterStates = ledger.characterStates
    ? takeMostRecentlySourced(ledger.characterStates, MAX_CHARACTER_STATES)
    : undefined
  const entityStates = ledger.entityStates
    ? takeMostRecentlySourced(ledger.entityStates, MAX_ENTITY_STATES)
    : undefined

  return {
    currentState,
    liveThreads,
    characterKnowledge,
    ...(characterStates ? { characterStates } : {}),
    ...(entityStates ? { entityStates } : {}),
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
  | 'registry'
  | 'self'
type AuthorialPresentation = Exclude<ContinuityPresentation, 'registry' | 'self'>
type CharacterScope = 'all' | 'active-cast' | 'passage-candidates' | 'target-related-cast' | 'target-character'

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
  // needs the whole registry rather than a passage-local subset.
  'librarian.chat': { presentation: 'registry', characterScope: 'all' },
  'librarian.refine': { presentation: 'editing-reference', characterScope: 'target-related-cast' },
  // Character optimization is explicitly about one sheet. Pinning and recency
  // must not decide whether that character's own knowledge reaches the editor.
  'librarian.optimize-character': { presentation: 'editing-reference', characterScope: 'target-character' },
  // Second person, own knowledge only. This reader *is* the character, and one
  // given the authorial records starts answering from offstage facts.
  'character-chat.chat': { presentation: 'self' },
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
}

/**
 * What the renderer needs, stated as the minimum rather than as a context type:
 * ids to scope knowledge by, and the folded view itself. Every agent's block
 * context already satisfies this, so a call site passes itself.
 */
export interface ContinuitySource {
  continuityView?: ContinuityView
  /** Complete fold for readers that need identity access beyond prompt values. */
  continuityLedger?: ContinuityLedger
  stickyCharacters?: Array<{ id: string; name?: string }>
  recentCharacters?: Array<{ id: string; name?: string }>
  characterCatalog?: Array<{ id: string; name?: string }>
  allCharacters?: Array<{ id: string; name?: string }>
  attentionCandidateIds?: string[]
  /** The character a `self` reader is speaking as. */
  character?: { id: string; name?: string }
  /** The fragment an editing reader is changing. */
  targetFragment?: { id: string; type: string; name?: string; refs?: string[] }
}

/**
 * Which characters' awareness the reader is entitled to see.
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
    ...(source.continuityView?.characterStates ?? [])
      .filter((character) => character.present !== false && Boolean(character.characterId))
      .map((character) => character.characterId!),
  ])
}

function charactersInScope(source: ContinuitySource, scope: CharacterScope): Set<string> {
  if (scope === 'all') {
    return new Set([
      ...(source.continuityView?.characterKnowledge.map((entry) => entry.characterId) ?? []),
      ...(source.continuityView?.characterStates ?? [])
        .map((character) => character.characterId)
        .filter((id): id is string => Boolean(id)),
    ])
  }
  if (scope === 'passage-candidates') {
    return new Set([
      ...(source.attentionCandidateIds ?? []),
      ...(source.recentCharacters ?? []).map((fragment) => fragment.id),
    ])
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

/** Resolve mutable display names from the current context; folded records keep stable IDs. */
function characterName(source: ContinuitySource, characterId: string): string | undefined {
  const candidates = [
    source.character,
    source.targetFragment?.type === 'character' ? source.targetFragment : undefined,
    ...(source.stickyCharacters ?? []),
    ...(source.recentCharacters ?? []),
    ...(source.characterCatalog ?? []),
    ...(source.allCharacters ?? []),
  ]
  return candidates.find((candidate) => candidate?.id === characterId)?.name?.trim() || undefined
}

/**
 * Give every authorial group an unambiguous display label without leaking its
 * storage ID. Duplicate current names and unavailable sheets receive stable
 * ordinals in the order their folded knowledge appears.
 */
function characterLabels(source: ContinuitySource, characterIds: Iterable<string>): Map<string, string> {
  const resolved = [...characterIds].map((id) => ({ id, name: characterName(source, id) }))
  const counts = new Map<string, number>()
  for (const { name } of resolved) {
    if (!name) continue
    const key = name.toLocaleLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const labels = new Map<string, string>()
  const seenNames = new Map<string, number>()
  let unavailable = 0
  for (const { id, name } of resolved) {
    if (!name) {
      unavailable += 1
      labels.set(id, `Unavailable character ${unavailable}`)
      continue
    }
    const key = name.toLocaleLowerCase()
    if ((counts.get(key) ?? 0) === 1) {
      labels.set(id, name)
      continue
    }
    const ordinal = (seenNames.get(key) ?? 0) + 1
    seenNames.set(key, ordinal)
    labels.set(id, `${name} (character ${ordinal})`)
  }
  return labels
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
  if (presentation === 'registry') {
    return renderContinuityRegistry(source, reader === 'librarian.chat')
  }
  return renderAuthorialContinuity(
    source,
    view,
    presentation,
    charactersInScope(source, policy.characterScope),
    reader === 'librarian.analyze',
  )
}

function renderAuthorialContinuity(
  source: ContinuitySource,
  view: ContinuityView,
  presentation: AuthorialPresentation,
  characterIds: Set<string>,
  showThreadKeys: boolean,
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
  if (view.currentState.length > 0) {
    parts.push([
      '### Current narrative state',
      ...view.currentState.map((item) => (
        `- ${item.subject.label} — ${item.facet}${item.slot ? `/${item.slot}` : ''}: ${item.value}`
      )),
    ].join('\n'))
  }

  const threads = copy.includeDormantThreads
    ? view.liveThreads
    : view.liveThreads.filter((thread) => thread.visibility !== 'dormant')
  if (threads.length > 0) {
    parts.push([
      copy.threadHeading,
      copy.threadGuidance,
      ...threads.map((thread) => `- [${thread.visibility}]${showThreadKeys ? ` [${thread.threadKey}]` : ''} ${thread.label}${thread.note ? ` — ${thread.note}` : ''}`),
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
    const labels = characterLabels(source, knowledgeByCharacter.keys())
    parts.push([
      '### Character awareness boundaries',
      ...[...knowledgeByCharacter].map(([characterId, entries]) => [
        `${labels.get(characterId)} knows or believes:`,
        ...entries.map((entry) => `- ${entry.fact}`),
      ].join('\n')),
    ].filter((line): line is string => Boolean(line)).join('\n\n'))
  }

  const scopedCharacterStates = (view.characterStates ?? []).filter((character) => (
    character.present !== false
    && (!character.characterId || characterIds.has(character.characterId))
  ))
  if (scopedCharacterStates.length > 0) {
    const lines: string[] = ['### Active character live states']
    for (const char of scopedCharacterStates) {
      const details: string[] = []
      if (char.immediate) {
        details.push(`  - Immediate: ${char.immediate}`)
      }
      const statePairs = Object.entries(char.state).filter(([_, v]) => Boolean(v))
      if (statePairs.length > 0) {
        details.push(`  - State: ${statePairs.map(([k, v]) => `${k}: ${v}`).join(' | ')}`)
      }
      if (char.knowledge.length > 0) {
        details.push(`  - Knowledge: ${char.knowledge.join('; ')}`)
      }
      if (char.secrets.length > 0) {
        details.push(`  - Secrets: ${char.secrets.join('; ')}`)
      }
      if (details.length > 0) {
        lines.push(`- **${char.name}**${char.characterId ? ` (\`${char.characterId}\`)` : ''}\n${details.join('\n')}`)
      }
    }
    if (lines.length > 1) {
      parts.push(lines.join('\n'))
    }
  }

  const activeEntityStates = (view.entityStates ?? []).filter((entity) => entity.present !== false)
  if (activeEntityStates.length > 0) {
    const lines: string[] = ['### Active entity live states']
    for (const ent of activeEntityStates) {
      const details: string[] = []
      if (ent.immediate) {
        details.push(`  - Immediate: ${ent.immediate}`)
      }
      const statePairs = Object.entries(ent.state).filter(([_, v]) => Boolean(v))
      if (statePairs.length > 0) {
        details.push(`  - State: ${statePairs.map(([k, v]) => `${k}: ${v}`).join(' | ')}`)
      }
      if (ent.notes.length > 0) {
        details.push(`  - Notes: ${ent.notes.join('; ')}`)
      }
      if (details.length > 0) {
        lines.push(`- **${ent.name}**${ent.entityId ? ` (\`${ent.entityId}\`)` : ''}${ent.category ? ` [${ent.category}]` : ''}\n${details.join('\n')}`)
      }
    }
    if (lines.length > 1) {
      parts.push(lines.join('\n'))
    }
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
function renderSelfAwareness(view: ContinuityView | undefined, characterId: string): string {
  const known = view?.characterKnowledge.filter((entry) => entry.characterId === characterId) ?? []
  const charState = view?.characterStates?.find((c) => c.characterId === characterId)
  const lines = [
    '## What You Know',
    'Your character sheet and the list below are your memory. Do not infer knowledge from authorial story material or from what other characters know: if something does not appear here, you have not learned it.',
  ]
  if (charState) {
    if (charState.immediate) {
      lines.push(`- Immediate: ${charState.immediate}`)
    }
    const statePairs = Object.entries(charState.state).filter(([_, v]) => Boolean(v))
    if (statePairs.length > 0) {
      lines.push(`- Physical state: ${statePairs.map(([k, v]) => `${k}: ${v}`).join(' | ')}`)
    }
    if (charState.secrets.length > 0) {
      lines.push(...charState.secrets.map((s) => `- Private: ${s}`))
    }
    if (charState.knowledge.length > 0) {
      lines.push(...charState.knowledge.map((k) => `- ${k}`))
    }
  }
  if (known.length > 0) {
    lines.push(...known.map((entry) => `- ${entry.fact} (${entry.acquisition})`))
  }
  if (!charState && known.length === 0) {
    lines.push('- (nothing beyond your character sheet and the present conversation)')
  }
  return lines.join('\n')
}

/**
 * The registry as the analyst sees it. The block it reads and the tool it writes
 * back through are built from this one function, so an entry number means the
 * same thing on both sides — knowledge is filtered by character scope here, and
 * a second derivation would silently number it differently.
 */
export function continuityRegistry(
  source: ContinuitySource,
  options: { includeAllDetails?: boolean } = {},
): ContinuityRegistry {
  const view = source.continuityView
  const ledger = source.continuityLedger ?? view
  if (!ledger) return { state: [], thread: [], knowledge: [] }
  const characterIds = charactersInScope(source, 'passage-candidates')
  const knowers = characterLabels(source, ledger.characterKnowledge.map((entry) => entry.characterId))
  const detailedState = new Set(view?.currentState.map((entry) => entry.stateKey) ?? [])
  const detailedThreads = new Set(view?.liveThreads.map((entry) => entry.threadKey) ?? [])
  const detailedKnowledge = new Set(
    view?.characterKnowledge.map((entry) => scopedContinuityIdentity(entry.knowledgeKey, entry.characterId)) ?? [],
  )
  return {
    state: ledger.currentState.map((item, index) => ({
      index: index + 1,
      key: item.stateKey,
      label: `${item.subject.label} — ${item.facet}${item.slot ? `/${item.slot}` : ''}`,
      ...(options.includeAllDetails || detailedState.has(item.stateKey) ? { detail: item.value } : {}),
      subject: item.subject,
      facet: item.facet,
      ...(item.slot ? { slot: item.slot } : {}),
    })),
    thread: ledger.liveThreads.map((thread, index) => ({
      index: index + 1,
      key: thread.threadKey,
      label: thread.label,
      detail: options.includeAllDetails || detailedThreads.has(thread.threadKey)
        ? (thread.note ? `${thread.visibility} — ${thread.note}` : thread.visibility)
        : thread.visibility,
    })),
    knowledge: ledger.characterKnowledge
      .filter((entry) => characterIds.has(entry.characterId))
      .map((entry, index) => ({
        index: index + 1,
        key: entry.knowledgeKey,
        label: options.includeAllDetails
          || detailedKnowledge.has(scopedContinuityIdentity(entry.knowledgeKey, entry.characterId))
          ? entry.fact
          : continuityKeyLabel(entry.knowledgeKey),
        detail: `known by ${knowers.get(entry.characterId)} (${entry.characterId})`,
        scope: entry.characterId,
      })),
  }
}

/** Full keyed registry for the Librarian, including dormant unresolved threads. */
export function renderContinuityRegistry(source: ContinuitySource, includeAllDetails: boolean): string {
  const registry = continuityRegistry(source, { includeAllDetails })
  const section = (heading: string, entries: RegistryEntry[], guidance?: string): string | null => (
    entries.length === 0 ? null : [
      heading,
      ...(guidance ? [guidance] : []),
      ...entries.map((entry) => (
        `[${entry.index}] ${entry.key} | ${entry.label}${entry.detail ? ` | ${entry.detail}` : ''}`
      )),
    ].join('\n')
  )
  return [
    '## Continuity Registry Before This Passage',
    'These are tracked continuity identities in the branch-local ledger (NOT catalog fragment IDs). Point at an entry by its number to update it; only a genuinely new condition or thread gets a fresh key.',
    section('### Current state (update via stateOperations: set/clear)', registry.state),
    section('### Live threads (update via threadOperations: open/advance/resolve/abandon)', registry.thread, 'Opening or advancing a thread promotes it automatically. Resolve or abandon only with explicit source evidence.'),
    section(
      '### Character knowledge (update via knowledgeOperations: learn/correct/forget)',
      registry.knowledge,
      'The character is the knower, not necessarily the person or thing described by the fact.',
    ),
  ].filter((part): part is string => part !== null).join('\n\n')
}
