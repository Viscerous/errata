import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ErratanetPackDetail, ErratanetPackSummary } from '@/lib/api/types'
import { parseGlobalPackId } from '@/lib/erratanet/pack-schema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EmptyHint, Eyebrow, Hint } from '@/components/ui/prose-text'
import { SegmentedControl } from '@/components/settings/primitives'
import { AgentConfigImportView } from './AgentConfigImportView'
import {
  ErratanetPackDetailView,
  ErratanetResultRow,
  type ErratanetInstallTarget,
} from './ErratanetPackViews'
import {
  X,
  ArrowLeft,
  Search,
  Loader2,
  Download,
  Link2,
} from 'lucide-react'

interface ErratanetBrowserPanelProps {
  /** When set, loose fragment packs can be installed into this story. */
  storyId?: string
  onClose: () => void
}
type KindFilter = 'all' | 'story' | 'fragment-pack' | 'agent-config'

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'story', label: 'Stories' },
  { value: 'fragment-pack', label: 'Packs' },
  { value: 'agent-config', label: 'Configs' },
]

/**
 * Parse a typed reference into a global pack id + optional version.
 * Accepts `@user/pack`, `@user/pack@1.2.3`, or a full hub URL whose path ends
 * in `@user/pack` (optionally with a trailing `@version` or `?version=`).
 */
export function parsePackRef(raw: string): { id: string; version?: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Full URL form: pull the @handle/slug out of the path + any version query.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const queryVersion = url.searchParams.get('version') ?? undefined
      const match = url.pathname.match(/@[a-z0-9-]+\/[a-z0-9-]+(?:@[^/]+)?/i)
      if (!match) return null
      return splitIdVersion(match[0], queryVersion)
    } catch {
      return null
    }
  }

  return splitIdVersion(trimmed)
}

function splitIdVersion(ref: string, fallbackVersion?: string): { id: string; version?: string } | null {
  // Split a trailing `@version` that follows the slug (the id's own leading @
  // is at index 0, so look for an @ after the slash).
  const slash = ref.indexOf('/')
  if (slash === -1) return null
  const atAfterSlash = ref.indexOf('@', slash)
  let id = ref
  let version = fallbackVersion
  if (atAfterSlash !== -1) {
    id = ref.slice(0, atAfterSlash)
    version = ref.slice(atAfterSlash + 1) || fallbackVersion
  }
  if (!parseGlobalPackId(id)) return null
  return { id, version }
}

export function ErratanetBrowserPanel({ storyId, onClose }: ErratanetBrowserPanelProps) {
  const queryClient = useQueryClient()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ErratanetPackSummary[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [selected, setSelected] = useState<ErratanetPackDetail | null>(null)
  const [configRef, setConfigRef] = useState<{ id: string; version?: string } | null>(null)
  const [loadingPack, setLoadingPack] = useState(false)
  const [packError, setPackError] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')

  const [target, setTarget] = useState<ErratanetInstallTarget>(storyId ? 'this-story' : 'new-story')
  const [installResult, setInstallResult] = useState<{ ok: boolean; message: string } | null>(null)

  const [directRef, setDirectRef] = useState('')
  const [directError, setDirectError] = useState<string | null>(null)

  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchError(null)
    try {
      const res = (await api.erratanet.search(q)) as unknown as
        | ErratanetPackSummary[]
        | { results?: ErratanetPackSummary[] }
      setResults(Array.isArray(res) ? res : res.results ?? [])
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed.')
      setResults(null)
    } finally {
      setSearching(false)
    }
  }, [query])

  const openPack = useCallback(
    async (id: string, version?: string) => {
      setLoadingPack(true)
      setPackError(null)
      setInstallResult(null)
      try {
        const pack = await api.erratanet.getPack(id, version)
        // Agent-config packs route to the dedicated import flow (preview +
        // consent + apply/preset), not the fragment/story install path. A
        // version the user pinned wins over the pack detail's (latest) version.
        if (pack.contentKind === 'agent-config') {
          setConfigRef({ id: pack.id, version: version ?? pack.version })
          setSelected(null)
          return
        }
        setSelected(pack)
        // Story packs always install as a new story; loose packs default to the
        // current story when one is in scope.
        setTarget(pack.contentKind === 'story' || !storyId ? 'new-story' : 'this-story')
      } catch (err) {
        setPackError(err instanceof Error ? err.message : 'Could not load pack.')
        setSelected(null)
      } finally {
        setLoadingPack(false)
      }
    },
    [storyId],
  )

  const handleDirectInstall = useCallback(() => {
    setDirectError(null)
    const parsed = parsePackRef(directRef)
    if (!parsed) {
      setDirectError('Enter @user/pack, @user/pack@version, or a full pack URL.')
      return
    }
    openPack(parsed.id, parsed.version)
  }, [directRef, openPack])

  const installMutation = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error('No pack selected.')
      const asNewStory = selected.contentKind === 'story' || target === 'new-story'
      return api.erratanet.install({
        id: selected.id,
        version: selected.version,
        targetStoryId: asNewStory ? undefined : storyId,
        asNewStory,
      })
    },
    onSuccess: (res) => {
      // Refresh anything the install could have touched.
      queryClient.invalidateQueries({ queryKey: ['stories'] })
      if (res.createdStory && res.storyId) {
        queryClient.invalidateQueries({ queryKey: ['fragments', res.storyId] })
        queryClient.invalidateQueries({ queryKey: ['proseChain', res.storyId] })
      }
      if (storyId) {
        queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
        queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] })
      }
      const where = res.createdStory ? 'a new story' : 'this story'
      setInstallResult({
        ok: true,
        message: `Installed ${res.fragmentCount} ${res.fragmentCount === 1 ? 'fragment' : 'fragments'} into ${where}.`,
      })
    },
    onError: (err) => {
      setInstallResult({ ok: false, message: err instanceof Error ? err.message : 'Install failed.' })
    },
  })

  const clearSelection = useCallback(() => {
    setSelected(null)
    setConfigRef(null)
    setPackError(null)
    setInstallResult(null)
  }, [])

  // Client-side kind filter over the mixed hub search results.
  const visibleResults = useMemo(() => {
    if (!results) return null
    if (kindFilter === 'all') return results
    return results.filter((r) => r.contentKind === kindFilter)
  }, [results, kindFilter])
  const filterOptions = useMemo(() => KIND_FILTERS.map((filter) => ({
    value: filter.value,
    label: `${filter.label} ${filter.value === 'all' ? results?.length ?? 0 : results?.filter((result) => result.contentKind === filter.value).length ?? 0}`,
  })), [results])

  return (
    <div className="flex flex-col h-full" data-component-id="erratanet-browser-root">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
        <div className="flex items-center gap-2">
          {(selected || configRef) && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground"
              onClick={clearSelection}
              aria-label="Back to pack results"
              data-component-id="erratanet-browser-back"
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <h2 className="font-display text-lg">Browse and Install Packs</h2>
          <Eyebrow>{configRef ? 'Import Config' : selected ? 'Pack Detail' : 'ErrataNet'}</Eyebrow>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
          onClick={onClose}
          aria-label="Close ErrataNet browser"
          data-component-id="erratanet-browser-close"
        >
          <X className="size-4" />
        </Button>
      </div>

      {configRef ? (
        <AgentConfigImportView id={configRef.id} version={configRef.version} storyId={storyId} />
      ) : selected ? (
        <ErratanetPackDetailView
          pack={selected}
          storyId={storyId}
          target={target}
          onTargetChange={setTarget}
          installResult={installResult}
          installing={installMutation.isPending}
          onInstall={() => installMutation.mutate()}
        />
      ) : (
        <ScrollArea className="flex-1" data-component-id="erratanet-browser-scroll">
          <div className="max-w-2xl mx-auto p-6 space-y-6">
            {/* Search */}
            <div>
              <label htmlFor="erratanet-search" className="mb-1.5 block text-xs font-medium text-muted-foreground">Search</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    id="erratanet-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') runSearch() }}
                    placeholder="Find packs, stories, and agent configs"
                    className="pl-8"
                  />
                </div>
                <Button onClick={runSearch} disabled={searching || !query.trim()} className="gap-1.5 shrink-0">
                  {searching ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                  Search
                </Button>
              </div>
              {searchError && <Hint className="mt-2 text-destructive">{searchError}</Hint>}
            </div>

            {/* Install by reference */}
            <div className="rounded-md border border-border/30 bg-accent/10 p-3">
              <label htmlFor="erratanet-direct-reference" className="mb-1.5 block text-xs font-medium text-muted-foreground">Install by reference</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    id="erratanet-direct-reference"
                    value={directRef}
                    onChange={(e) => setDirectRef(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleDirectInstall() }}
                    placeholder="@user/pack@version or full URL"
                    className="pl-8 font-mono text-xs"
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={handleDirectInstall}
                  disabled={loadingPack || !directRef.trim()}
                  className="gap-1.5 shrink-0"
                >
                  {loadingPack ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  Open
                </Button>
              </div>
              {directError && <Hint className="mt-2 text-destructive">{directError}</Hint>}
            </div>

            {packError && <Hint className="text-destructive">{packError}</Hint>}

            {/* Kind filter (over the mixed search results) */}
            {results && results.length > 0 && (
              <SegmentedControl value={kindFilter} options={filterOptions} onChange={setKindFilter} />
            )}

            {/* Results */}
            <div className="space-y-2">
              {visibleResults === null ? (
                <EmptyHint className="py-8 text-center block">
                  Search the hub to discover fragment packs, stories, and agent configs.
                </EmptyHint>
              ) : visibleResults.length === 0 ? (
                <EmptyHint className="py-8 text-center block">
                  {results && results.length > 0 ? 'Nothing of this kind in the results.' : 'No packs matched that search.'}
                </EmptyHint>
              ) : (
                visibleResults.map((r) => (
                  <ErratanetResultRow
                    key={`${r.id}@${r.version}`}
                    result={r}
                    busy={loadingPack}
                    onSelect={() => openPack(r.id, r.version)}
                  />
                ))
              )}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
