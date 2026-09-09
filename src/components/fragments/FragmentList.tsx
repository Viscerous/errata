import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { api, type Fragment, type Folder } from '@/lib/api'
import { qk, q, useActiveBranchId } from '@/lib/query-keys'
import { componentId } from '@/lib/dom-ids'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner, EmptyState } from '@/components/ui/async-view'
import { Archive } from 'lucide-react'
import { FragmentFolderHeader, UncategorizedFragmentHeader } from './FragmentFolderHeaders'
import { FragmentListItem } from './FragmentListItem'
import { FragmentListToolbar, type FragmentSortMode } from './FragmentListToolbar'

interface FragmentListProps {
  storyId: string
  type?: string
  allowedTypes?: string[]
  listIdBase?: string
  onSelect: (fragment: Fragment) => void
  onCreateNew: () => void
  onImport?: () => void
  onImportCard?: () => void
  selectedId?: string
}

interface FolderGroup {
  folder: Folder | null // null = uncategorized
  fragments: Fragment[]
}

export function FragmentList({
  storyId,
  type,
  allowedTypes,
  listIdBase,
  onSelect,
  onCreateNew,
  onImport,
  onImportCard,
  selectedId,
}: FragmentListProps) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<FragmentSortMode>('order')
  const queryClient = useQueryClient()
  const dragItem = useRef<number | null>(null)
  const [dragFragmentId, setDragFragmentId] = useState<string | null>(null)
  const [dragDisplayOrder, setDragDisplayOrder] = useState<Fragment[] | null>(null)
  const [isDragOverArchive, setIsDragOverArchive] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null)
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const [folderDragOverId, setFolderDragOverId] = useState<string | null>(null)
  const [folderDisplayOrder, setFolderDisplayOrder] = useState<Folder[] | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [newFolderId, setNewFolderId] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const branchId = useActiveBranchId(storyId)

  // Branch-scoped and shaped `['fragments', storyId, branchId, type, scope]` so
  // `type` stays at index 3 for the invalidation predicates below (it may be
  // undefined for an all-types list — keep the slot explicit).
  const fragmentsQueryKey = ['fragments', storyId, branchId, type, allowedTypes?.join(',') ?? 'all']

  const { data: fragments, isLoading } = useQuery({
    queryKey: fragmentsQueryKey,
    queryFn: () => api.fragments.list(storyId, type, branchId),
    staleTime: 2_000,
  })

  const { data: foldersData } = useQuery({
    queryKey: qk.folders(storyId, branchId),
    queryFn: () => api.folders.list(storyId),
    staleTime: 5_000,
  })
  const folders = foldersData?.folders
  const folderAssignments = foldersData?.assignments ?? {}

  const { data: imageFragments } = useQuery({ ...q.fragments(storyId, branchId, 'image'), staleTime: 10_000 })
  const { data: iconFragments } = useQuery({ ...q.fragments(storyId, branchId, 'icon'), staleTime: 10_000 })

  const pinMutation = useMutation({
    mutationFn: (fragment: Fragment) =>
      api.fragments.update(storyId, fragment.id, {
        name: fragment.name,
        description: fragment.description,
        content: fragment.content,
        sticky: !fragment.sticky,
      }),
    onSuccess: (_data, fragment) => {
      queryClient.invalidateQueries({
        queryKey: ['fragments', storyId],
        predicate: (q) => {
          const typeSlot = q.queryKey[3]
          return typeSlot === undefined || typeSlot === fragment.type
        },
      })
      queryClient.invalidateQueries({ queryKey: ['fragment', storyId] })
    },
  })

  const reorderMutation = useMutation({
    mutationFn: (items: Array<{ id: string; order: number }>) =>
      api.fragments.reorder(storyId, items),
    onMutate: async (items) => {
      await queryClient.cancelQueries({ queryKey: ['fragments', storyId] })
      const previous = queryClient.getQueryData<Fragment[]>(fragmentsQueryKey)
      queryClient.setQueryData<Fragment[]>(fragmentsQueryKey, (old) => {
        if (!old) return old
        const orderMap = new Map(items.map((item) => [item.id, item.order]))
        return old
          .map((f) => (orderMap.has(f.id) ? { ...f, order: orderMap.get(f.id)! } : f))
          .sort((a, b) => a.order - b.order)
      })
      return { previous }
    },
    onError: (_err, _items, context) => {
      if (context?.previous) {
        queryClient.setQueryData(fragmentsQueryKey, context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ['fragments', storyId],
        predicate: (q) => {
          const typeSlot = q.queryKey[3]
          return typeSlot === undefined || typeSlot === type
        },
      })
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (fragmentId: string) => api.fragments.archive(storyId, fragmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
      queryClient.invalidateQueries({ queryKey: ['fragments-archived', storyId] })
      queryClient.invalidateQueries({ queryKey: ['proseChain', storyId] })
    },
  })

  const createFolderMutation = useMutation({
    mutationFn: (name: string) => api.folders.create(storyId, name),
    onSuccess: (folder) => {
      queryClient.invalidateQueries({ queryKey: ['folders', storyId] })
      // Keep the new empty folder visible until it gets its first fragment
      setNewFolderId(folder.id)
      // Start renaming the new folder immediately
      setRenamingFolderId(folder.id)
      setRenameValue(folder.name)
    },
  })

  const renameFolderMutation = useMutation({
    mutationFn: ({ folderId, name }: { folderId: string; name: string }) =>
      api.folders.update(storyId, folderId, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders', storyId] })
    },
  })

  const deleteFolderMutation = useMutation({
    mutationFn: (folderId: string) => api.folders.delete(storyId, folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders', storyId] })
    },
  })

  const assignFolderMutation = useMutation({
    mutationFn: ({ fragmentId, folderId }: { fragmentId: string; folderId: string | null }) =>
      api.folders.assignFragment(storyId, fragmentId, folderId),
    onSuccess: (_data, { folderId }) => {
      queryClient.invalidateQueries({ queryKey: ['folders', storyId] })
      // Clear the "just-created" exception once a fragment is assigned to it
      if (folderId === newFolderId) setNewFolderId(null)
    },
  })

  const reorderFoldersMutation = useMutation({
    mutationFn: (items: Array<{ id: string; order: number }>) =>
      api.folders.reorder(storyId, items),
    onMutate: async (items) => {
      await queryClient.cancelQueries({ queryKey: ['folders', storyId] })
      const previous = queryClient.getQueryData<Folder[]>(qk.folders(storyId, branchId))
      queryClient.setQueryData<Folder[]>(qk.folders(storyId, branchId), (old) => {
        if (!old) return old
        const orderMap = new Map(items.map((item) => [item.id, item.order]))
        return old
          .map((f) => (orderMap.has(f.id) ? { ...f, order: orderMap.get(f.id)! } : f))
          .sort((a, b) => a.order - b.order)
      })
      return { previous }
    },
    onError: (_err, _items, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.folders(storyId, branchId), context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['folders', storyId] })
    },
  })

  // Stable callback refs so FragmentRow memo is never defeated
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const stableOnSelect = useCallback((fragment: Fragment) => {
    onSelectRef.current(fragment)
  }, [])

  const pinMutateRef = useRef(pinMutation.mutate)
  pinMutateRef.current = pinMutation.mutate
  const stableOnPin = useCallback((fragment: Fragment) => {
    pinMutateRef.current(fragment)
  }, [])

  const showType = type === undefined || !!allowedTypes?.length
  const supportsTypeFilter = type === undefined && !allowedTypes?.length
  const canDrag = sort === 'order' && !search.trim()
  const isSearching = !!search.trim()
  const hasFolders = (folders?.length ?? 0) > 0

  const typeOptions = useMemo(() => {
    if (!supportsTypeFilter || !fragments) return []
    const counts = new Map<string, number>()
    for (const fragment of fragments) {
      if (fragment.type === 'marker' || fragment.type === 'summary') continue
      counts.set(fragment.type, (counts.get(fragment.type) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value))
  }, [fragments, supportsTypeFilter])

  useEffect(() => {
    if (!supportsTypeFilter) {
      setTypeFilter('all')
      return
    }
    if (typeFilter !== 'all' && !typeOptions.some((option) => option.value === typeFilter)) {
      setTypeFilter('all')
    }
  }, [supportsTypeFilter, typeFilter, typeOptions])

  const filtered = useMemo(() => {
    if (!fragments) return []
    let list = [...fragments]

    // Markers are managed through the prose chain; summaries are managed
    // by the librarian panel. Neither belongs in the everyday fragment list.
    list = list.filter((f) => f.type !== 'marker' && f.type !== 'summary')

    if (allowedTypes && allowedTypes.length > 0) {
      list = list.filter((f) => allowedTypes.includes(f.type))
    }

    if (supportsTypeFilter && typeFilter !== 'all') {
      list = list.filter((f) => f.type === typeFilter)
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.description.toLowerCase().includes(q) ||
          f.id.toLowerCase().includes(q) ||
          f.type.toLowerCase().includes(q),
      )
    }

    switch (sort) {
      case 'name':
        list.sort((a, b) => a.name.localeCompare(b.name))
        break
      case 'newest':
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        break
      case 'oldest':
        list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        break
      case 'order':
      default:
        list.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
        break
    }

    return list
  }, [fragments, search, sort, allowedTypes, supportsTypeFilter, typeFilter])

  // The effective flat list: during drag it's the live-reordered list, otherwise filtered
  const effectiveList = dragDisplayOrder ?? filtered

  // Group fragments by folder (only when not searching and folders exist)
  const folderGroups = useMemo((): FolderGroup[] => {
    if (isSearching || !hasFolders) return []

    // Use live display order during folder drag, otherwise sort from query data
    const sortedFolders = folderDisplayOrder
      ? [...folderDisplayOrder]
      : [...(folders ?? [])].sort((a, b) => a.order - b.order)
    const byFolder = new Map<string | null, Fragment[]>()

    // Initialize folder buckets
    for (const folder of sortedFolders) {
      byFolder.set(folder.id, [])
    }
    byFolder.set(null, [])

    // Distribute from the effective list so drag-reorder is reflected live
    for (const fragment of effectiveList) {
      const folderId = folderAssignments[fragment.id] ?? null
      const validFolder = folderId && byFolder.has(folderId) ? folderId : null
      byFolder.get(validFolder)!.push(fragment)
    }

    // Only show folders that contain at least one fragment of the current type,
    // plus any just-created folder so users can drag fragments into it
    const groups: FolderGroup[] = []
    for (const folder of sortedFolders) {
      const folderFragments = byFolder.get(folder.id)!
      if (folderFragments.length > 0 || folder.id === newFolderId) {
        groups.push({ folder, fragments: folderFragments })
      }
    }
    // Uncategorized always last
    const uncategorized = byFolder.get(null)!
    if (uncategorized.length > 0 || groups.length > 0) {
      groups.push({ folder: null, fragments: uncategorized })
    }

    return groups
  }, [effectiveList, folders, folderAssignments, folderDisplayOrder, isSearching, hasFolders, newFolderId])

  // Map fragment ID → index in the effective flat list, so grouped view
  // can pass correct global indices to the drag handlers
  const fragmentIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < effectiveList.length; i++) {
      map.set(effectiveList[i].id, i)
    }
    return map
  }, [effectiveList])

  const useGroupedView = !isSearching && hasFolders && folderGroups.length > 0

  const mediaById = useMemo(() => {
    const map = new Map<string, Fragment>()
    for (const fragment of imageFragments ?? []) {
      map.set(fragment.id, fragment)
    }
    for (const fragment of iconFragments ?? []) {
      map.set(fragment.id, fragment)
    }
    return map
  }, [imageFragments, iconFragments])

  // Drag handlers — live shifting + optimistic reorder
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered
  const reorderMutateRef = useRef(reorderMutation.mutate)
  reorderMutateRef.current = reorderMutation.mutate

  const handleDragStart = useCallback((index: number, e: React.DragEvent) => {
    dragItem.current = index
    const list = filteredRef.current
    const id = list[index]?.id ?? null
    setDragFragmentId(id)
    setDragDisplayOrder([...list])
    if (id) {
      e.dataTransfer.setData('application/x-errata-fragment-id', id)
      e.dataTransfer.effectAllowed = 'move'
    }
  }, [])

  const handleDragEnter = useCallback((index: number) => {
    if (dragItem.current === null || dragItem.current === index) return
    setDragDisplayOrder((prev) => {
      if (!prev) return prev
      const reordered = [...prev]
      const [removed] = reordered.splice(dragItem.current!, 1)
      reordered.splice(index, 0, removed)
      dragItem.current = index
      return reordered
    })
  }, [])

  const droppedOnArchiveRef = useRef(false)
  const droppedOnFolderRef = useRef(false)

  const handleDragEnd = useCallback(() => {
    if (droppedOnArchiveRef.current || droppedOnFolderRef.current) {
      droppedOnArchiveRef.current = false
      droppedOnFolderRef.current = false
      dragItem.current = null
      setDragFragmentId(null)
      setDragDisplayOrder(null)
      setDropTargetFolderId(null)
      return
    }

    const displayOrder = dragDisplayOrderRef.current
    if (!displayOrder) {
      setDragFragmentId(null)
      setDragDisplayOrder(null)
      setDropTargetFolderId(null)
      return
    }

    // Only send fragments whose order actually changed
    const items = displayOrder
      .map((f, i) => ({ id: f.id, order: i }))
      .filter((item) => {
        const original = filteredRef.current.find((f) => f.id === item.id)
        return original && original.order !== item.order
      })
    if (items.length > 0) {
      reorderMutateRef.current(items)
    }

    dragItem.current = null
    setDragFragmentId(null)
    setDragDisplayOrder(null)
    setDropTargetFolderId(null)
  }, [])

  const dragDisplayOrderRef = useRef(dragDisplayOrder)
  dragDisplayOrderRef.current = dragDisplayOrder

  // Folder drop handlers (for fragment → folder assignment)
  const assignFolderRef = useRef(assignFolderMutation.mutate)
  assignFolderRef.current = assignFolderMutation.mutate
  const dragFragmentIdRef = useRef(dragFragmentId)
  dragFragmentIdRef.current = dragFragmentId
  const draggingFolderIdRef = useRef(draggingFolderId)
  draggingFolderIdRef.current = draggingFolderId

  const makeFolderDropHandlers = useCallback((folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault()
      // Only show fragment-assignment highlight when a fragment is being dragged
      if (dragFragmentIdRef.current && !draggingFolderIdRef.current) {
        setDropTargetFolderId(folderId)
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const { clientX, clientY } = e
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        setDropTargetFolderId((prev) => prev === folderId ? null : prev)
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      // Only assign fragment to folder if a fragment (not a folder) is being dragged
      if (draggingFolderIdRef.current) {
        setDropTargetFolderId(null)
        return
      }
      const fragId = dragFragmentIdRef.current ?? e.dataTransfer.getData('application/x-errata-fragment-id')
      if (fragId) {
        droppedOnFolderRef.current = true
        assignFolderRef.current({ fragmentId: fragId, folderId })
      }
      setDropTargetFolderId(null)
    },
  }), [])

  // Folder actions
  const handleToggleFolder = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }, [])

  const handleStartRename = useCallback((folderId: string) => {
    const folder = folders?.find((f) => f.id === folderId)
    if (folder) {
      setRenamingFolderId(folderId)
      setRenameValue(folder.name)
    }
  }, [folders])

  const handleRenameCommit = useCallback(() => {
    if (renamingFolderId && renameValue.trim()) {
      renameFolderMutation.mutate({ folderId: renamingFolderId, name: renameValue.trim() })
    }
    setRenamingFolderId(null)
  }, [renamingFolderId, renameValue, renameFolderMutation])

  const handleRenameCancel = useCallback(() => {
    setRenamingFolderId(null)
  }, [])

  const handleDeleteFolder = useCallback((folderId: string) => {
    deleteFolderMutation.mutate(folderId)
  }, [deleteFolderMutation])

  const handleCreateFolder = useCallback(() => {
    createFolderMutation.mutate('New Folder')
  }, [createFolderMutation])

  // Folder drag-reorder handlers
  const folderDragItemRef = useRef<string | null>(null)
  const foldersRef = useRef(folders)
  foldersRef.current = folders
  const reorderFoldersMutateRef = useRef(reorderFoldersMutation.mutate)
  reorderFoldersMutateRef.current = reorderFoldersMutation.mutate
  const folderDisplayOrderRef = useRef(folderDisplayOrder)
  folderDisplayOrderRef.current = folderDisplayOrder

  const handleFolderDragStart = useCallback((folderId: string, e: React.DragEvent) => {
    // Don't start folder drag if a fragment is already being dragged
    if (dragFragmentIdRef.current) return
    folderDragItemRef.current = folderId
    setDraggingFolderId(folderId)
    const sorted = [...(foldersRef.current ?? [])].sort((a, b) => a.order - b.order)
    setFolderDisplayOrder(sorted)
    e.dataTransfer.setData('application/x-errata-folder-id', folderId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleFolderDragEnter = useCallback((targetFolderId: string) => {
    const dragId = folderDragItemRef.current
    if (!dragId || dragId === targetFolderId) {
      // Not a folder drag or same target — clear folder drag-over highlight
      if (!dragId) setFolderDragOverId(null)
      return
    }
    setFolderDragOverId(targetFolderId)
    setFolderDisplayOrder((prev) => {
      if (!prev) return prev
      const fromIdx = prev.findIndex((f) => f.id === dragId)
      const toIdx = prev.findIndex((f) => f.id === targetFolderId)
      if (fromIdx === -1 || toIdx === -1) return prev
      const reordered = [...prev]
      const [removed] = reordered.splice(fromIdx, 1)
      reordered.splice(toIdx, 0, removed)
      return reordered
    })
  }, [])

  const handleFolderDragEnd = useCallback(() => {
    const displayOrder = folderDisplayOrderRef.current
    if (displayOrder && folderDragItemRef.current) {
      const items = displayOrder
        .map((f, i) => ({ id: f.id, order: i }))
        .filter((item) => {
          const original = foldersRef.current?.find((f) => f.id === item.id)
          return original && original.order !== item.order
        })
      if (items.length > 0) {
        reorderFoldersMutateRef.current(items)
      }
    }
    folderDragItemRef.current = null
    setDraggingFolderId(null)
    setFolderDragOverId(null)
    setFolderDisplayOrder(null)
  }, [])

  const displayList = dragDisplayOrder ?? filtered

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-6">
        <Spinner size="sm" />
      </div>
    )
  }

  // Render a list of fragments (used both in flat and grouped views)
  const renderFragmentList = (fragmentList: Fragment[]) => (
    <>
      {fragmentList.map((fragment) => {
        const globalIndex = fragmentIndexMap.get(fragment.id) ?? 0
        return (
          <FragmentListItem
            key={fragment.id}
            fragment={fragment}
            index={globalIndex}
            selected={selectedId === fragment.id}
            isDragging={dragFragmentId === fragment.id}
            canDrag={canDrag}
            showType={showType}
            mediaById={mediaById}
            onSelect={stableOnSelect}
            onPin={stableOnPin}
            pinPending={pinMutation.isPending}
            onDragStart={handleDragStart}
            onDragEnter={handleDragEnter}
            onDragEnd={handleDragEnd}
          />
        )
      })}
    </>
  )

  return (
    <div className="flex flex-col h-full" data-component-id={listIdBase ?? componentId(type ?? 'fragment', 'sidebar-list')}>
      <FragmentListToolbar
        baseId={listIdBase ?? type ?? 'fragment'}
        search={search}
        sort={sort}
        typeFilter={typeFilter}
        typeOptions={typeOptions}
        showTypeFilter={supportsTypeFilter && typeOptions.length > 1}
        creatingFolder={createFolderMutation.isPending}
        onSearchChange={setSearch}
        onSortChange={setSort}
        onTypeFilterChange={setTypeFilter}
        onCreateFolder={handleCreateFolder}
        onCreate={onCreateNew}
        onImport={onImport}
        onImportCard={onImportCard}
      />

      <ScrollArea className="flex-1 min-h-0" data-component-id={componentId(listIdBase ?? type ?? 'fragment', 'list-scroll')}>
        <div className="p-2 space-y-0.5" data-component-id={componentId(listIdBase ?? type ?? 'fragment', 'list-items')}>
          {/* Grouped view */}
          {useGroupedView && (
            <>
              {folderGroups.map((group) => {
                const folderId = group.folder?.id ?? '__uncategorized__'
                const isCollapsed = collapsedFolders.has(folderId)
                const dropHandlers = makeFolderDropHandlers(group.folder?.id ?? null)

                return (
                  <div key={folderId} className="mb-1">
                    {group.folder ? (
                      <FragmentFolderHeader
                        folder={group.folder}
                        count={group.fragments.length}
                        collapsed={isCollapsed}
                        isDropTarget={dropTargetFolderId === group.folder.id}
                        isDraggingFolder={draggingFolderId === group.folder.id}
                        isFolderDragOver={folderDragOverId === group.folder.id}
                        renamingId={renamingFolderId}
                        renameValue={renameValue}
                        onToggle={() => handleToggleFolder(folderId)}
                        onRename={handleStartRename}
                        onRenameChange={setRenameValue}
                        onRenameCommit={handleRenameCommit}
                        onRenameCancel={handleRenameCancel}
                        onDelete={handleDeleteFolder}
                        onFolderDragStart={handleFolderDragStart}
                        onFolderDragEnter={handleFolderDragEnter}
                        onFolderDragEnd={handleFolderDragEnd}
                        {...dropHandlers}
                      />
                    ) : (
                      <UncategorizedFragmentHeader
                        count={group.fragments.length}
                        collapsed={isCollapsed}
                        isDropTarget={dropTargetFolderId === null && dragFragmentId !== null}
                        onToggle={() => handleToggleFolder(folderId)}
                        {...dropHandlers}
                      />
                    )}
                    {!isCollapsed && group.fragments.length > 0 && (
                      <div className="ml-3 border-l border-border/20 pl-0.5 mt-0.5">
                        {renderFragmentList(group.fragments)}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* Flat view (search active or no folders) */}
          {!useGroupedView && (
            <>
              {displayList.length === 0 && (
                <EmptyState
                  title={search.trim() ? 'No matches' : 'No fragments yet'}
                  hint={search.trim() ? undefined : 'Create one with the plus above, or let the writing wizard draft a starter set.'}
                  className="py-8"
                />
              )}
              {renderFragmentList(displayList)}
            </>
          )}

          {/* Archive drop zone — visible during drag */}
          {dragFragmentId && (
            <div
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
              onDragEnter={() => setIsDragOverArchive(true)}
              onDragLeave={() => setIsDragOverArchive(false)}
              onDrop={() => {
                if (dragFragmentId) {
                  droppedOnArchiveRef.current = true
                  archiveMutation.mutate(dragFragmentId)
                }
                setIsDragOverArchive(false)
              }}
              className={`flex items-center justify-center gap-2 rounded-lg border-2 border-dashed py-4 mt-2 transition-colors ${
                isDragOverArchive
                  ? 'border-destructive/60 bg-destructive/10 text-destructive'
                  : 'border-muted-foreground/30 text-muted-foreground'
              }`}
            >
              <Archive className="size-4" />
              <span className="text-xs font-medium">Drop to archive</span>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
