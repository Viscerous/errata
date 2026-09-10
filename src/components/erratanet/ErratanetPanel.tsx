import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type Fragment, type StoryMeta } from '@/lib/api'
import { q, useActiveBranchId } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Eyebrow, Hint, MetaLabel, Metric } from '@/components/ui/prose-text'
import {
  ArrowUpFromLine,
  Search,
  UploadCloud,
} from 'lucide-react'
import { PublishPackDialog } from './PublishPackDialog'
import { ErratanetBrowserPanel } from './ErratanetBrowserPanel'
import { AgentConfigSection } from './AgentConfigSection'
import { PackLink } from './PackLink'
import { ErratanetAccountBlock } from './ErratanetAccountBlock'

interface ErratanetPanelProps {
  storyId: string
  story: StoryMeta
  /** Opens the fragment export panel (for publishing a selection as a pack). */
  onExport?: () => void
}

/**
 * The dedicated ErrataNet sidebar panel: hub account, this-story publish/sync,
 * and a way into the pack browser. Sync is the hero once a story is published.
 */
export function ErratanetPanel({ storyId, story, onExport }: ErratanetPanelProps) {
  const branchId = useActiveBranchId(storyId)

  const { data: config } = useQuery({
    queryKey: ['erratanet-config'],
    queryFn: () => api.erratanet.getConfig(),
  })
  const { data: account } = useQuery({
    queryKey: ['erratanet-account'],
    queryFn: () => api.erratanet.getAccount(),
    enabled: !!config?.token,
  })

  const connected = !!config?.token && !!account?.connected
  const handle = account?.handle ?? config?.handle

  // Where this story is published, if anywhere. Drives publish vs. sync.
  const publishedAs = story.settings?.erratanet?.publishedAs
  const publishedSlug = publishedAs ? publishedAs.pack.split('/')[1] : undefined
  const fragmentPacks = story.settings?.erratanet?.fragmentPacks ?? []

  const [publishOpen, setPublishOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [syncPack, setSyncPack] = useState<{ pack: string; fragments: Fragment[] } | null>(null)
  const emptyMedia = useMemo<Map<string, Fragment>>(() => new Map(), [])

  // Fragments + media are needed to re-sync a fragment pack; only fetch them
  // when this story has packs to sync (the query keys are shared/cached).
  const needFragments = connected && fragmentPacks.length > 0
  const { data: allFragments = [] } = useQuery({ ...q.fragments(storyId, branchId), enabled: needFragments })
  const { data: imageFrags = [] } = useQuery({ ...q.fragments(storyId, branchId, 'image'), enabled: needFragments })
  const { data: iconFrags = [] } = useQuery({ ...q.fragments(storyId, branchId, 'icon'), enabled: needFragments })
  const fragmentById = useMemo(() => {
    const m = new Map<string, Fragment>()
    for (const f of allFragments) m.set(f.id, f)
    return m
  }, [allFragments])
  const mediaById = useMemo(() => {
    const m = new Map<string, Fragment>()
    for (const f of imageFrags) m.set(f.id, f)
    for (const f of iconFrags) m.set(f.id, f)
    return m
  }, [imageFrags, iconFrags])

  return (
    <>
      <ScrollArea className="h-full">
        <div className="space-y-6 px-5 py-5">
          <ErratanetAccountBlock config={config} connected={connected} handle={handle} />

          {connected && (
            <>
              <Divider />
              <section>
                <Eyebrow asChild><h3 className="mb-2.5">This story</h3></Eyebrow>
                {publishedAs ? (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-border/40 bg-card/40 px-3.5 py-3">
                      <Eyebrow asChild><p>Published as</p></Eyebrow>
                      <PackLink pack={publishedAs.pack} hubUrl={config?.hubUrl} className="mt-1 text-ui-body" />
                      <Metric asChild><p className="mt-0.5">v{publishedAs.version}</p></Metric>
                    </div>
                    <Button className="w-full gap-2" onClick={() => setPublishOpen(true)}>
                      <ArrowUpFromLine className="size-4" />
                      Sync update
                    </Button>
                    <Hint className="leading-snug">
                      Publishes your current prose chain and fragments as a new version of this pack.
                    </Hint>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Hint className="leading-snug">
                      This story is not on the hub yet. Publishing sends the whole story: branches,
                      prose chain, and fragments.
                    </Hint>
                    <Button className="w-full gap-2" onClick={() => setPublishOpen(true)}>
                      <UploadCloud className="size-4" />
                      Publish story
                    </Button>
                  </div>
                )}

                {/* Fragment packs published from this story (e.g. a starter). */}
                {fragmentPacks.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <Eyebrow asChild><p>Fragment packs</p></Eyebrow>
                    {fragmentPacks.map((fp) => {
                      const resolved = fp.fragmentIds
                        .map((id) => fragmentById.get(id))
                        .filter((f): f is Fragment => !!f)
                      const missing = fp.fragmentIds.length - resolved.length
                      return (
                        <div
                          key={fp.pack}
                          className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <PackLink pack={fp.pack} hubUrl={config?.hubUrl} className="text-ui-body" />
                            <MetaLabel asChild><p className="font-mono">
                              v{fp.version} · {resolved.length} fragment{resolved.length === 1 ? '' : 's'}
                              {missing > 0 ? ` · ${missing} missing` : ''}
                            </p></MetaLabel>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 shrink-0 gap-1.5 px-2.5 text-ui-caption"
                            disabled={resolved.length === 0}
                            onClick={() => setSyncPack({ pack: fp.pack, fragments: resolved })}
                          >
                            <ArrowUpFromLine className="size-3" />
                            Sync
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}

                <Button
                  variant="ghost"
                  className="mt-2 h-8 w-full justify-start gap-2 px-2 text-ui-body text-muted-foreground hover:text-foreground"
                  onClick={() => onExport?.()}
                >
                  <UploadCloud className="size-3.5" />
                  Publish a fragment pack instead
                </Button>
              </section>

              <Divider />
              <AgentConfigSection
                storyId={storyId}
                storyName={story.name}
                sharedConfigs={story.settings?.erratanet?.agentConfigs ?? []}
                hubUrl={config?.hubUrl}
              />
            </>
          )}

          <Divider />
          <section>
            <Eyebrow asChild><h3 className="mb-2.5">Discover</h3></Eyebrow>
            <Button variant="outline" className="w-full gap-2" onClick={() => setBrowseOpen(true)}>
              <Search className="size-4" />
              Browse and Install Packs
            </Button>
            <Hint className="mt-2 leading-snug">
              Find character cards, guideline packs, stories, and agent configs. No account needed to browse.
            </Hint>
          </section>
        </div>
      </ScrollArea>

      <PublishPackDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        mode="story"
        storyId={storyId}
        defaultSlug={publishedSlug}
        storyName={story.name}
        selectedFragments={[]}
        mediaById={emptyMedia}
      />

      {syncPack && (
        <PublishPackDialog
          open
          onOpenChange={(o) => {
            if (!o) setSyncPack(null)
          }}
          mode="fragments"
          storyId={storyId}
          defaultSlug={syncPack.pack.split('/')[1]}
          storyName={story.name}
          selectedFragments={syncPack.fragments}
          mediaById={mediaById}
        />
      )}

      {browseOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] bg-background"
            data-cuelume-surface="bloom"
            data-component-id="erratanet-browser-overlay"
          >
            <ErratanetBrowserPanel storyId={storyId} onClose={() => setBrowseOpen(false)} />
          </div>,
          document.body,
        )}
    </>
  )
}

function Divider() {
  return <div className="h-px bg-border/30" />
}
