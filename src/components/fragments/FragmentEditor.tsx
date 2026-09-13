import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Fragment, type FragmentVersion } from '@/lib/api'
import { qk, q, useActiveBranchId } from '@/lib/query-keys'
import { componentId, fragmentComponentId } from '@/lib/dom-ids'
import { readImageUrl } from '@/lib/fragment-visuals'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Pin, Trash2, X, Monitor, User, Archive, Undo2, Copy, Check, Sparkles, Lock, Unlock } from 'lucide-react'
import type { FrozenSection } from '@/lib/api/types'
import { RefinementPanel } from '@/components/refinement/RefinementPanel'
import { copyFragmentToClipboard } from '@/lib/fragment-clipboard'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Eyebrow, MetaLabel } from '@/components/ui/prose-text'
import {
  compareFragmentTypeVisuals,
  getFragmentTypeVisual,
  isVersionedFragmentType,
} from '@/components/fragments/fragment-type-icons'
import { FragmentArtwork, FragmentMetadata } from './FragmentIdentity'
import { FragmentMediaField, FragmentTextField } from './FragmentContentFields'
import { FragmentVersionHistory } from './FragmentVersionHistory'
import { FragmentMetadataPanel } from './FragmentMetadataPanel'

export interface FragmentPrefill {
  name: string
  description: string
  content: string
}

interface FragmentEditorProps {
  storyId: string
  fragment: Fragment | null
  mode: 'view' | 'edit'
  onClose: () => void
  onSaved: () => void
  onFragmentChange?: (fragment: Fragment | null) => void
}

export function FragmentEditor({
  storyId,
  fragment: fragmentProp,
  mode,
  onClose,
  onSaved,
  onFragmentChange,
}: FragmentEditorProps) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const confirm = useConfirm()

  // Fetch live fragment data so sticky/placement updates are reflected immediately.
  // initialDataUpdatedAt prevents TanStack Query from treating initialData as immediately
  // stale and firing a background refetch on every fragment selection.
  const { data: liveFragment } = useQuery({
    ...q.fragment(storyId, branchId, fragmentProp?.id),
    enabled: !!fragmentProp?.id,
    initialData: fragmentProp ?? undefined,
    initialDataUpdatedAt: fragmentProp ? Date.now() : undefined,
  })

  const fragment = liveFragment ?? fragmentProp
  const isVersionedType = !!fragment && isVersionedFragmentType(fragment.type)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [type, setType] = useState('prose')
  const [copied, setCopied] = useState(false)
  const [showRefine, setShowRefine] = useState(false)
  const [previewVersion, setPreviewVersion] = useState<FragmentVersion | null>(null)

  // Auto-save state for edit mode
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userEditedRef = useRef(false)

  // Media queries for clipboard copy (embed attached images)
  const { data: _imageFragments } = useQuery({ ...q.fragments(storyId, branchId, 'image'), staleTime: 10_000 })
  const { data: _iconFragments } = useQuery({ ...q.fragments(storyId, branchId, 'icon'), staleTime: 10_000 })
  const mediaById = useMemo(() => {
    const map = new Map<string, Fragment>()
    for (const f of _imageFragments ?? []) map.set(f.id, f)
    for (const f of _iconFragments ?? []) map.set(f.id, f)
    return map
  }, [_imageFragments, _iconFragments])

  const { data: versionData } = useQuery({
    ...q.fragmentVersions(storyId, branchId, fragment?.id),
    enabled: !!fragment?.id && isVersionedType,
  })

  const { data: story } = useQuery({
    queryKey: ['story', storyId],
    queryFn: () => api.stories.get(storyId),
  })

  const { data: fragmentTypes } = useQuery({
    queryKey: ['fragment-types', storyId],
    queryFn: () => api.fragments.types(storyId),
  })

  const sortedTypes = useMemo(() => {
    if (!fragmentTypes) return []
    const customTypes = story?.settings.customFragmentTypes ?? []
    return [...fragmentTypes].sort((a, b) => {
      const visualA = getFragmentTypeVisual(a.type, customTypes)
      const visualB = getFragmentTypeVisual(b.type, customTypes)
      return compareFragmentTypeVisuals(visualA, visualB)
    })
  }, [fragmentTypes, story?.settings.customFragmentTypes])

  // Sync local state from the source fragment (prop or live query data).
  // Uses liveFragment so that external updates (e.g. refinement agent) are reflected.
  // Skips sync when the user has unsaved edits to prevent overwriting their work.
  // Also resets dirty tracking when the fragment ID changes, so switching fragments
  // always syncs fresh data (avoids race with a separate reset effect).
  const sourceFragment = liveFragment ?? fragmentProp
  const prevFragmentIdRef = useRef(fragmentProp?.id)
  useEffect(() => {
    // Reset dirty tracking when switching to a different fragment
    if (fragmentProp?.id !== prevFragmentIdRef.current) {
      prevFragmentIdRef.current = fragmentProp?.id
      userEditedRef.current = false
      setSaveStatus('idle')
    }

    if (sourceFragment) {
      if (!userEditedRef.current) {
        setName(sourceFragment.name)
        setDescription(sourceFragment.description)
        setContent(sourceFragment.content)
      }
      setType(sourceFragment.type)
    }
  }, [sourceFragment, fragmentProp?.id])

  // When the active timeline changes, the branch-scoped version list refetches but the
  // fragment query is seeded with `initialData` and suppresses its own refetch, leaving
  // `fragment.version` on the old branch — desyncing the "current version" highlight and
  // any open preview. Force-load the fragment for the new branch (realigning the cache),
  // drop the stale preview, and close the editor if the fragment is gone on the new
  // branch rather than leaving a phantom on screen.
  const prevBranchIdRef = useRef(branchId)
  useEffect(() => {
    if (branchId === prevBranchIdRef.current) return
    prevBranchIdRef.current = branchId
    setPreviewVersion(null)
    const id = fragmentProp?.id
    if (!id) return
    queryClient
      .fetchQuery({ ...q.fragment(storyId, branchId, id), staleTime: 0, retry: false })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) onClose()
      })
  }, [branchId, fragmentProp?.id, storyId, queryClient, onClose])

  const invalidate = async (overrideType?: string) => {
    const fType = overrideType ?? fragment?.type
    const promises: Promise<void>[] = [
      queryClient.invalidateQueries({ queryKey: ['fragments-archived', storyId] }),
    ]
    // Invalidate only queries whose type slot matches the fragment's type (or has no type slot)
    // This avoids cascading to unrelated type lists (image, icon, etc.)
    queryClient.invalidateQueries({
      queryKey: ['fragments', storyId],
      predicate: (q) => {
        const typeSlot = q.queryKey[3]
        return typeSlot === undefined || typeSlot === fType
      },
    })
    if (fType === 'prose') {
      promises.push(queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] }))
      // Prose edits trigger re-analysis, so refresh the freshness indicator's index.
      promises.push(queryClient.invalidateQueries({ queryKey: ['librarian-analysis-index', storyId] }))
    }
    if (fragment?.id) {
      promises.push(queryClient.invalidateQueries({ queryKey: qk.fragment(storyId, branchId, fragment.id) }))
      // Each save writes a new version — refresh the history panel so it appears.
      promises.push(queryClient.invalidateQueries({ queryKey: qk.fragmentVersions(storyId, branchId, fragment.id) }))
    }
    await Promise.all(promises)
  }

  const updateMutation = useMutation({
    mutationFn: (data: { name: string; description: string; content: string; type?: string }) =>
      api.fragments.update(storyId, fragment!.id, data),
    onSuccess: (data) => {
      invalidate()
      if (data.idChanged) {
        onFragmentChange?.(data)
      }
      onSaved()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.fragments.delete(storyId, fragment!.id),
    onSuccess: () => {
      invalidate()
      onClose()
    },
  })

  const archiveMutation = useMutation({
    mutationFn: () => api.fragments.archive(storyId, fragment!.id),
    onSuccess: () => {
      invalidate()
      onClose()
    },
  })

  const restoreMutation = useMutation({
    mutationFn: () => api.fragments.restore(storyId, fragment!.id),
    onSuccess: () => {
      invalidate()
    },
  })

  const stickyMutation = useMutation({
    mutationFn: (sticky: boolean) =>
      api.fragments.toggleSticky(storyId, fragment!.id, sticky),
    onSuccess: () => {
      invalidate()
    },
  })

  const placementMutation = useMutation({
    mutationFn: (placement: 'system' | 'user') =>
      api.fragments.setPlacement(storyId, fragment!.id, placement),
    onSuccess: () => {
      invalidate()
    },
  })

  // Auto-save never refetches qk.fragment — that would let the sync effect
  // overwrite in-progress edits. Version metadata is patched by hand below.
  const autoSaveMutation = useMutation({
    mutationFn: (data: { name: string; description: string; content: string; type?: string }) =>
      // 'autosave' lets the server coalesce this typing session into a single version
      // instead of appending one per debounced save. Deliberate saves omit the reason.
      api.fragments.update(storyId, fragment!.id, { ...data, reason: 'autosave' }),
    onSuccess: (saved) => {
      const fType = fragment?.type
      queryClient.invalidateQueries({
        queryKey: ['fragments', storyId],
        predicate: (q) => {
          const typeSlot = q.queryKey[3]
          return typeSlot === undefined || typeSlot === fType
        },
      })
      queryClient.invalidateQueries({ queryKey: ['fragments-archived', storyId] })
      if (fType === 'prose') {
        queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] })
        queryClient.invalidateQueries({ queryKey: ['librarian-analysis-index', storyId] })
      }
      if (fragment?.id && isVersionedType) {
        // Surface the new version in the history panel, and mark it current by
        // patching only the version fields (keep cached content out of the editor).
        queryClient.invalidateQueries({ queryKey: qk.fragmentVersions(storyId, branchId, fragment.id) })
        queryClient.setQueryData<Fragment>(
          qk.fragment(storyId, branchId, fragment.id),
          (prev) => prev ? { ...prev, version: saved.version, versions: saved.versions } : prev,
        )
      }
      setSaveStatus('saved')
      if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current)
      savedStatusTimerRef.current = setTimeout(() => setSaveStatus(s => s === 'saved' ? 'idle' : s), 2000)
    },
    onError: () => {
      setSaveStatus('idle')
    },
  })

  // Debounced auto-save for edit mode
  useEffect(() => {
    if (mode !== 'edit' || !fragment || !userEditedRef.current) return
    if (!name.trim()) return

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      setSaveStatus('saving')
      autoSaveMutation.mutate({ name, description, content })
    }, 800)

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [name, description, content, mode, fragment?.id])

  // Flush pending auto-save on close
  const handleClose = useCallback(() => {
    if (autoSaveTimerRef.current && userEditedRef.current && mode === 'edit' && fragment && name.trim()) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveMutation.mutate({ name, description, content })
    }
    onClose()
  }, [onClose, mode, fragment, name, description, content])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current)
    }
  }, [])

  // --- Protection helpers ---
  const isLocked = fragment?.meta?.locked === true
  const frozenSections: FrozenSection[] = useMemo(() => {
    const raw = fragment?.meta?.frozenSections
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (s): s is FrozenSection =>
        typeof s === 'object' && s !== null &&
        typeof s.id === 'string' && typeof s.text === 'string' && s.text !== '',
    )
  }, [fragment?.meta?.frozenSections])

  const metaMutation = useMutation({
    mutationFn: (newMeta: Record<string, unknown>) => {
      if (!fragment) throw new Error('No fragment')
      return api.fragments.update(storyId, fragment.id, {
        name: fragment.name,
        description: fragment.description,
        content: fragment.content,
        meta: newMeta,
      })
    },
    onSuccess: () => {
      invalidate()
    },
  })

  const toggleLock = () => {
    if (!fragment) return
    metaMutation.mutate({ ...fragment.meta, locked: !isLocked })
  }

  const freezeSelection = (selected: string) => {
    if (!fragment) return
    if (!selected.trim()) return
    const id = `fs-${Math.random().toString(36).slice(2, 10)}`
    const next: FrozenSection[] = [...frozenSections, { id, text: selected }]
    metaMutation.mutate({ ...fragment.meta, frozenSections: next })
  }

  const unfreezeSection = (sectionId: string) => {
    if (!fragment) return
    const next = frozenSections.filter((s) => s.id !== sectionId)
    metaMutation.mutate({ ...fragment.meta, frozenSections: next })
  }

  const revertVersionMutation = useMutation({
    mutationFn: (version: number) => api.fragments.revertToVersion(storyId, fragment!.id, version),
    onSuccess: () => {
      invalidate()
      if (fragment?.id) {
        queryClient.invalidateQueries({ queryKey: qk.fragmentVersions(storyId, branchId, fragment.id) })
      }
    },
  })

  const deleteVersionMutation = useMutation({
    mutationFn: (version: number) => api.fragments.deleteVersion(storyId, fragment!.id, version),
    onSuccess: (_data, version) => {
      if (previewVersion?.version === version) setPreviewVersion(null)
      if (fragment?.id) {
        queryClient.invalidateQueries({ queryKey: qk.fragmentVersions(storyId, branchId, fragment.id) })
      }
    },
  })

  const versions = (versionData?.versions ?? []).slice().sort((a, b) => b.version - a.version)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Auto-save handles persistence in edit mode
  }

  const isEditing = mode === 'edit'
  const isMediaType = type === 'image' || type === 'icon'

  const mediaPreviewUrl = isMediaType
    ? readImageUrl({
      id: fragment?.id ?? 'preview',
      type,
      name,
      description,
      content,
      tags: fragment?.tags ?? [],
      refs: fragment?.refs ?? [],
      sticky: fragment?.sticky ?? false,
      placement: fragment?.placement ?? 'user',
      createdAt: fragment?.createdAt ?? '',
      updatedAt: fragment?.updatedAt ?? '',
      order: fragment?.order ?? 0,
      meta: fragment?.meta ?? {},
      archived: fragment?.archived ?? false,
    })
    : null

  return (
    <div className="flex flex-col h-full" data-component-id="fragment-editor-root">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-3 sm:py-4 gap-2 border-b border-border/50" data-component-id={componentId('fragment-editor', mode)}>
        <div className="flex min-w-0 items-center gap-2.5">
          {fragment && <FragmentArtwork fragment={fragment} mediaById={mediaById} className="size-9" />}
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg">{name || fragment?.name || ''}</h2>
            {fragment && (
              <FragmentMetadata
                fragment={fragment}
                showType={false}
                className="mt-0.5"
                typeControl={(
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Badge variant="outline" className="h-4 cursor-pointer px-1 text-ui-label transition-colors hover:bg-secondary/80">{fragment.type}</Badge>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
                      {sortedTypes.map((option) => (
                        <DropdownMenuItem
                          key={option.type}
                          className="text-xs"
                          onClick={() => updateMutation.mutate({
                            type: option.type,
                            name: name || fragment.name,
                            description: description || fragment.description,
                            content: content || fragment.content,
                          })}
                        >
                          {option.type}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              />
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 overflow-x-auto">
          {fragment && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={async () => {
                    if (!await copyFragmentToClipboard(fragment, mediaById)) return
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  data-component-id={fragmentComponentId(fragment, 'copy-clipboard')}
                  aria-label={copied ? 'Copied fragment' : 'Copy fragment'}
                >
                  {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
                  <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy fragment to clipboard</TooltipContent>
            </Tooltip>
          )}
          {fragment && !fragment.archived && fragment.type !== 'prose' && fragment.type !== 'image' && fragment.type !== 'icon' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant={showRefine ? 'secondary' : 'ghost'}
                  className="h-7 text-xs gap-1"
                  onClick={() => setShowRefine(!showRefine)}
                  aria-label="Refine fragment"
                >
                  <Sparkles className="size-3" />
                  <span className="hidden sm:inline">Refine</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Refine this fragment with Librarian</TooltipContent>
            </Tooltip>
          )}
          {fragment && !fragment.archived && fragment.type !== 'prose' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className={`h-7 text-xs gap-1 ${isLocked ? 'text-amber-500 hover:text-amber-600' : ''}`}
                  onClick={toggleLock}
                  disabled={metaMutation.isPending}
                  aria-label={isLocked ? 'Unlock fragment' : 'Lock fragment'}
                >
                  {isLocked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                  <span className="hidden sm:inline">{isLocked ? 'Locked' : 'Lock'}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{isLocked ? 'Unlock — allow AI modifications' : 'Lock — prevent AI from modifying'}</TooltipContent>
            </Tooltip>
          )}
          {fragment && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={() => stickyMutation.mutate(!fragment.sticky)}
                  disabled={stickyMutation.isPending}
                  data-component-id={fragmentComponentId(fragment, 'sticky-toggle')}
                  aria-label={fragment.sticky ? 'Unpin fragment' : 'Pin fragment'}
                >
                  <Pin className="size-3" />
                  <span className="hidden sm:inline">{fragment.sticky ? 'Unpin' : 'Pin'}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{fragment.sticky ? 'Remove from context' : 'Always include in context'}</TooltipContent>
            </Tooltip>
          )}
          {fragment && fragment.sticky && fragment.type !== 'prose' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={() => placementMutation.mutate(fragment.placement === 'system' ? 'user' : 'system')}
                  disabled={placementMutation.isPending}
                  data-component-id={fragmentComponentId(fragment, 'placement-toggle')}
                  aria-label={fragment.placement === 'system' ? 'Move to user context' : 'Move to system context'}
                >
                  {fragment.placement === 'system' ? <Monitor className="size-3" /> : <User className="size-3" />}
                  <span className="hidden sm:inline">{fragment.placement === 'system' ? 'System' : 'User'}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{fragment.placement === 'system' ? 'Placed in system context' : 'Placed in user context'}</TooltipContent>
            </Tooltip>
          )}
          {fragment && !fragment.archived && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                  onClick={async () => {
                    if (await confirm({ title: 'Archive this fragment?', confirmText: 'Archive' })) {
                      archiveMutation.mutate()
                    }
                  }}
                  disabled={archiveMutation.isPending}
                  aria-label="Archive fragment"
                >
                  <Archive className="size-3" />
                  <span className="hidden sm:inline">Archive</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Move to archive</TooltipContent>
            </Tooltip>
          )}
          {fragment && fragment.archived && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs gap-1"
                    onClick={() => restoreMutation.mutate()}
                    disabled={restoreMutation.isPending}
                    aria-label="Restore fragment"
                  >
                    <Undo2 className="size-3" />
                    <span className="hidden sm:inline">Restore</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Restore from archive</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs gap-1 text-destructive/70 hover:text-destructive"
                    onClick={async () => {
                      if (await confirm({ title: 'Permanently delete this fragment?', description: 'This cannot be undone.', confirmText: 'Delete', destructive: true })) {
                        deleteMutation.mutate()
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    aria-label="Permanently delete fragment"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Permanently delete</TooltipContent>
              </Tooltip>
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" onClick={handleClose} data-component-id="fragment-editor-close" aria-label="Close fragment editor">
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {showRefine && fragment && (
        <div className="px-6 py-3 border-b border-border/30">
          <RefinementPanel
            storyId={storyId}
            fragmentId={fragment.id}
            fragmentName={fragment.name}
            onComplete={() => {
              invalidate()
            }}
            onClose={() => setShowRefine(false)}
          />
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-auto">
        <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-5">
          <div>
            <Eyebrow asChild><label>Name</label></Eyebrow>
            <Input
              value={name}
              onChange={(e) => { userEditedRef.current = true; setName(e.target.value) }}
              disabled={!isEditing}
              className="mt-1.5 bg-transparent"
              required
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Eyebrow asChild><label>Description</label></Eyebrow>
              <MetaLabel>{description.length}/250</MetaLabel>
            </div>
            <Input
              value={description}
              onChange={(e) => { userEditedRef.current = true; setDescription(e.target.value) }}
              maxLength={250}
              disabled={!isEditing}
              className="mt-1.5 bg-transparent"
              required
            />
          </div>
        </div>

        <div className="mx-6 h-px bg-border/30" />

        <div className="px-6 py-5">
          {isMediaType ? (
            <FragmentMediaField
              type={type as 'image' | 'icon'}
              name={name}
              value={content}
              previewUrl={mediaPreviewUrl}
              editable={isEditing}
              onChange={(value) => {
                userEditedRef.current = true
                setContent(value)
              }}
            />
          ) : (
            <FragmentTextField
              key={fragment?.id ?? 'new'}
              content={content}
              initialView={fragment?.content.trim() ? 'preview' : 'write'}
              frozenSections={frozenSections}
              editable={isEditing}
              canFreeze={!!fragment && !fragment.archived && !isLocked && fragment.type !== 'prose'}
              mutationPending={metaMutation.isPending}
              onChange={(value) => {
                userEditedRef.current = true
                setContent(value)
              }}
              onFreeze={freezeSelection}
              onUnfreeze={unfreezeSection}
            />
          )}
        </div>

        {fragment && (
          <>
            {isVersionedType && (
              <>
                <div className="mx-6 h-px bg-border/30" />
                <FragmentVersionHistory
                  fragment={fragment}
                  content={content}
                  versions={versions}
                  preview={previewVersion}
                  switching={revertVersionMutation.isPending}
                  deleting={deleteVersionMutation.isPending}
                  onPreview={setPreviewVersion}
                  onSwitch={(version) => revertVersionMutation.mutate(version)}
                  onDelete={(version) => deleteVersionMutation.mutate(version)}
                />
              </>
            )}
            <div className="mx-6 h-px bg-border/30" />
            <FragmentMetadataPanel
              storyId={storyId}
              fragment={fragment}
              includeVisuals={fragment.type !== 'image' && fragment.type !== 'icon'}
            />
          </>
        )}

        {isEditing && (
          <div className="flex items-center gap-2 px-6 py-4 border-t border-border/50">
            <MetaLabel className="transition-opacity">
              {saveStatus === 'saving' && 'Saving...'}
              {saveStatus === 'saved' && 'Saved'}
            </MetaLabel>
            <div className="flex-1" />
            <Button type="button" size="sm" variant="ghost" onClick={handleClose}>
              Close
            </Button>
          </div>
        )}
      </form>
    </div>
  )
}
