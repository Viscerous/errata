import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useSyncExternalStore, memo } from 'react'
import { useQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api, type Fragment, type ProseChainEntry } from '@/lib/api'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StreamMarkdown } from '@/components/ui/stream-markdown'
import { Wand2, Bookmark, List } from 'lucide-react'
import { Hint, Caption } from '@/components/ui/prose-text'
import { useQuickSwitch, useProseWidth, PROSE_WIDTH_VALUES, useMentionTypes, BASE_MENTION_TYPES } from '@/lib/theme'
import { parseVisualRefs } from '@/lib/fragment-visuals'
import { ProseBlock } from './ProseBlock'
import { ChapterMarker } from './ChapterMarker'
import { InlineGenerationInput, type ThoughtStep } from './InlineGenerationInput'
import { GenerationThoughts } from './GenerationThoughts'
import { ProseOutlinePanel } from './ProseOutlinePanel'
import { MentionProvider } from './MentionContext'
import { formatDialogue } from '@/lib/fragment-mentions'
import { onActiveBranchChanged, invalidateStoryContent } from '@/lib/branch-cache'
import { qk, q, useActiveBranchId } from '@/lib/query-keys'

interface ProseChainViewProps {
  storyId: string
  coverImage?: string | null
  outlineOpen?: boolean
  onSelectFragment: (fragment: Fragment) => void
  onEditProse?: (fragmentId: string, selectedText?: string) => void
  onDebugLog?: (logId: string) => void
  onLaunchWizard?: () => void
  onAskLibrarian?: (fragmentId: string, prefill?: string) => void
}

const GENERATION_HANDOFF_ANCHOR = 'generation-handoff'

interface PendingGenerationMeta {
  id: number
  prompt: string
  fragmentCountBefore: number
}

interface GenerationStreamSnapshot {
  text: string
  thoughts: ThoughtStep[]
  version: number
}

interface GenerationViewportAnchor {
  generationId: number
  blockIndex: number
  offsetY: number
  targetY: number
}

interface GenerationStreamStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => GenerationStreamSnapshot
  reset: () => void
  setText: (text: string) => void
  setThoughts: (thoughts: ThoughtStep[]) => void
}

const EMPTY_STREAM_SNAPSHOT: GenerationStreamSnapshot = {
  text: '',
  thoughts: [],
  version: 0,
}

function createGenerationStreamStore(): GenerationStreamStore {
  let snapshot = EMPTY_STREAM_SNAPSHOT
  const listeners = new Set<() => void>()
  let emitScheduled = false

  const emit = () => {
    emitScheduled = false
    for (const listener of listeners) listener()
  }

  const scheduleEmit = () => {
    if (emitScheduled) return
    emitScheduled = true
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(emit)
    } else {
      Promise.resolve().then(emit)
    }
  }

  const replaceSnapshot = (next: Omit<GenerationStreamSnapshot, 'version'>) => {
    snapshot = {
      ...next,
      version: snapshot.version + 1,
    }
    scheduleEmit()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return snapshot
    },
    reset() {
      if (!snapshot.text && snapshot.thoughts.length === 0) return
      replaceSnapshot({ text: '', thoughts: [] })
    },
    setText(text) {
      if (snapshot.text === text) return
      replaceSnapshot({ text, thoughts: snapshot.thoughts })
    },
    setThoughts(thoughts) {
      if (snapshot.thoughts === thoughts) return
      replaceSnapshot({ text: snapshot.text, thoughts })
    },
  }
}

type ProseListRow =
  { key: string; fragment: Fragment; displayIndex: number }

function estimateProseRowSize(content: string | undefined): number {
  const text = content ?? ''
  const lineBreaks = text.match(/\n/g)?.length ?? 0
  return Math.max(140, Math.min(2400, text.length * 0.34 + lineBreaks * 12 + 96))
}

/** Thin hover zone between blocks that reveals a "+ Chapter" insert button */
// An always-visible typographic break between prose blocks. The hairline +
// italic serif label reads as a book-section ornament at rest; hovering
// brightens both and invites a click. Anywhere along the line inserts a
// new chapter marker at this position. Hidden adjacent to existing markers
// so we never stack a chapter hint against a real chapter boundary.
const InsertChapterDivider = memo(function InsertChapterDivider({
  storyId,
  position,
}: {
  storyId: string
  position: number
}) {
  const queryClient = useQueryClient()
  const createMutation = useMutation({
    mutationFn: () =>
      api.chapters.create(storyId, {
        name: `Chapter ${position + 1}`,
        position,
      }),
    onSuccess: () => invalidateStoryContent(queryClient, storyId),
  })

  return (
    <button
      type="button"
      onClick={() => createMutation.mutate()}
      disabled={createMutation.isPending}
      aria-label="Insert chapter marker here"
      className="group/insert w-full flex items-center gap-3 py-1.5 my-0.5 transition-opacity focus-visible:outline-none focus-visible:opacity-100"
    >
      <span aria-hidden className="flex-1 h-px bg-border/30 group-hover/insert:bg-primary/40 transition-colors" />
      <span className="text-[0.6875rem] font-display italic text-muted-foreground/35 group-hover/insert:text-foreground/75 transition-colors whitespace-nowrap flex items-center gap-1.5">
        <Bookmark className="size-2.5 text-muted-foreground/25 group-hover/insert:text-primary/70 transition-colors" aria-hidden />
        <span>—&nbsp;chapter&nbsp;—</span>
      </span>
      <span aria-hidden className="flex-1 h-px bg-border/30 group-hover/insert:bg-primary/40 transition-colors" />
    </button>
  )
})

function PendingGenerationBlock({
  pending,
  streamStore,
  isGenerating,
  defaultExpanded,
  onBeforeThoughtsCollapse,
  onAfterThoughtsCollapse,
}: {
  pending: PendingGenerationMeta
  streamStore: GenerationStreamStore
  isGenerating: boolean
  defaultExpanded: boolean
  onBeforeThoughtsCollapse: () => void
  onAfterThoughtsCollapse: () => void
}) {
  const snapshot = useSyncExternalStore(
    streamStore.subscribe,
    streamStore.getSnapshot,
    streamStore.getSnapshot,
  )

  return (
    <div className="relative mb-6 animate-in fade-in slide-in-from-bottom-2 duration-300" data-component-id="prose-streaming-block">
      {pending.prompt && (
        <div className="mb-3 -mt-2 flex items-start gap-2.5">
          <div className="w-0.5 min-h-[1.25rem] rounded-full bg-primary/20 shrink-0 mt-0.5" />
          <Caption size="sm" className="font-display italic truncate text-muted-foreground/60 select-none">
            {pending.prompt}
          </Caption>
        </div>
      )}
      <div className="rounded-lg p-4 -mx-4 bg-card/30">
        {snapshot.thoughts.length > 0 && (
          <GenerationThoughts
            steps={snapshot.thoughts}
            streaming={isGenerating}
            hasText={!!snapshot.text}
            defaultExpanded={defaultExpanded}
            onBeforeAutoCollapse={onBeforeThoughtsCollapse}
            onAfterAutoCollapse={onAfterThoughtsCollapse}
          />
        )}
        <StreamMarkdown
          content={snapshot.text}
          streaming={isGenerating}
          variant="prose"
          textTransform={formatDialogue}
          anchorId={GENERATION_HANDOFF_ANCHOR}
        />
      </div>
    </div>
  )
}

export function ProseChainView({
  storyId,
  coverImage,
  outlineOpen,
  onSelectFragment,
  onEditProse,
  onDebugLog,
  onLaunchWizard,
  onAskLibrarian,
}: ProseChainViewProps) {

  const [activeIndex, setActiveIndex] = useState(0)
  const activeIndexRef = useRef(0)
  const [mobileTocOpen, setMobileTocOpen] = useState(false)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const composerOverlayRef = useRef<HTMLDivElement>(null)
  const [composerHeight, setComposerHeight] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const [pendingGeneration, setPendingGeneration] = useState<PendingGenerationMeta | null>(null)
  const generationStreamStoreRef = useRef<GenerationStreamStore | null>(null)
  if (!generationStreamStoreRef.current) {
    generationStreamStoreRef.current = createGenerationStreamStore()
  }
  const generationStreamStore = generationStreamStoreRef.current
  const nextGenerationIdRef = useRef(1)
  const followRef = useRef(true)
  const lastTopRef = useRef(0)
  const scrollRafRef = useRef(0)
  const anchorStabilizeRafRef = useRef(0)
  const generationAnchorTopRef = useRef<number | null>(null)
  const generationViewportAnchorRef = useRef<GenerationViewportAnchor | null>(null)
  const handoffRestoredGenerationRef = useRef<number | null>(null)
  const savedGenerationHandoffRef = useRef<HTMLDivElement | null>(null)
  const [quickSwitch] = useQuickSwitch()
  const [proseWidth] = useProseWidth()
  const [enabledMentionTypesList] = useMentionTypes()
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)

  const setActiveIndexIfChanged = useCallback((nextIndex: number) => {
    if (activeIndexRef.current === nextIndex) return
    activeIndexRef.current = nextIndex
    setActiveIndex(nextIndex)
  }, [])

  const { data: story } = useQuery({
    queryKey: ['story', storyId],
    queryFn: () => api.stories.get(storyId),
  })

  const enabledMentionTypes = useMemo(
    () => new Set(enabledMentionTypesList),
    [enabledMentionTypesList],
  )

  const mentionFragmentTypes = useMemo(() => {
    const types = new Set<string>(BASE_MENTION_TYPES)
    for (const def of story?.settings.customFragmentTypes ?? []) {
      types.add(def.type)
    }
    return [...types]
  }, [story?.settings.customFragmentTypes])
  const mentionHighlightsEnabled = enabledMentionTypes.size > 0

  // While the librarian is analyzing, poll its status so we can refresh prose as
  // soon as it writes mention annotations (it persists them at the start of the
  // run). Only relevant when mention highlights are on.
  const { data: librarianStatus } = useQuery({
    queryKey: qk.librarianStatus(storyId, branchId),
    queryFn: () => api.librarian.getStatus(storyId),
    enabled: mentionHighlightsEnabled,
    refetchInterval: mentionHighlightsEnabled ? 2_000 : false,
  })
  const isAnalyzing = librarianStatus?.runStatus === 'running'

  // Co-locate both queries so they settle in the same component — prevents
  // desync after regeneration where the chain points to a fragment the stale
  // prop hadn't included yet.
  const { data: proseChain } = useQuery(q.proseChain(storyId, branchId))

  const { data: fragments = [] } = useQuery({
    ...q.fragments(storyId, branchId, 'prose'),
    // Pick up mention annotations mid-run; idle = no extra polling.
    refetchInterval: mentionHighlightsEnabled && isAnalyzing ? 2_000 : false,
  })

  const { data: markerFragments = [] } = useQuery(q.fragments(storyId, branchId, 'marker'))

  const mentionFragmentQueries = useQueries({
    queries: mentionFragmentTypes.map((type) => ({
      ...q.fragments(storyId, branchId, type),
      enabled: mentionHighlightsEnabled,
    })),
  })
  const allMentionFragments = useMemo(
    () => mentionFragmentQueries.flatMap((query) => query.data ?? []),
    [mentionFragmentQueries],
  )
  const mentionFragmentTypesById = useMemo(() => {
    const map = new Map<string, string>()
    for (const fragment of allMentionFragments) {
      map.set(fragment.id, fragment.type)
    }
    return map
  }, [allMentionFragments])

  // Prose headers need image fragments even when character-mentions are off.
  const anyProseHasImage = useMemo(
    () => fragments.some((f) => parseVisualRefs(f.meta).some((r) => r.kind === 'image')),
    [fragments],
  )

  const { data: imageFragments = [] } = useQuery({
    ...q.fragments(storyId, branchId, 'image'),
    enabled: mentionHighlightsEnabled || anyProseHasImage,
  })

  const { data: iconFragments = [] } = useQuery({
    ...q.fragments(storyId, branchId, 'icon'),
    enabled: mentionHighlightsEnabled,
  })

  const { data: analysisIndex } = useQuery({
    queryKey: qk.librarianAnalysisIndex(storyId, branchId),
    queryFn: () => api.librarian.getAnalysisIndex(storyId),
    refetchInterval: 10_000,
  })

  const analyzedFragments = useMemo(
    () => new Set(Object.keys(analysisIndex ?? {})),
    [analysisIndex],
  )

  const analyzeMutation = useMutation({
    mutationFn: (fragmentId: string) => api.librarian.analyze(storyId, fragmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['librarian-analysis-index', storyId] })
    },
  })

  const handleAnalyze = useCallback((fragmentId: string) => {
    analyzeMutation.mutate(fragmentId)
  }, [analyzeMutation])

  // Build media lookup for character portraits in hover cards
  const mediaById = useMemo(() => {
    const map = new Map<string, Fragment>()
    for (const f of imageFragments) map.set(f.id, f)
    for (const f of iconFragments) map.set(f.id, f)
    return map
  }, [imageFragments, iconFragments])

  // Build color overrides from character `color=` tags.
  // Ref-stabilised: return the previous Map when entries haven't changed so
  // downstream memo'd components keep the same reference.
  const mentionColorsRef = useRef<Map<string, string>>(new Map())
  const mentionColors = useMemo(() => {
    const next = new Map<string, string>()
    for (const char of allMentionFragments) {
      if (char.type !== 'character') continue
      const tag = char.tags.find(t => t.startsWith('color='))
      if (!tag) continue
      const value = tag.slice(6)
      if (/^#[0-9a-fA-F]{3,8}$/.test(value) || value.startsWith('oklch(')) {
        next.set(char.id, value)
      }
    }
    const prev = mentionColorsRef.current
    if (prev.size === next.size) {
      let same = true
      for (const [k, v] of next) {
        if (prev.get(k) !== v) { same = false; break }
      }
      if (same) return prev
    }
    mentionColorsRef.current = next
    return next
  }, [allMentionFragments])

  // Build combined fragment map from prose + markers
  const allFragmentsMap = useMemo(() => {
    const map = new Map<string, Fragment>()
    for (const f of fragments) map.set(f.id, f)
    for (const f of markerFragments) map.set(f.id, f)
    return map
  }, [fragments, markerFragments])

  // Build ordered items from chain entries using the combined map
  const orderedItems = useMemo(() => {
    if (!proseChain?.entries.length) {
      // Fallback: no chain, show prose sorted naturally (no markers possible)
      return [...fragments].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    }
    const items: Fragment[] = []
    for (const entry of proseChain.entries) {
      const fragment = allFragmentsMap.get(entry.active)
      if (fragment) items.push(fragment)
    }
    return items
  }, [proseChain, allFragmentsMap, fragments])

  // Prose-only subset for generation count tracking
  const orderedProseFragments = useMemo(
    () => orderedItems.filter(f => f.type !== 'marker'),
    [orderedItems],
  )

  // Precompute lookup maps so children receive stable references
  const sectionIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    if (!proseChain) return map
    for (let i = 0; i < proseChain.entries.length; i++) {
      for (const f of proseChain.entries[i].proseFragments) {
        map.set(f.id, i)
      }
    }
    return map
  }, [proseChain])

  const chainEntryMap = useMemo(() => {
    const map = new Map<string, ProseChainEntry>()
    if (!proseChain) return map
    for (const entry of proseChain.entries) {
      for (const f of entry.proseFragments) {
        map.set(f.id, entry)
      }
    }
    return map
  }, [proseChain])

  const lastProseFragment = orderedProseFragments[orderedProseFragments.length - 1]
  const pendingGenerationSnapshot = pendingGeneration
    ? generationStreamStore.getSnapshot()
    : EMPTY_STREAM_SNAPSHOT
  const hasPersistedPendingGeneration = !!pendingGeneration && (
    orderedProseFragments.length > pendingGeneration.fragmentCountBefore ||
    (!!pendingGenerationSnapshot.text && lastProseFragment?.content === pendingGenerationSnapshot.text)
  )
  const hasSavedPendingGeneration = !isGenerating && hasPersistedPendingGeneration
  const showPendingGeneration = !!pendingGeneration &&
    (isGenerating || pendingGenerationSnapshot.text.length > 0) &&
    !hasSavedPendingGeneration

  const pendingOutlineFragment = useMemo<Fragment | null>(() => {
    if (!showPendingGeneration) return null
    return {
      id: 'pending-generation-fragment',
      type: 'prose',
      name: 'Generating...',
      description: '',
      content: pendingGenerationSnapshot.text || 'Generating...',
      tags: [],
      refs: [],
      sticky: false,
      placement: 'system',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      order: Number.MAX_SAFE_INTEGER,
      meta: {},
      archived: false,
    }
  }, [showPendingGeneration, pendingGenerationSnapshot.text])

  const outlineFragments = useMemo(() => {
    if (pendingOutlineFragment) {
      return [...orderedItems, pendingOutlineFragment]
    }
    return orderedItems
  }, [orderedItems, pendingOutlineFragment])

  const visibleOrderedItems = useMemo(() => {
    if (!pendingGeneration) return orderedItems

    let proseSeen = 0
    return orderedItems.filter((item) => {
      if (item.type === 'marker') return true
      proseSeen += 1
      return proseSeen <= pendingGeneration.fragmentCountBefore
    })
  }, [orderedItems, pendingGeneration])

  const savedGenerationHandoffFragment = pendingGeneration && hasSavedPendingGeneration
    ? lastProseFragment
    : undefined

  const orderedRows = useMemo<ProseListRow[]>(() => {
    return visibleOrderedItems.map((fragment, displayIndex) => {
      const sectionIdx = sectionIndexMap.get(fragment.id) ?? -1
      const key = sectionIdx >= 0 ? `section-${sectionIdx}` : fragment.id
      return { key, fragment, displayIndex }
    })
  }, [visibleOrderedItems, sectionIndexMap])

  const handleDeleteSection = useCallback((sectionIndex: number) => {
    api.proseChain.removeSection(storyId, sectionIndex).then(() => {
      invalidateStoryContent(queryClient, storyId)
    })
  }, [storyId, queryClient])

  // Stable ref to the Radix scroll-area viewport element
  const viewportRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (scrollAreaRef.current) {
      viewportRef.current = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]')
    }
  }, [])
  const getViewport = useCallback(() => viewportRef.current, [])

  useEffect(() => {
    const node = composerOverlayRef.current
    if (!node) return

    const measure = () => {
      const next = Math.ceil(node.getBoundingClientRect().height)
      setComposerHeight((current) => current === next ? current : next)
    }

    measure()
    window.addEventListener('resize', measure)
    if (!window.ResizeObserver) {
      return () => window.removeEventListener('resize', measure)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Measure offset from viewport top to the list container (accounts for cover image + padding)
  const proseContentRef = useRef<HTMLDivElement>(null)
  const listContainerRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)

  useEffect(() => {
    const viewport = getViewport()
    const container = listContainerRef.current
    if (!viewport || !container) return

    const measure = () => {
      const next = container.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
      setScrollMargin((current) => Math.abs(current - next) > 0.5 ? next : current)
    }

    measure()
    let raf = requestAnimationFrame(() => {
      measure()
      raf = requestAnimationFrame(measure)
    })
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [coverImage, getViewport, orderedRows.length])

  const virtualizer = useVirtualizer({
    count: orderedRows.length,
    getScrollElement: getViewport,
    estimateSize: (i) => {
      const row = orderedRows[i]
      if (!row) return 200
      const item = row.fragment
      if (item.type === 'marker') return 100
      return estimateProseRowSize(item.content)
    },
    getItemKey: (i) => orderedRows[i]?.key ?? i,
    overscan: 4,
    scrollMargin,
    useFlushSync: false,
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
    useAnimationFrameWithResizeObserver: true,
    useScrollendEvent: true,
    isScrollingResetDelay: 80,
    onChange: (instance) => {
      const items = instance.getVirtualItems()
      if (!items.length) return
      const viewport = instance.scrollElement
      if (!viewport) return
      const center = viewport.scrollTop + viewport.clientHeight / 2
      for (const item of items) {
        if (item.start <= center && item.end >= center) {
          const row = orderedRows[item.index]
          setActiveIndexIfChanged(row?.displayIndex ?? Math.max(0, visibleOrderedItems.length - 1))
          return
        }
      }

      const hasPendingOrHandoff = showPendingGeneration || !!savedGenerationHandoffFragment
      if (hasPendingOrHandoff && items.length > 0) {
        const lastItem = items[items.length - 1]
        if (lastItem && center > lastItem.end) {
          setActiveIndexIfChanged(visibleOrderedItems.length)
          return
        }
      }

      const row = orderedRows[items[items.length - 1].index]
      setActiveIndexIfChanged(row?.displayIndex ?? Math.max(0, visibleOrderedItems.length - 1))
    },
    enabled: orderedRows.length > 0,
  })

  const getGenerationAnchor = useCallback(() => (
    proseContentRef.current?.querySelector(
      `[data-scroll-anchor="${GENERATION_HANDOFF_ANCHOR}"]`,
    ) as HTMLElement | null
  ), [])

  const getGenerationMarkdownRoot = useCallback(() => (
    getGenerationAnchor()?.closest('.stream-markdown') as HTMLElement | null
  ), [getGenerationAnchor])

  const getGenerationMarkdownBlocks = useCallback(() => {
    const root = getGenerationMarkdownRoot()
    if (!root) return []

    return Array.from(root.children).filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.getBoundingClientRect().height > 0
    ))
  }, [getGenerationMarkdownRoot])

  const measureGenerationAnchorTop = useCallback(() => {
    const anchor = getGenerationAnchor()
    if (!anchor) {
      generationAnchorTopRef.current = null
      return null
    }
    const top = anchor.getBoundingClientRect().top
    generationAnchorTopRef.current = top
    return top
  }, [getGenerationAnchor])

  const captureGenerationViewportAnchor = useCallback(() => {
    const viewport = getViewport()
    if (!viewport || !pendingGeneration) {
      measureGenerationAnchorTop()
      return
    }

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (followRef.current && distanceFromBottom < 32) {
      generationViewportAnchorRef.current = null
      measureGenerationAnchorTop()
      return
    }

    const blocks = getGenerationMarkdownBlocks()
    if (!blocks.length) {
      measureGenerationAnchorTop()
      return
    }

    const viewportRect = viewport.getBoundingClientRect()
    const readingLine = viewportRect.top + Math.min(180, viewport.clientHeight * 0.32)
    let bestBlockIndex = -1
    let bestTargetY = readingLine

    for (let i = 0; i < blocks.length; i += 1) {
      const rect = blocks[i].getBoundingClientRect()
      if (rect.top <= readingLine && rect.bottom >= readingLine) {
        bestBlockIndex = i
        bestTargetY = readingLine
        break
      }
    }

    if (bestBlockIndex === -1) {
      let bestDistance = Number.POSITIVE_INFINITY
      for (let i = 0; i < blocks.length; i += 1) {
        const rect = blocks[i].getBoundingClientRect()
        const intersectsViewport = rect.bottom >= viewportRect.top && rect.top <= viewportRect.bottom
        if (!intersectsViewport) continue

        const targetY = Math.max(rect.top, Math.min(readingLine, rect.bottom))
        const distance = Math.abs(targetY - readingLine)
        if (distance < bestDistance) {
          bestDistance = distance
          bestBlockIndex = i
          bestTargetY = targetY
        }
      }
    }

    if (bestBlockIndex === -1) {
      measureGenerationAnchorTop()
      return
    }

    const blockRect = blocks[bestBlockIndex].getBoundingClientRect()
    generationViewportAnchorRef.current = {
      generationId: pendingGeneration.id,
      blockIndex: bestBlockIndex,
      offsetY: bestTargetY - blockRect.top,
      targetY: bestTargetY,
    }
    measureGenerationAnchorTop()
  }, [getGenerationMarkdownBlocks, getViewport, measureGenerationAnchorTop, pendingGeneration])

  const stabilizeGenerationAnchor = useCallback((desiredTop: number) => {
    const viewport = getViewport()
    const anchor = getGenerationAnchor()
    if (!viewport || !anchor) return

    const applyCorrection = () => {
      const currentAnchor = getGenerationAnchor()
      const currentViewport = getViewport()
      if (!currentAnchor || !currentViewport) return

      const drift = currentAnchor.getBoundingClientRect().top - desiredTop
      if (Math.abs(drift) > 0.5) {
        currentViewport.scrollTop += drift
        lastTopRef.current = currentViewport.scrollTop
      }
      generationAnchorTopRef.current = currentAnchor.getBoundingClientRect().top
    }

    applyCorrection()
    cancelAnimationFrame(anchorStabilizeRafRef.current)
    anchorStabilizeRafRef.current = requestAnimationFrame(applyCorrection)
  }, [getGenerationAnchor, getViewport])

  const restoreMeasuredGenerationAnchor = useCallback(() => {
    const viewport = getViewport()
    const distanceFromBottom = viewport
      ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      : Number.POSITIVE_INFINITY

    if (viewport && followRef.current && distanceFromBottom < 32) {
      viewport.scrollTop = viewport.scrollHeight
      lastTopRef.current = viewport.scrollTop
      measureGenerationAnchorTop()
      return
    }
    if (distanceFromBottom >= 32) followRef.current = false

    const desiredTop = generationAnchorTopRef.current
    if (desiredTop !== null) stabilizeGenerationAnchor(desiredTop)
  }, [getViewport, measureGenerationAnchorTop, stabilizeGenerationAnchor])

  const restoreGenerationViewportAnchor = useCallback(() => {
    const viewport = getViewport()
    const captured = generationViewportAnchorRef.current
    if (!viewport || !captured || captured.generationId !== pendingGeneration?.id) {
      restoreMeasuredGenerationAnchor()
      return
    }

    const applyCorrection = () => {
      const currentViewport = getViewport()
      const blocks = getGenerationMarkdownBlocks()
      if (!currentViewport || !blocks.length) return

      const block = blocks[Math.min(captured.blockIndex, blocks.length - 1)]
      const drift = block.getBoundingClientRect().top + captured.offsetY - captured.targetY
      if (Math.abs(drift) > 0.5) {
        currentViewport.scrollTop += drift
        lastTopRef.current = currentViewport.scrollTop
      }
      measureGenerationAnchorTop()
    }

    applyCorrection()
    cancelAnimationFrame(anchorStabilizeRafRef.current)
    anchorStabilizeRafRef.current = requestAnimationFrame(() => {
      applyCorrection()
      anchorStabilizeRafRef.current = requestAnimationFrame(applyCorrection)
    })
  }, [
    getGenerationMarkdownBlocks,
    getViewport,
    measureGenerationAnchorTop,
    pendingGeneration?.id,
    restoreMeasuredGenerationAnchor,
  ])

  useLayoutEffect(() => {
    if (!pendingGeneration || !hasSavedPendingGeneration) return
    if (handoffRestoredGenerationRef.current === pendingGeneration.id) return

    handoffRestoredGenerationRef.current = pendingGeneration.id
    restoreGenerationViewportAnchor()
  }, [pendingGeneration, hasSavedPendingGeneration, restoreGenerationViewportAnchor])

  const releaseSavedGenerationHandoffIfOffscreen = useCallback(() => {
    if (!pendingGeneration || !hasSavedPendingGeneration) return

    const viewport = getViewport()
    const handoff = savedGenerationHandoffRef.current
    if (!viewport || !handoff) return

    const viewportRect = viewport.getBoundingClientRect()
    const handoffRect = handoff.getBoundingClientRect()
    const releaseMargin = 240
    const isSafelyOffscreen = handoffRect.bottom < viewportRect.top - releaseMargin ||
      handoffRect.top > viewportRect.bottom + releaseMargin

    if (!isSafelyOffscreen) return

    generationViewportAnchorRef.current = null
    generationAnchorTopRef.current = null
    setPendingGeneration(null)
  }, [getViewport, hasSavedPendingGeneration, pendingGeneration])

  useEffect(() => {
    if (!pendingGeneration || !hasSavedPendingGeneration) return

    const viewport = getViewport()
    if (!viewport) return

    const releaseIfOffscreen = () => releaseSavedGenerationHandoffIfOffscreen()
    const timeout = window.setTimeout(releaseIfOffscreen, 0)
    viewport.addEventListener('scroll', releaseIfOffscreen, { passive: true })
    window.addEventListener('resize', releaseIfOffscreen)

    return () => {
      window.clearTimeout(timeout)
      viewport.removeEventListener('scroll', releaseIfOffscreen)
      window.removeEventListener('resize', releaseIfOffscreen)
    }
  }, [
    getViewport,
    hasSavedPendingGeneration,
    pendingGeneration,
    releaseSavedGenerationHandoffIfOffscreen,
  ])

  const stopFollowingGeneration = useCallback(() => {
    if (!followRef.current) return
    followRef.current = false
    cancelAnimationFrame(scrollRafRef.current)
  }, [])

  // Auto-follow the bottom while generating. Any user scroll-up disengages it;
  // returning to the bottom re-engages it.
  useEffect(() => {
    const viewport = getViewport()
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stopFollowingGeneration()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'ArrowUp' ||
        event.key === 'PageUp' ||
        event.key === 'Home'
      ) {
        stopFollowingGeneration()
      }
    }
    const onScroll = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      if (distanceFromBottom < 24) followRef.current = true
      else if (viewport.scrollTop < lastTopRef.current - 2 || distanceFromBottom > 96) followRef.current = false
      lastTopRef.current = viewport.scrollTop
    }
    viewport.addEventListener('wheel', onWheel, { passive: true })
    viewport.addEventListener('keydown', onKeyDown)
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      viewport.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('keydown', onKeyDown)
      viewport.removeEventListener('scroll', onScroll)
    }
  }, [getViewport, stopFollowingGeneration])

  useEffect(() => {
    if (isGenerating) followRef.current = true
  }, [isGenerating])

  useEffect(() => {
    if (!isGenerating || !pendingGeneration) return

    return generationStreamStore.subscribe(() => {
      if (!followRef.current) return

      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(() => {
        const viewport = getViewport()
        if (viewport && followRef.current) {
          viewport.scrollTop = viewport.scrollHeight
          lastTopRef.current = viewport.scrollTop
        }
      })
    })
  }, [pendingGeneration, isGenerating, generationStreamStore, getViewport])

  useEffect(() => () => {
    cancelAnimationFrame(scrollRafRef.current)
    cancelAnimationFrame(anchorStabilizeRafRef.current)
  }, [])

  useEffect(() => {
    if (!pendingGeneration || isGenerating) return

    const pendingText = generationStreamStore.getSnapshot().text
    if (hasSavedPendingGeneration) return

    if (!pendingText) {
      setPendingGeneration(null)
      return
    }

    const retryTimeout = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
      queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] })
    }, 500)
    return () => clearTimeout(retryTimeout)
  }, [pendingGeneration, isGenerating, hasSavedPendingGeneration, generationStreamStore, queryClient, storyId])

  // Persist scroll position to sessionStorage
  const SCROLL_POS_KEY = `errata:scroll-pos:${storyId}`
  const restoredRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const viewport = getViewport()
    if (!viewport) return

    const handleScroll = () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        sessionStorage.setItem(SCROLL_POS_KEY, String(viewport.scrollTop))
      }, 150)
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', handleScroll)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [SCROLL_POS_KEY, getViewport])

  // Restore scroll position once fragments are loaded
  useEffect(() => {
    if (restoredRef.current || orderedRows.length === 0) return
    const viewport = getViewport()
    if (!viewport) return

    const saved = sessionStorage.getItem(SCROLL_POS_KEY)
    if (saved) {
      const pos = Number(saved)
      if (!isNaN(pos)) {
        requestAnimationFrame(() => {
          viewport.scrollTop = pos
          virtualizer.measure()
        })
      }
    }
    restoredRef.current = true
  }, [orderedRows.length, SCROLL_POS_KEY, getViewport, virtualizer])

  const scrollToIndex = useCallback((index: number) => {
    if (index >= orderedRows.length) {
      const viewport = getViewport()
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight
      }
    } else {
      virtualizer.scrollToIndex(index, { align: 'start' })
    }
  }, [virtualizer, orderedRows.length, getViewport])

  const setVirtualListContainer = useCallback((node: HTMLDivElement | null) => {
    listContainerRef.current = node
    virtualizer.containerRef(node)
  }, [virtualizer])

  const branchFromMutation = useMutation({
    mutationFn: async (sectionIndex: number) => {
      const name = window.prompt('Timeline name:')
      if (!name?.trim()) throw new Error('Cancelled')
      const index = await api.branches.list(storyId)
      return api.branches.create(storyId, {
        name: name.trim(),
        parentBranchId: index.activeBranchId,
        forkAfterIndex: sectionIndex,
      })
    },
    // create-from-section auto-switches to the new branch on the server
    onSuccess: () => onActiveBranchChanged(queryClient, storyId),
  })

  const handleBranchFrom = useCallback((sectionIndex: number) => {
    branchFromMutation.mutate(sectionIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchFromMutation.mutate])

  const handleMentionClick = useCallback((fragmentId: string) => {
    // Find the character fragment from the already-fetched prose fragments won't work;
    // we need to fetch the character fragment directly
    api.fragments.get(storyId, fragmentId).then(fragment => {
      if (fragment) onSelectFragment(fragment)
    }).catch(() => {
      // Fragment may have been deleted
    })
  }, [storyId, onSelectFragment])

  const renderProseRowContent = (row: ProseListRow, rowIndex: number) => {
    const idx = row.displayIndex
    const fragment = row.fragment
    const sectionIdx = sectionIndexMap.get(fragment.id) ?? -1
    const isMarker = fragment.type === 'marker'
    const nextRow = orderedRows[rowIndex + 1]
    const nextIsMarker = nextRow?.fragment.type === 'marker'

    return (
      <>
        {idx === 0 && !isMarker && <InsertChapterDivider storyId={storyId} position={0} />}
        {isMarker ? (
          <ChapterMarker
            storyId={storyId}
            fragment={fragment}
            displayIndex={idx}
            sectionIndex={sectionIdx}
            onSelect={onSelectFragment}
            onDelete={handleDeleteSection}
          />
        ) : (
          <ProseBlock
            storyId={storyId}
            fragment={fragment}
            displayIndex={idx}
            sectionIndex={sectionIdx}
            chainEntry={chainEntryMap.get(fragment.id) ?? null}
            isLast={idx === visibleOrderedItems.length - 1}
            isFirst={idx === 0}
            onSelect={onSelectFragment}
            onEdit={onEditProse}
            onDebugLog={onDebugLog}
            onBranchFrom={handleBranchFrom}
            onAskLibrarian={onAskLibrarian}
            onAnalyze={handleAnalyze}
            hasAnalysis={analyzedFragments.has(fragment.id)}
            quickSwitch={quickSwitch}
            enabledMentionTypes={enabledMentionTypes}
            mentionFragmentTypesById={mentionFragmentTypesById}
            mentionColors={mentionColors}
            onClickMention={handleMentionClick}
            mediaById={mediaById}
            expandThoughtsByDefault={story?.settings.expandThoughtsByDefault ?? false}
            scrollAnchorId={hasSavedPendingGeneration && fragment.id === lastProseFragment?.id
              ? GENERATION_HANDOFF_ANCHOR
              : undefined}
          />
        )}
        {!isMarker && !nextIsMarker && (
          <InsertChapterDivider storyId={storyId} position={idx + 1} />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 relative" data-component-id="prose-chain-root">
      <div className="relative flex flex-1 min-h-0 min-w-0 flex-col">
        <ScrollArea ref={scrollAreaRef} className="flex-1 min-h-0 min-w-0" data-component-id="prose-chain-scroll">
          {/* Cover image banner */}
          {coverImage && (
            <div className="relative w-full overflow-hidden" style={{ maxHeight: 280 }}>
              <img
                src={coverImage}
                alt=""
                className="w-full h-full object-cover"
                style={{ maxHeight: 280 }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/20 to-transparent" />
            </div>
          )}
          <MentionProvider fragments={allMentionFragments} mediaById={mediaById}>
          <div
            ref={proseContentRef}
            className="mx-auto w-full py-6 px-4 sm:py-12 sm:px-8"
            style={{
              maxWidth: PROSE_WIDTH_VALUES[proseWidth],
              paddingBottom: composerHeight ? composerHeight + 24 : undefined,
            }}
          >
            {orderedRows.length > 0 ? (
              <div ref={setVirtualListContainer} style={{ width: '100%', position: 'relative' }}>
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const row = orderedRows[virtualItem.index]
                  if (!row) return null
                  return (
                    <div
                      key={row.key}
                      data-index={virtualItem.index}
                      data-prose-index={row.displayIndex}
                      data-prose-row="true"
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        left: 0,
                        width: '100%',
                        contain: 'layout style',
                      }}
                    >
                      {renderProseRowContent(row, virtualItem.index)}
                    </div>
                  )
                })}
              </div>
            ) : !showPendingGeneration ? (
              <div className="flex flex-col items-center justify-center py-20 text-center" data-component-id="prose-empty-state">
                <p className="font-display text-2xl italic text-muted-foreground mb-2">
                  The page awaits.
                </p>
                <Hint size="sm" className="mb-8 max-w-xs leading-relaxed">
                  Write your first passage below, or let the wizard help you set up your story.
                </Hint>
                {onLaunchWizard && (
                  <button
                    onClick={onLaunchWizard}
                    className="inline-flex items-center gap-2.5 px-6 py-3 rounded-xl border-2 border-primary/20 bg-primary/[0.04] text-sm font-medium text-primary/80 hover:text-primary hover:border-primary/40 hover:bg-primary/[0.08] transition-all duration-200"
                  >
                    <Wand2 className="size-4" />
                    <span>Story Setup Wizard</span>
                  </button>
                )}
              </div>
            ) : null}

            {showPendingGeneration && pendingGeneration && (
              <div data-prose-index={visibleOrderedItems.length} data-pending-generation="true">
                <PendingGenerationBlock
                  pending={pendingGeneration}
                  streamStore={generationStreamStore}
                  isGenerating={isGenerating}
                  defaultExpanded={story?.settings.expandThoughtsByDefault ?? false}
                  onBeforeThoughtsCollapse={measureGenerationAnchorTop}
                  onAfterThoughtsCollapse={restoreMeasuredGenerationAnchor}
                />
              </div>
            )}

            {savedGenerationHandoffFragment && (
              <div
                ref={savedGenerationHandoffRef}
                data-prose-index={visibleOrderedItems.length}
                data-saved-generation-handoff="true"
              >
                <ProseBlock
                  storyId={storyId}
                  fragment={savedGenerationHandoffFragment}
                  displayIndex={visibleOrderedItems.length}
                  sectionIndex={sectionIndexMap.get(savedGenerationHandoffFragment.id) ?? -1}
                  chainEntry={chainEntryMap.get(savedGenerationHandoffFragment.id) ?? null}
                  isLast
                  isFirst={visibleOrderedItems.length === 0}
                  onSelect={onSelectFragment}
                  onEdit={onEditProse}
                  onDebugLog={onDebugLog}
                  onBranchFrom={handleBranchFrom}
                  onAskLibrarian={onAskLibrarian}
                  onAnalyze={handleAnalyze}
                  hasAnalysis={analyzedFragments.has(savedGenerationHandoffFragment.id)}
                  quickSwitch={quickSwitch}
                  enabledMentionTypes={enabledMentionTypes}
                  mentionFragmentTypesById={mentionFragmentTypesById}
                  mentionColors={mentionColors}
                  onClickMention={handleMentionClick}
                  mediaById={mediaById}
                  expandThoughtsByDefault={story?.settings.expandThoughtsByDefault ?? false}
                  scrollAnchorId={GENERATION_HANDOFF_ANCHOR}
                />
              </div>
            )}
          </div>
          </MentionProvider>
        </ScrollArea>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6">
          <div
            ref={composerOverlayRef}
            className="pointer-events-auto mx-auto w-full"
            style={{ maxWidth: PROSE_WIDTH_VALUES[proseWidth] }}
          >
            <InlineGenerationInput
              storyId={storyId}
              isGenerating={isGenerating}
              latestFragmentId={lastProseFragment?.id}
              onGenerationStart={(prompt) => {
                followRef.current = true
                generationAnchorTopRef.current = null
                generationStreamStore.reset()
                setIsGenerating(true)
                setPendingGeneration({
                  id: nextGenerationIdRef.current++,
                  prompt,
                  fragmentCountBefore: orderedProseFragments.length,
                })
              }}
              onGenerationStream={(text) => {
                generationStreamStore.setText(text)
              }}
              onGenerationThoughts={(thoughts) => {
                generationStreamStore.setThoughts(thoughts)
              }}
              onGenerationComplete={() => {
                captureGenerationViewportAnchor()
                setIsGenerating(false)
              }}
              onGenerationError={() => {
                measureGenerationAnchorTop()
                setIsGenerating(false)
                setPendingGeneration(null)
              }}
            />
          </div>
        </div>
      </div>

      {/* Outline panel — side rail on desktop */}
      {outlineFragments.length > 1 && (
        <div className="hidden md:flex">
          <ProseOutlinePanel
            storyId={storyId}
            fragments={outlineFragments}
            activeIndex={activeIndex}
            open={outlineOpen ?? true}
            onJump={scrollToIndex}
          />
        </div>
      )}

      {/* Outline on mobile — a trigger that opens the passages as a full-screen
          overlay (no room for a persistent rail). Sits left of the chat button. */}
      {outlineFragments.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => setMobileTocOpen(true)}
            title="Passages"
            aria-label="Open passages outline"
            data-component-id="prose-mobile-toc-trigger"
            className="md:hidden absolute top-3 right-14 z-20 flex items-center justify-center size-9 rounded-md bg-background/80 backdrop-blur-sm border border-border/40 shadow-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <List className="size-4" />
          </button>
          {mobileTocOpen && (
            <div
              className="md:hidden fixed inset-0 z-40 bg-background animate-in fade-in duration-150"
              data-component-id="prose-mobile-toc-overlay"
            >
              <ProseOutlinePanel
                storyId={storyId}
                fragments={outlineFragments}
                activeIndex={activeIndex}
                open
                mobile
                onClose={() => setMobileTocOpen(false)}
                onJump={(i) => { scrollToIndex(i); setMobileTocOpen(false) }}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
