import { useMemo, type ReactNode } from 'react'
import { BookOpen, Code2, Download, Loader2, Package, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import type { ErratanetPackDetail, ErratanetPackSummary } from '@/lib/api/types'
import { parseGlobalPackId } from '@/lib/erratanet/pack-schema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Eyebrow, Hint, MetaLabel, Metric } from '@/components/ui/prose-text'

export type ErratanetInstallTarget = 'this-story' | 'new-story'

export function ErratanetResultRow({ result, onSelect, busy }: { result: ErratanetPackSummary; onSelect: () => void; busy: boolean }) {
  const story = result.contentKind === 'story'
  const config = result.contentKind === 'agent-config'
  const runsCode = result.agentConfig?.hasScripts ?? result.capabilities?.includes('scripts') ?? false
  const idParts = parseGlobalPackId(result.id)
  const handleLabel = result.publisher ?? (idParts ? `@${idParts.handle}` : result.id)
  return (
    <button type="button" onClick={onSelect} disabled={busy} className="flex w-full items-start gap-3 rounded-lg border border-border/30 px-4 py-3 text-left transition-colors hover:border-border/50 hover:bg-accent/20 disabled:opacity-60">
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/30 bg-muted">
        {result.thumbnail ? <img src={result.thumbnail} alt="" className="size-full object-cover" /> : config ? <SlidersHorizontal className="size-5 text-muted-foreground" /> : story ? <BookOpen className="size-5 text-muted-foreground" /> : <Package className="size-5 text-muted-foreground" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{result.title}</span>
          <Badge variant="secondary" className="h-4 shrink-0 text-ui-label">{config ? 'config' : story ? 'story' : 'pack'}</Badge>
          {runsCode && <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/40 px-1 font-mono text-ui-label lowercase text-amber-600 dark:text-amber-400"><Code2 className="size-2.5" /> code</span>}
          {result.nsfw && <Badge className="h-4 shrink-0 border-transparent bg-destructive/15 text-ui-label text-destructive">nsfw</Badge>}
          <Metric className="ml-auto shrink-0">v{result.version}</Metric>
        </div>
        <MetaLabel asChild><p className="mt-0.5 truncate font-mono">{handleLabel}{idParts ? `/${idParts.slug}` : ''}</p></MetaLabel>
        {result.description && <Hint className="mt-1 line-clamp-2">{result.description}</Hint>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {config ? result.agentConfig && <MetaLabel className="mr-0.5 tabular-nums">{result.agentConfig.blockCount} {result.agentConfig.blockCount === 1 ? 'block' : 'blocks'}{result.agentConfig.agents.length > 0 ? ` · tunes ${result.agentConfig.agents.length}` : ''}</MetaLabel> : (
            <>
              <MetaLabel className="mr-0.5 tabular-nums">{result.fragmentCount ?? 0} {result.fragmentCount === 1 ? 'fragment' : 'fragments'}</MetaLabel>
              {(result.fragmentTypes ?? []).slice(0, 4).map((type) => <Badge key={type} variant="outline" className="h-3.5 px-1 text-ui-label">{type}</Badge>)}
            </>
          )}
          {(result.tags ?? []).slice(0, 3).map((tag) => <MetaLabel key={tag} className="rounded bg-muted/60 px-1">#{tag}</MetaLabel>)}
        </div>
      </div>
    </button>
  )
}

export function ErratanetPackDetailView({
  pack,
  storyId,
  target,
  onTargetChange,
  installResult,
  installing,
  onInstall,
}: {
  pack: ErratanetPackDetail
  storyId?: string
  target: ErratanetInstallTarget
  onTargetChange: (target: ErratanetInstallTarget) => void
  installResult: { ok: boolean; message: string } | null
  installing: boolean
  onInstall: () => void
}) {
  const story = pack.contentKind === 'story'
  const idParts = useMemo(() => parseGlobalPackId(pack.id), [pack.id])
  const canChooseTarget = !story && !!storyId
  const installed = installResult?.ok === true

  return (
    <>
      <ScrollArea className="flex-1" data-component-id="erratanet-detail-scroll">
        <div className="mx-auto max-w-2xl space-y-5 p-6">
          <div className="flex items-start gap-4">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/30 bg-muted">
              {pack.thumbnail ? <img src={pack.thumbnail} alt="" className="size-full object-cover" /> : story ? <BookOpen className="size-6 text-muted-foreground" /> : <Package className="size-6 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-xl leading-tight">{pack.title}</h3>
                <Badge variant="secondary" className="h-4 text-ui-label">{story ? 'story' : 'pack'}</Badge>
                {pack.nsfw && <Badge className="h-4 border-transparent bg-destructive/15 text-ui-label text-destructive">nsfw</Badge>}
              </div>
              <MetaLabel asChild><p className="mt-1 font-mono">{pack.publisher ?? (idParts ? `@${idParts.handle}` : pack.id)}{idParts ? `/${idParts.slug}` : ''} <span className="text-muted-foreground/70">v{pack.version}</span></p></MetaLabel>
              {pack.description && <p className="mt-2 text-sm leading-relaxed text-foreground/80">{pack.description}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <PackMeta label="Contents">{pack.fragmentCount ?? 0} {pack.fragmentCount === 1 ? 'fragment' : 'fragments'}</PackMeta>
            <PackMeta label="License">{pack.license || 'unspecified'}</PackMeta>
          </div>

          {(pack.fragmentTypes?.length ?? 0) > 0 && <TagGroup label="Fragment types">{(pack.fragmentTypes ?? []).map((type) => <Badge key={type} variant="outline" className="h-5 text-ui-label">{type}</Badge>)}</TagGroup>}
          {(pack.tags?.length ?? 0) > 0 && <TagGroup label="Tags">{(pack.tags ?? []).map((tag) => <MetaLabel key={tag} className="rounded bg-muted/60 px-1.5 py-0.5">#{tag}</MetaLabel>)}</TagGroup>}

          <div className="flex items-start gap-2 rounded-md border border-border/30 bg-accent/10 px-3 py-2">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <Hint className="leading-relaxed">Packs install fragments and assets only. Context configuration and scripts are never imported.</Hint>
          </div>

          <div>
            <Eyebrow asChild><h4 className="mb-1.5">Install to</h4></Eyebrow>
            {story ? <Hint>Stories always install as a new story.</Hint> : canChooseTarget ? (
              <div className="grid grid-cols-2 gap-2">
                <TargetOption active={target === 'this-story'} title="This story" subtitle="Add fragments here" onClick={() => onTargetChange('this-story')} />
                <TargetOption active={target === 'new-story'} title="New story" subtitle="Create a fresh story" onClick={() => onTargetChange('new-story')} />
              </div>
            ) : <Hint>Fragments install into a new story.</Hint>}
          </div>

          {installResult && <div className={`rounded-md p-3 text-sm ${installResult.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-destructive/10 text-destructive'}`}>{installResult.message}</div>}
        </div>
      </ScrollArea>
      <div className="flex items-center justify-end gap-2 border-t border-border/50 px-6 py-4">
        <Button onClick={onInstall} disabled={installing || installed} className="gap-1.5">
          {installing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          {installed ? 'Installed' : story || target === 'new-story' ? 'Install as new story' : 'Install into this story'}
        </Button>
      </div>
    </>
  )
}

function PackMeta({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rounded-md border border-border/30 px-3 py-2"><Eyebrow asChild><span className="block">{label}</span></Eyebrow><span className="text-foreground/90">{children}</span></div>
}

function TagGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div><Eyebrow asChild><h4 className="mb-1.5">{label}</h4></Eyebrow><div className="flex flex-wrap gap-1.5">{children}</div></div>
}

function TargetOption({ active, title, subtitle, onClick }: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-md border px-3 py-2 text-left transition-colors ${active ? 'border-primary/40 bg-primary/10' : 'border-border/40 hover:bg-accent/30'}`}>
      <span className="block text-sm leading-tight">{title}</span>
      <Hint asChild><span>{subtitle}</span></Hint>
    </button>
  )
}
