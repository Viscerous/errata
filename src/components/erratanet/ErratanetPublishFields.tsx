import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ExternalLink, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { packPageUrl } from '@/lib/erratanet/pack-schema'
import type { BumpKind } from '@/lib/erratanet/publish-utils'
import { SegmentedControl, SettingsSelect } from '@/components/settings/primitives'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Eyebrow, Hint, Metric } from '@/components/ui/prose-text'

export const ERRATANET_LICENSES = [
  { value: 'CC0-1.0', label: 'CC0 1.0 (public domain)' },
  { value: 'CC-BY-4.0', label: 'CC BY 4.0 (attribution)' },
  { value: 'CC-BY-SA-4.0', label: 'CC BY-SA 4.0 (share-alike)' },
  { value: 'CC-BY-NC-4.0', label: 'CC BY-NC 4.0 (non-commercial)' },
  { value: 'proprietary', label: 'Proprietary (all rights reserved)' },
] as const

export type ErratanetVisibility = 'public' | 'unlisted'

export function useErratanetPackLookup(packId: string | null, enabled: boolean) {
  const [lookupPackId, setLookupPackId] = useState(packId)
  useEffect(() => {
    const timer = setTimeout(() => setLookupPackId(packId), 400)
    return () => clearTimeout(timer)
  }, [packId])

  const query = useQuery({
    queryKey: ['erratanet-pack', lookupPackId],
    queryFn: async () => {
      if (!lookupPackId) return null
      try {
        return await api.erratanet.getPack(lookupPackId)
      } catch {
        return null
      }
    },
    enabled: enabled && !!lookupPackId,
    staleTime: 30_000,
  })
  return { ...query, lookupPackId }
}

export function ErratanetAccountNotice({ action }: { action: 'publishing' | 'sharing' }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500/80" />
      <Hint className="leading-snug text-amber-600/80 dark:text-amber-400/80">
        No hub account connected. Sign in from the ErrataNet panel before {action}.
      </Hint>
    </div>
  )
}

export function ErratanetPublishSuccess({
  verb,
  id,
  version,
  hubUrl,
}: {
  verb: 'Published' | 'Shared'
  id: string
  version: string | null
  hubUrl?: string
}) {
  const url = packPageUrl(hubUrl, id)
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-primary/10">
        <Check className="size-5 text-primary" />
      </div>
      <div>
        <p className="text-sm font-medium">{verb}</p>
        <p className="mt-1 font-mono text-ui-body text-muted-foreground">{id}</p>
        {version && <Hint className="mt-1">version {version}</Hint>}
      </div>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border/40 px-3 py-1.5 text-ui-body text-foreground/80 transition-colors hover:border-border hover:text-foreground">
          View on ErrataNet
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  )
}

export function ErratanetIdentityFields({
  fieldPrefix,
  handle,
  slug,
  slugPlaceholder,
  onSlugChange,
  title,
  titlePlaceholder,
  onTitleChange,
  description,
  descriptionPlaceholder,
  onDescriptionChange,
  readme,
  readmePlaceholder,
  onReadmeChange,
  license,
  onLicenseChange,
  tags,
  onTagsChange,
  autoFocusSlug,
}: {
  fieldPrefix: string
  handle: string | null
  slug: string
  slugPlaceholder: string
  onSlugChange: (value: string) => void
  title: string
  titlePlaceholder: string
  onTitleChange: (value: string) => void
  description: string
  descriptionPlaceholder: string
  onDescriptionChange: (value: string) => void
  readme: string
  readmePlaceholder: string
  onReadmeChange: (value: string) => void
  license: string
  onLicenseChange: (value: string) => void
  tags: string[]
  onTagsChange: (tags: string[]) => void
  autoFocusSlug?: boolean
}) {
  const [tagDraft, setTagDraft] = useState('')
  const descriptionOverLimit = description.length > 250
  const addTag = useCallback(() => {
    const tag = tagDraft.trim().toLowerCase()
    if (tag && !tags.includes(tag)) onTagsChange([...tags, tag])
    setTagDraft('')
  }, [onTagsChange, tagDraft, tags])
  const fieldId = (name: string) => `${fieldPrefix}-${name}`

  return (
    <>
      <div>
        <Eyebrow asChild><label className="mb-2 block" htmlFor={fieldId('slug')}>Slug</label></Eyebrow>
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-ui-body text-muted-foreground">@{handle ?? 'handle'}/</span>
          <Input
            id={fieldId('slug')}
            value={slug}
            onChange={(event) => onSlugChange(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder={slugPlaceholder}
            className="h-9 font-mono"
            autoFocus={autoFocusSlug}
            data-component-id={fieldId('slug')}
          />
        </div>
      </div>

      <div>
        <Eyebrow asChild><label className="mb-2 block" htmlFor={fieldId('title')}>Title</label></Eyebrow>
        <Input id={fieldId('title')} value={title} onChange={(event) => onTitleChange(event.target.value)} placeholder={titlePlaceholder} maxLength={120} className="h-9" data-component-id={fieldId('title')} />
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <Eyebrow asChild><label className="mb-2 block" htmlFor={fieldId('description')}>Description</label></Eyebrow>
          <Metric className={descriptionOverLimit ? 'text-destructive' : undefined}>{description.length}/250</Metric>
        </div>
        <Textarea id={fieldId('description')} value={description} onChange={(event) => onDescriptionChange(event.target.value)} placeholder={descriptionPlaceholder} rows={3} className="min-h-16 max-h-40 resize-y text-xs" aria-invalid={descriptionOverLimit} data-component-id={fieldId('description')} />
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <Eyebrow asChild><label className="mb-2 block" htmlFor={fieldId('readme')}>Information</label></Eyebrow>
          <Metric>{readme.length}/8000</Metric>
        </div>
        <Textarea id={fieldId('readme')} value={readme} onChange={(event) => onReadmeChange(event.target.value.slice(0, 8000))} placeholder={readmePlaceholder} rows={4} className="min-h-20 max-h-56 resize-y text-xs" data-component-id={fieldId('readme')} />
        <Hint className="mt-1.5">Shown on the pack page. Optional.</Hint>
      </div>

      <div>
        <Eyebrow asChild><label className="mb-2 block" htmlFor={fieldId('license')}>License</label></Eyebrow>
        <SettingsSelect id={fieldId('license')} value={license} onChange={onLicenseChange} className="h-9 w-full text-sm">
          {ERRATANET_LICENSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </SettingsSelect>
      </div>

      <div>
        <Eyebrow asChild><label className="mb-2 block" htmlFor={fieldId('tags')}>Tags</label></Eyebrow>
        {tags.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1 text-xs">
                {tag}
                <button type="button" onClick={() => onTagsChange(tags.filter((candidate) => candidate !== tag))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${tag}`}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Input id={fieldId('tags')} value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addTag() } }} onBlur={addTag} placeholder="Add a tag and press Enter" className="h-9" data-component-id={fieldId('tags')} />
      </div>
    </>
  )
}

export function ErratanetReleaseFields({
  visibility,
  onVisibilityChange,
  bump,
  onBumpChange,
  nextVersion,
  latestVersion,
  checkingVersion,
  newLabel,
}: {
  visibility: ErratanetVisibility
  onVisibilityChange: (value: ErratanetVisibility) => void
  bump: BumpKind
  onBumpChange: (value: BumpKind) => void
  nextVersion: string
  latestVersion: string | null
  checkingVersion?: boolean
  newLabel: string
}) {
  return (
    <>
      <div>
        <Eyebrow asChild><h4 className="mb-2">Visibility</h4></Eyebrow>
        <SegmentedControl value={visibility} options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }]} onChange={onVisibilityChange} />
        <Hint className="mt-1.5">{visibility === 'public' ? 'Listed in search and explore.' : 'Hidden from search. Only people with the link can find it.'}</Hint>
      </div>

      <div>
        <Eyebrow asChild><h4 className="mb-2">Version</h4></Eyebrow>
        <div className="flex items-center gap-3">
          <SegmentedControl value={bump} options={[{ value: 'patch', label: 'Patch' }, { value: 'minor', label: 'Minor' }, { value: 'major', label: 'Major' }]} onChange={onBumpChange} />
          <span className="font-mono text-sm tabular-nums">{nextVersion}</span>
          {checkingVersion && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <Hint className="mt-1.5">{latestVersion ? `Latest published: ${latestVersion}` : newLabel}</Hint>
      </div>
    </>
  )
}
