import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Fragment } from '@/lib/api'
import { q, useActiveBranchId } from '@/lib/query-keys'
import type { PackManifestDraft } from '@/lib/erratanet/pack-schema'
import { GLOBAL_PACK_ID_REGEX } from '@/lib/erratanet/pack-schema'
import { slugify, bumpVersion, type BumpKind } from '@/lib/erratanet/publish-utils'
import { serializeBundle } from '@/lib/fragment-clipboard'
import { parseVisualRefs } from '@/lib/fragment-visuals'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/settings/primitives'
import { Eyebrow, Hint } from '@/components/ui/prose-text'
import {
  ERRATANET_LICENSES,
  ErratanetAccountNotice,
  ErratanetIdentityFields,
  ErratanetPublishSuccess,
  ErratanetReleaseFields,
  useErratanetPackLookup,
} from './ErratanetPublishFields'
import {
  UploadCloud,
  Loader2,
  Image as ImageIcon,
} from 'lucide-react'

interface PublishPackDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 'fragments' publishes the selection; 'story' publishes the whole story. */
  mode?: 'fragments' | 'story'
  /** Required for story mode: the story to publish whole. */
  storyId?: string
  /** Pre-fill the slug (used by "sync" to re-publish to the same pack). */
  defaultSlug?: string
  /** The guideline / character / knowledge fragments to publish. */
  selectedFragments: Fragment[]
  /** Image + icon fragments by id, for resolving attachments and thumbnails. */
  mediaById: Map<string, Fragment>
  storyName?: string
}

type ContentRating = 'general' | 'mature' | 'r18'

const CONTENT_RATINGS: { value: ContentRating; label: string; hint: string }[] = [
  { value: 'general', label: 'General', hint: 'Suitable for everyone.' },
  { value: 'mature', label: 'Mature', hint: 'Mature themes; not explicit.' },
  { value: 'r18', label: 'R18', hint: 'Explicit adult content. Marked NSFW.' },
]

export function PublishPackDialog({
  open,
  onOpenChange,
  mode = 'fragments',
  storyId,
  defaultSlug,
  selectedFragments,
  mediaById,
  storyName,
}: PublishPackDialogProps) {
  const isStory = mode === 'story'
  const qc = useQueryClient()
  const branchId = useActiveBranchId(storyId)
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [readme, setReadme] = useState('')
  const [license, setLicense] = useState<string>(ERRATANET_LICENSES[1].value)
  const [tags, setTags] = useState<string[]>([])
  const [contentRating, setContentRating] = useState<ContentRating>('general')
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public')
  const [bump, setBump] = useState<BumpKind>('patch')
  const [thumbnailId, setThumbnailId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [publishedId, setPublishedId] = useState<string | null>(null)

  // Resolve the signed-in handle. New packs need it to form the @handle/slug id.
  const { data: account } = useQuery({
    queryKey: ['erratanet-account'],
    queryFn: () => api.erratanet.getAccount(),
    enabled: open,
  })
  // The configured hub, used to build a hotlink to the published pack's page.
  const { data: config } = useQuery({
    queryKey: ['erratanet-config'],
    queryFn: () => api.erratanet.getConfig(),
    enabled: open,
  })
  const handle = account?.handle ?? null
  // The slug falls back to one derived from the title, so an empty slug still
  // yields a name.
  const derivedSlug = slugify(title)
  const effectiveSlug = slug.trim() || derivedSlug
  const packId = handle && effectiveSlug ? `@${handle}/${effectiveSlug}` : null

  // Look up the latest published version of this pack (404 -> brand new pack).
  const { data: existingPack, isFetching: checkingPack } = useErratanetPackLookup(packId, open)
  const latestVersion = existingPack?.version ?? null
  const nextVersion = useMemo(() => bumpVersion(latestVersion, bump), [latestVersion, bump])

  // Image fragments referenced by the selected fragments — thumbnail candidates.
  const thumbnailCandidates = useMemo(() => {
    const seen = new Set<string>()
    const out: Fragment[] = []
    for (const fragment of selectedFragments) {
      for (const ref of parseVisualRefs(fragment.meta)) {
        if (ref.kind !== 'image' || seen.has(ref.fragmentId)) continue
        const media = mediaById.get(ref.fragmentId)
        if (media) {
          seen.add(ref.fragmentId)
          out.push(media)
        }
      }
    }
    return out
  }, [selectedFragments, mediaById])

  // Chapters, story mode only. Walk the active prose chain (the reading order)
  // and emit a chapter for every marker it passes, so the list matches what a
  // reader sees, in order, and excludes markers no longer in the chain.
  const { data: markerFragments } = useQuery({
    ...q.fragments(storyId, branchId, 'marker'),
    enabled: open && isStory && !!storyId,
  })
  const { data: chain } = useQuery({
    ...q.proseChain(storyId, branchId),
    enabled: open && isStory && !!storyId,
  })
  const chapters = useMemo(() => {
    const markerById = new Map((markerFragments ?? []).map((m) => [m.id, m]))
    const result: { title: string; order: number }[] = []
    for (const entry of chain?.entries ?? []) {
      const marker = markerById.get(entry.active)
      if (marker) result.push({ title: marker.name, order: result.length })
    }
    return result
  }, [chain, markerFragments])

  // Reset transient state whenever the dialog opens. A defaultSlug (sync)
  // pre-fills the pack to re-publish to.
  const seededRef = useRef(false)
  useEffect(() => {
    if (open) {
      setError(null)
      setPublishedId(null)
      setReadme('')
      setContentRating('general')
      seededRef.current = false
      if (defaultSlug) setSlug(defaultSlug)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Default the title from the story name once, when empty.
  useEffect(() => {
    if (open && !title && storyName) setTitle(storyName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // When updating an existing pack (sync, or re-publishing the same slug),
  // pre-fill the metadata from its latest published manifest so the update
  // preserves tags, description, license, rating, and readme. Runs once per open.
  useEffect(() => {
    if (!open || seededRef.current) return
    const manifest = (existingPack as { manifest?: Record<string, unknown> } | null | undefined)?.manifest
    if (!manifest) return
    seededRef.current = true
    if (Array.isArray(manifest.tags)) {
      setTags(manifest.tags.filter((t): t is string => typeof t === 'string'))
    }
    if (typeof manifest.description === 'string' && manifest.description) setDescription(manifest.description)
    if (typeof manifest.license === 'string' && manifest.license) setLicense(manifest.license)
    if (typeof manifest.readme === 'string') setReadme(manifest.readme)
    if (manifest.contentRating === 'general' || manifest.contentRating === 'mature' || manifest.contentRating === 'r18') {
      setContentRating(manifest.contentRating)
    } else if (manifest.nsfw === true) {
      setContentRating('r18')
    }
    if (typeof manifest.title === 'string' && manifest.title) setTitle(manifest.title)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingPack])

  const publishMut = useMutation({
    mutationFn: async () => {
      if (!handle) throw new Error('Connect a hub account in Settings first.')
      const cleanSlug = slug.trim() || slugify(title)
      if (!cleanSlug) throw new Error('Enter a title or a slug for the pack.')
      const id = `@${handle}/${cleanSlug}`
      if (!GLOBAL_PACK_ID_REGEX.test(id)) {
        throw new Error('Slug must be lowercase letters, numbers, and dashes.')
      }
      if (!title.trim()) throw new Error('Enter a title.')
      if (description.length > 250) throw new Error('Description must be 250 characters or fewer.')

      const thumbnailFragment = thumbnailId ? mediaById.get(thumbnailId) : undefined
      const trimmedReadme = readme.trim()

      // Fields shared by both content kinds. Everything the build can work out
      // from the payload — content kind, fragment facets, the payload hash — is
      // the server's to fill in and absent from the draft.
      const base: PackManifestDraft = {
        id,
        version: nextVersion,
        title: title.trim(),
        description: description.trim(),
        license,
        tags,
        // R18 implies NSFW; general / mature are not flagged (mature is a soft label).
        nsfw: contentRating === 'r18',
        contentRating,
        ...(trimmedReadme ? { readme: trimmedReadme } : {}),
        ...(thumbnailFragment ? { thumbnail: thumbnailFragment.content } : {}),
        ...(handle ? { publisher: `@${handle}` } : {}),
      }

      if (isStory) {
        if (!storyId) throw new Error('No story to publish.')
        const manifest: PackManifestDraft = {
          ...base,
          ...(chapters.length > 0 ? { chapters } : {}),
        }
        return api.erratanet.publish({ storyId, manifest, unlisted: visibility === 'unlisted' })
      }

      if (selectedFragments.length === 0) throw new Error('Select at least one fragment to publish.')
      const bundleJson = serializeBundle(selectedFragments, mediaById, storyName)
      return api.erratanet.publish({
        bundleJson,
        manifest: base,
        unlisted: visibility === 'unlisted',
        // Tie the pack to this story so the sidebar can track + re-sync it.
        ...(storyId ? { storyId, fragmentIds: selectedFragments.map((f) => f.id) } : {}),
      })
    },
    onSuccess: (res) => {
      setPublishedId(res.id)
      setError(null)
      // A story publish stamps provenance server-side; refresh so the sidebar
      // picks up the new "published as" state.
      if (storyId) {
        qc.invalidateQueries({ queryKey: ['story', storyId] })
        qc.invalidateQueries({ queryKey: ['stories'] })
      }
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : 'Publish failed.')
    },
  })

  const descOver = description.length > 250
  const canPublish =
    !!handle &&
    !!effectiveSlug &&
    !!title.trim() &&
    !descOver &&
    (isStory || selectedFragments.length > 0) &&
    !publishMut.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[88vh] flex flex-col overflow-hidden" data-component-id="publish-pack-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-lg flex items-center gap-2">
            <UploadCloud className="size-4 text-muted-foreground" />
            Publish to ErrataNet
          </DialogTitle>
          <DialogDescription>
            {isStory
              ? 'Publish this whole story: branches, prose chain, and fragments.'
              : `Share ${selectedFragments.length} fragment${selectedFragments.length !== 1 ? 's' : ''} as a reusable pack.`}
          </DialogDescription>
        </DialogHeader>

        {publishedId ? (
          <ErratanetPublishSuccess verb="Published" id={publishedId} version={nextVersion} hubUrl={config?.hubUrl} />
        ) : (
          <div className="flex-1 overflow-y-auto space-y-5 py-1 pr-1">
            {!handle && <ErratanetAccountNotice action="publishing" />}

            <ErratanetIdentityFields
              fieldPrefix="publish-pack"
              handle={handle}
              slug={slug}
              slugPlaceholder={derivedSlug || 'cozy-fantasy-starter'}
              onSlugChange={setSlug}
              title={title}
              titlePlaceholder="Cozy Fantasy Starter"
              onTitleChange={setTitle}
              description={description}
              descriptionPlaceholder="A short summary of what this pack contains…"
              onDescriptionChange={setDescription}
              readme={readme}
              readmePlaceholder="Long-form notes, setup, credits… Markdown is supported."
              onReadmeChange={setReadme}
              license={license}
              onLicenseChange={setLicense}
              tags={tags}
              onTagsChange={setTags}
              autoFocusSlug
            />

            {/* Chapters (story mode, derived from markers) */}
            {isStory && chapters.length > 0 && (
              <div>
                <Eyebrow asChild><h4 className="mb-2">Chapters ({chapters.length})</h4></Eyebrow>
                <ol className="max-h-28 overflow-y-auto rounded-md border border-border/40 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                  {chapters.map((ch, i) => (
                    <li key={i} className="flex gap-2 py-0.5">
                      <span className="tabular-nums text-muted-foreground/60">{i + 1}.</span>
                      <span className="truncate text-foreground/80">{ch.title}</span>
                    </li>
                  ))}
                </ol>
                <Hint className="mt-1.5">
                  Derived from chapter markers. Shown on the pack page.
                </Hint>
              </div>
            )}

            {/* Thumbnail */}
            {thumbnailCandidates.length > 0 && (
              <div>
                <Eyebrow asChild><h4 className="mb-2">Thumbnail</h4></Eyebrow>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setThumbnailId(null)}
                    className={cn(
                      'grid size-14 place-items-center rounded-md border text-muted-foreground transition-colors',
                      thumbnailId === null ? 'border-primary/40 bg-primary/5 text-foreground' : 'border-border/40 hover:border-border',
                    )}
                    aria-label="No thumbnail"
                  >
                    <ImageIcon className="size-4" />
                  </button>
                  {thumbnailCandidates.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => setThumbnailId(img.id)}
                      className={cn(
                        'size-14 overflow-hidden rounded-md border transition-colors',
                        thumbnailId === img.id ? 'border-primary/60 ring-2 ring-primary/30' : 'border-border/40 hover:border-border',
                      )}
                      title={img.name}
                    >
                      <img src={img.content} alt={img.name} className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Content rating */}
            <div>
              <Eyebrow asChild><h4 className="mb-2">Content rating</h4></Eyebrow>
              <SegmentedControl value={contentRating} options={CONTENT_RATINGS} onChange={setContentRating} />
              <Hint className="mt-1.5">
                {CONTENT_RATINGS.find((r) => r.value === contentRating)?.hint}
              </Hint>
            </div>

            <ErratanetReleaseFields
              visibility={visibility}
              onVisibilityChange={setVisibility}
              bump={bump}
              onBumpChange={setBump}
              nextVersion={nextVersion}
              latestVersion={latestVersion}
              checkingVersion={checkingPack}
              newLabel="New pack, starting at 1.0.0"
            />

            {/* MVP note */}
            <Hint className="leading-snug">
              {isStory
                ? 'The whole story is published: branches, prose chain, fragments, and images. Context blocks and agent configuration are not included.'
                : 'Packs carry fragments and their images only. Context blocks and agent configuration are not included.'}
            </Hint>

            {error && <Hint className="text-destructive">{error}</Hint>}
          </div>
        )}

        <DialogFooter className="gap-2 pt-3 border-t border-border/30">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-xs">
            {publishedId ? 'Done' : 'Cancel'}
          </Button>
          {!publishedId && (
            <Button
              onClick={() => publishMut.mutate()}
              disabled={!canPublish}
              className="text-xs gap-1.5"
              data-component-id="publish-pack-submit"
            >
              {publishMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />}
              Publish {nextVersion}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
