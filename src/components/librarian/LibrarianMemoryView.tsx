import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Bookmark, X } from 'lucide-react'
import { api, type Fragment } from '@/lib/api'
import { q, qk, useActiveBranchId } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/async-view'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'

export function LibrarianMemoryView({ storyId }: { storyId: string }) {
  const [showArchived, setShowArchived] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const branchId = useActiveBranchId(storyId)
  const { data: summaries } = useQuery({ ...q.fragments(storyId, branchId, 'summary'), refetchInterval: 5000 })
  const { data: archivedSummaries } = useQuery({
    queryKey: qk.fragmentsArchived(storyId, branchId, 'summary'),
    queryFn: async () => (await api.fragments.listArchived(storyId, branchId)).filter(fragment => fragment.type === 'summary'),
    enabled: showArchived,
  })
  const sorted = useMemo(() => [...(summaries ?? [])].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)), [summaries])
  const editingFragment = (summaries ?? []).find(fragment => fragment.id === editingId)
    ?? (archivedSummaries ?? []).find(fragment => fragment.id === editingId)
    ?? null

  return (
    <ScrollArea className="h-full" data-component-id="librarian-memory-view">
      <div className="space-y-3 px-4 py-3">
        {sorted.length === 0 ? (
          <div className="pt-6"><EmptyState icon={<Bookmark className="size-5" />} title="No authored memory" hint="Story history is derived automatically from source-linked analyses. Optional summary fragments you author appear here." variant="panel" /></div>
        ) : (
          <div className="space-y-1.5">{sorted.map(fragment => <MemoryCard key={fragment.id} storyId={storyId} fragment={fragment} onOpen={() => setEditingId(fragment.id)} />)}</div>
        )}

        <div className="pt-1">
          <Button type="button" variant="ghost" size="xs" className="px-1 font-display italic text-muted-foreground" onClick={() => setShowArchived(value => !value)} aria-expanded={showArchived}>
            {showArchived ? 'hide archived' : 'show archived'}
          </Button>
          {showArchived && (
            <div className="space-y-1.5 pt-2 opacity-75">
              {archivedSummaries?.length
                ? archivedSummaries.map(fragment => <MemoryCard key={fragment.id} storyId={storyId} fragment={fragment} archived onOpen={() => setEditingId(fragment.id)} />)
                : <p className="px-1 text-ui-label italic text-muted-foreground">No archived memory.</p>}
            </div>
          )}
        </div>
      </div>
      {editingFragment && <MemoryEditor storyId={storyId} fragment={editingFragment} onClose={() => setEditingId(null)} />}
    </ScrollArea>
  )
}

function MemoryCard({ storyId, fragment, onOpen, archived = false }: { storyId: string; fragment: Fragment; onOpen: () => void; archived?: boolean }) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
    queryClient.invalidateQueries({ queryKey: ['fragments-archived', storyId] })
  }
  const archive = useMutation({ mutationFn: () => api.fragments.archive(storyId, fragment.id), onSuccess: invalidate })
  const restore = useMutation({ mutationFn: () => api.fragments.restore(storyId, fragment.id), onSuccess: invalidate })

  return (
    <article className="group/row rounded-md border border-border/30 bg-muted/10 transition-colors hover:border-border/50 hover:bg-muted/20">
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-2 rounded-md p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <Bookmark className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-ui-body italic leading-tight text-foreground/90">{fragment.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-ui-label uppercase tracking-[0.12em] text-muted-foreground"><span>authored</span><span aria-hidden>·</span><span className="tabular-nums normal-case tracking-normal">{fragment.content.length.toLocaleString()} chars</span></span>
          <span className="mt-1.5 line-clamp-2 block font-prose text-ui-label leading-relaxed text-foreground/60">{fragment.content || <span className="italic text-muted-foreground/40">(empty)</span>}</span>
        </span>
      </button>
      <div className="flex items-center justify-end gap-0.5 px-2 pb-2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => archived ? restore.mutate() : archive.mutate()}
          disabled={archive.isPending || restore.isPending}
          aria-label={archived ? 'Restore summary' : 'Archive summary'}
        >
          {archived ? <ArchiveRestore /> : <Archive />}
        </Button>
      </div>
    </article>
  )
}

function MemoryEditor({ storyId, fragment, onClose }: { storyId: string; fragment: Fragment; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(fragment.content)
  const savedRef = useRef(fragment.content)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const resetSaveStateRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
    queryClient.invalidateQueries({ queryKey: ['fragments-archived', storyId] })
  }
  const save = useMutation({
    mutationFn: (content: string) => api.fragments.update(storyId, fragment.id, { name: fragment.name, description: fragment.description, content }),
    onMutate: () => setSaveState('saving'),
    onSuccess: (_data, content) => {
      savedRef.current = content
      setSaveState('saved')
      invalidate()
      if (resetSaveStateRef.current) clearTimeout(resetSaveStateRef.current)
      resetSaveStateRef.current = setTimeout(() => setSaveState('idle'), 1200)
    },
    onError: () => setSaveState('error'),
  })
  const archive = useMutation({ mutationFn: () => api.fragments.archive(storyId, fragment.id), onSuccess: () => { invalidate(); onClose() } })
  const restore = useMutation({ mutationFn: () => api.fragments.restore(storyId, fragment.id), onSuccess: invalidate })
  const saveIfDirty = () => { if (draft.trim() !== savedRef.current.trim()) save.mutate(draft) }

  useEffect(() => {
    if (fragment.content !== savedRef.current) { savedRef.current = fragment.content; setDraft(fragment.content) }
  }, [fragment.content])
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      saveIfDirty()
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [draft, onClose])
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous; if (resetSaveStateRef.current) clearTimeout(resetSaveStateRef.current) }
  }, [])

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`Summary editor: ${fragment.name}`} data-cuelume-surface="bloom" className="fixed inset-0 z-50 flex flex-col bg-background animate-onboarding-fade-in">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border/40 px-6 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate font-display text-xl italic leading-tight text-foreground">{fragment.name}</h2>
          <div className="flex items-center gap-2 text-ui-label uppercase tracking-[0.15em] text-muted-foreground">
            <span>authored memory</span><span aria-hidden>·</span><span className="tabular-nums normal-case tracking-normal">{draft.length.toLocaleString()} chars</span>
            {fragment.archived && <><span aria-hidden>·</span><span className="text-destructive/70">archived</span></>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant="ghost" className="font-display italic text-muted-foreground" onClick={() => fragment.archived ? restore.mutate() : archive.mutate()} disabled={archive.isPending || restore.isPending}>
            {fragment.archived ? <ArchiveRestore /> : <Archive />}{fragment.archived ? 'restore' : 'archive'}
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={() => { saveIfDirty(); onClose() }} aria-label="Close editor"><X /></Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[68ch] px-8 py-10 md:py-14">
          <Textarea value={draft} onChange={event => setDraft(event.target.value)} onBlur={saveIfDirty} placeholder="Write author-owned story memory…" autoFocus spellCheck className="min-h-[60vh] w-full resize-none border-none bg-transparent px-0 py-0 font-prose text-[1.0625rem] leading-[1.75] shadow-none placeholder:italic placeholder:text-muted-foreground/35 focus-visible:outline-none focus-visible:ring-0" />
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between border-t border-border/30 px-6 py-2 text-ui-label text-muted-foreground/70">
        <span className="font-display italic">Press <kbd className="rounded bg-muted/50 px-1 py-0.5 font-mono not-italic">Esc</kbd> to close · edits autosave on blur</span>
        <span className="min-w-[6rem] text-right font-display italic">
          {saveState === 'saving' && 'saving…'}{saveState === 'saved' && 'saved'}{saveState === 'error' && <span className="text-destructive/80">couldn't save</span>}
        </span>
      </footer>
    </div>,
    document.body,
  )
}
