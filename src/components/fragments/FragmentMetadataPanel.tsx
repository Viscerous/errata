import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Crop, ImagePlus, Link2, Unlink, Upload } from 'lucide-react'
import { api, type Fragment } from '@/lib/api'
import { q, qk, useActiveBranchId } from '@/lib/query-keys'
import { parseVisualRefs, readImageUrl, type VisualRef } from '@/lib/fragment-visuals'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyHint, Eyebrow, Hint } from '@/components/ui/prose-text'
import { CropDialog } from './CropDialog'

interface FragmentMetadataPanelProps {
  storyId: string
  fragment: Fragment
  includeVisuals: boolean
}

export function FragmentMetadataPanel({ storyId, fragment, includeVisuals }: FragmentMetadataPanelProps) {
  return (
    <section className="space-y-5 px-6 py-5">
      <FragmentTags storyId={storyId} fragmentId={fragment.id} />
      <FragmentReferences storyId={storyId} fragmentId={fragment.id} />
      {includeVisuals && <FragmentVisualReferences storyId={storyId} fragmentId={fragment.id} />}
    </section>
  )
}

function FragmentTags({ storyId, fragmentId }: { storyId: string; fragmentId: string }) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const [value, setValue] = useState('')
  const { data } = useQuery({
    queryKey: qk.tags(storyId, branchId, fragmentId),
    queryFn: () => api.fragments.getTags(storyId, fragmentId),
  })
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.tags(storyId, branchId, fragmentId) })
    queryClient.invalidateQueries({ queryKey: qk.fragment(storyId, branchId, fragmentId) })
  }
  const add = useMutation({
    mutationFn: (tag: string) => api.fragments.addTag(storyId, fragmentId, tag),
    onSuccess: () => {
      refresh()
      setValue('')
    },
  })
  const remove = useMutation({
    mutationFn: (tag: string) => api.fragments.removeTag(storyId, fragmentId, tag),
    onSuccess: refresh,
  })
  const submit = () => {
    const tag = value.trim().toLowerCase()
    if (tag && !data?.tags.includes(tag)) add.mutate(tag)
  }

  return (
    <div>
      <Eyebrow>Tags</Eyebrow>
      <div className="mb-2 mt-1.5 flex flex-wrap gap-1">
        {data?.tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 text-xs">
            {tag}
            <button type="button" onClick={() => remove.mutate(tag)} className="ml-0.5 transition-colors hover:text-destructive" aria-label={`Remove ${tag}`}>&times;</button>
          </Badge>
        ))}
        {!data?.tags.length && <EmptyHint asChild><span>No tags</span></EmptyHint>}
      </div>
      <RelationInput value={value} placeholder="Add tag…" action="Add" onChange={setValue} onSubmit={submit} />
    </div>
  )
}

function FragmentReferences({ storyId, fragmentId }: { storyId: string; fragmentId: string }) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const [value, setValue] = useState('')
  const { data } = useQuery({
    queryKey: qk.refs(storyId, branchId, fragmentId),
    queryFn: () => api.fragments.getRefs(storyId, fragmentId),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.refs(storyId, branchId, fragmentId) })
  const add = useMutation({
    mutationFn: (targetId: string) => api.fragments.addRef(storyId, fragmentId, targetId),
    onSuccess: () => {
      refresh()
      setValue('')
    },
  })
  const remove = useMutation({
    mutationFn: (targetId: string) => api.fragments.removeRef(storyId, fragmentId, targetId),
    onSuccess: refresh,
  })
  const submit = () => {
    const id = value.trim()
    if (id && !data?.refs.includes(id)) add.mutate(id)
  }

  return (
    <div>
      <Eyebrow>References</Eyebrow>
      <div className="mb-1 mt-1.5 flex flex-wrap gap-1">
        {data?.refs.map((refId) => (
          <Badge key={refId} variant="outline" className="gap-1 text-xs">
            {refId}
            <button type="button" onClick={() => remove.mutate(refId)} className="ml-0.5 transition-colors hover:text-destructive" aria-label={`Unlink ${refId}`}>&times;</button>
          </Badge>
        ))}
        {!data?.refs.length && <EmptyHint asChild><span>No references</span></EmptyHint>}
      </div>
      {!!data?.backRefs.length && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          <Hint asChild><span>Referenced by:</span></Hint>
          {data.backRefs.map((refId) => <Badge key={refId} variant="secondary" className="text-ui-label">{refId}</Badge>)}
        </div>
      )}
      <RelationInput value={value} placeholder="Fragment ID (e.g. ch-bokura)" action="Link" onChange={setValue} onSubmit={submit} />
    </div>
  )
}

function RelationInput({
  value,
  placeholder,
  action,
  onChange,
  onSubmit,
}: {
  value: string
  placeholder: string
  action: string
  onChange: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <div className="mt-1.5 flex gap-1.5">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-7 bg-transparent text-xs"
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          onSubmit()
        }}
      />
      <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onSubmit} disabled={!value.trim()}>{action}</Button>
    </div>
  )
}

interface CropTarget extends VisualRef {
  url: string
  name: string
}

function FragmentVisualReferences({ storyId, fragmentId }: { storyId: string; fragmentId: string }) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null)
  const [uploading, setUploading] = useState(false)
  const { data: fragment } = useQuery(q.fragment(storyId, branchId, fragmentId))
  const { data: images } = useQuery(q.fragments(storyId, branchId, 'image'))
  const { data: icons } = useQuery(q.fragments(storyId, branchId, 'icon'))
  const media = useMemo(() => [...(icons ?? []), ...(images ?? [])], [icons, images])
  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media])
  const references = parseVisualRefs(fragment?.meta)
  const available = media.filter((item) => !references.some((reference) => reference.fragmentId === item.id))

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.fragment(storyId, branchId, fragmentId) })
    queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
  }
  const save = useMutation({
    mutationFn: (visualRefs: VisualRef[]) => updateVisualReferences(storyId, fragment, visualRefs),
    onSuccess: refresh,
  })
  const upload = async (file: File) => {
    if (!fragment) return
    setUploading(true)
    try {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsDataURL(file)
      })
      const created = await api.fragments.create(storyId, {
        type: 'image',
        name: file.name.replace(/\.[^.]+$/, ''),
        description: file.name.slice(0, 250),
        content,
      })
      await updateVisualReferences(storyId, fragment, [...references, { fragmentId: created.id, kind: 'image' }])
      refresh()
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <Eyebrow>Visual</Eyebrow>
      {references.length > 0 && (
        <div className="mb-3 mt-2 space-y-1.5">
          {references.map((reference) => {
            const item = mediaById.get(reference.fragmentId)
            const url = item ? readImageUrl(item) : null
            return (
              <div key={`${reference.kind}:${reference.fragmentId}`} className="group flex items-center gap-2 rounded-md border border-border/40 p-1.5">
                {url ? <img src={url} alt="" className="size-8 shrink-0 rounded bg-muted/30 object-cover" /> : <div className="size-8 shrink-0 rounded bg-muted/30" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{item?.name ?? reference.fragmentId}</p>
                  <Hint asChild>
                    <p>{reference.kind}{reference.boundary ? ` · crop ${Math.round(reference.boundary.width * 100)}% × ${Math.round(reference.boundary.height * 100)}%` : ''}</p>
                  </Hint>
                </div>
                {url && (
                  <VisualAction label="Set crop region" icon={<Crop className="size-3" />} onClick={() => setCropTarget({ ...reference, url, name: item?.name ?? reference.fragmentId })} />
                )}
                <VisualAction label="Unlink" destructive icon={<Unlink className="size-3" />} disabled={save.isPending} onClick={() => save.mutate(references.filter((candidate) => candidate !== reference))} />
              </div>
            )
          })}
        </div>
      )}

      {references.length === 0 && available.length === 0 && <EmptyHint className="mb-2 mt-1.5">No image or icon linked</EmptyHint>}
      {available.length > 0 && (
        <div className="mb-2 mt-2 flex flex-wrap gap-1.5">
          {available.map((item) => {
            const url = readImageUrl(item)
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => save.mutate([...references, { fragmentId: item.id, kind: item.type as 'icon' | 'image' }])}
                disabled={save.isPending}
                className="group/tile relative size-12 shrink-0 overflow-hidden rounded-md border border-border/40 transition-all hover:border-primary/50 hover:ring-1 hover:ring-primary/20"
                title={`Link ${item.name}`}
              >
                {url ? <img src={url} alt={item.name} className="size-full bg-muted/20 object-cover" /> : <div className="flex size-full items-center justify-center bg-muted/30"><ImagePlus className="size-3.5 text-muted-foreground" /></div>}
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/tile:bg-black/40">
                  <Link2 className="size-3 text-white opacity-0 transition-opacity group-hover/tile:opacity-100" />
                </div>
              </button>
            )
          })}
          <UploadVisualButton uploading={uploading} tile onUpload={upload} />
        </div>
      )}
      {available.length === 0 && <UploadVisualButton uploading={uploading} onUpload={upload} />}

      {cropTarget && (
        <CropDialog
          open
          onOpenChange={(open) => { if (!open) setCropTarget(null) }}
          imageUrl={cropTarget.url}
          imageName={cropTarget.name}
          initialBoundary={cropTarget.boundary}
          onApply={(boundary) => {
            save.mutate(references.map((reference) => (
              reference.fragmentId === cropTarget.fragmentId && reference.kind === cropTarget.kind
                ? { ...reference, boundary }
                : reference
            )))
            setCropTarget(null)
          }}
        />
      )}
    </div>
  )
}

function VisualAction({ label, icon, destructive, disabled, onClick }: { label: string; icon: React.ReactNode; destructive?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon" variant="ghost" className={`size-6 shrink-0 opacity-0 transition-all group-hover:opacity-100 ${destructive ? 'text-muted-foreground hover:text-destructive' : 'text-muted-foreground hover:text-foreground'}`} onClick={onClick} disabled={disabled} aria-label={label}>{icon}</Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function UploadVisualButton({ uploading, tile, onUpload }: { uploading: boolean; tile?: boolean; onUpload: (file: File) => Promise<void> }) {
  return (
    <label className={tile
      ? `flex size-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-dashed border-border/40 transition-colors ${uploading ? 'opacity-50' : 'cursor-pointer hover:border-primary/40 hover:bg-accent/30'}`
      : `inline-flex h-7 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors ${uploading ? 'pointer-events-none opacity-50' : 'cursor-pointer border-border/40 hover:bg-accent/50'}`
    }>
      <Upload className="size-3.5 text-muted-foreground" />
      <span className={tile ? 'text-[0.5rem] text-muted-foreground' : ''}>{uploading ? 'Uploading…' : tile ? 'Upload' : 'Upload & link'}</span>
      <input
        type="file"
        accept="image/*"
        className="hidden"
        disabled={uploading}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void onUpload(file)
          event.target.value = ''
        }}
      />
    </label>
  )
}

function updateVisualReferences(storyId: string, fragment: Fragment | undefined, visualRefs: VisualRef[]) {
  if (!fragment) throw new Error('Fragment not loaded')
  return api.fragments.update(storyId, fragment.id, {
    name: fragment.name,
    description: fragment.description,
    content: fragment.content,
    sticky: fragment.sticky,
    order: fragment.order,
    placement: fragment.placement,
    meta: { ...fragment.meta, visualRefs },
  })
}
