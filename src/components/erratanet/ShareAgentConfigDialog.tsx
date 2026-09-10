import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { PackManifestDraft } from '@/lib/erratanet/pack-schema'
import { GLOBAL_PACK_ID_REGEX } from '@/lib/erratanet/pack-schema'
import { slugify, bumpVersion, type BumpKind } from '@/lib/erratanet/publish-utils'
import type { AgentConfigSnapshotResponse } from '@/lib/api/types'
import {
  AgentConfigSelector,
  fullSelection,
  restrictToSurfaces,
  toSelectionPayload,
  selectionIsEmpty,
  selectedScripts,
  type AgentConfigSelectionState,
} from './AgentConfigSelector'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
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
  Code2,
} from 'lucide-react'

interface ShareAgentConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  storyId: string
  storyName?: string
  /** Pre-fill the slug to re-publish (sync) an already-shared config. */
  defaultSlug?: string
  /** Pre-select the surfaces a synced config previously bundled. */
  defaultIncludes?: string[]
}

/**
 * Publish the current story's agent configuration as a shareable `agent-config`
 * pack. The user picks which surfaces to include; a scripts notice appears when
 * any bundled block is executable (the pack is then flagged "runs code", and
 * importers must review + consent before it applies).
 */
export function ShareAgentConfigDialog({ open, onOpenChange, storyId, storyName, defaultSlug, defaultIncludes }: ShareAgentConfigDialogProps) {
  const qc = useQueryClient()
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [readme, setReadme] = useState('')
  const [license, setLicense] = useState<string>(ERRATANET_LICENSES[1].value)
  const [tags, setTags] = useState<string[]>([])
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public')
  const [bump, setBump] = useState<BumpKind>('patch')
  const [selection, setSelection] = useState<AgentConfigSelectionState>({
    agents: {},
    providers: [],
    modelRoles: [],
  })
  const [error, setError] = useState<string | null>(null)
  const [publishedId, setPublishedId] = useState<string | null>(null)
  const [publishedVersion, setPublishedVersion] = useState<string | null>(null)

  const { data: account } = useQuery({
    queryKey: ['erratanet-account'],
    queryFn: () => api.erratanet.getAccount(),
    enabled: open,
  })
  const { data: config } = useQuery({
    queryKey: ['erratanet-config'],
    queryFn: () => api.erratanet.getConfig(),
    enabled: open,
  })

  // Snapshot the story's config so we can show what's available + a preview.
  const { data: snapshot, isLoading: loadingSnapshot } = useQuery<AgentConfigSnapshotResponse>({
    queryKey: ['agent-config-snapshot', storyId],
    queryFn: () => api.erratanet.agentConfig.snapshot(storyId),
    enabled: open,
  })

  const handle = account?.handle ?? null
  const available = snapshot?.summary.includes ?? []
  const effectiveSlug = slug.trim() || slugify(title)
  const packId = handle && effectiveSlug ? `@${handle}/${effectiveSlug}` : null
  // Debounced: the slug derives from the live title input, and each new packId
  // is a fresh queryKey — without trailing it, every keystroke hits the hub.
  const { data: existingPack, lookupPackId: debouncedPackId } = useErratanetPackLookup(packId, open)
  const latestVersion = existingPack?.version ?? null
  const nextVersion = useMemo(() => bumpVersion(latestVersion, bump), [latestVersion, bump])

  // Reset on open. A defaultSlug means "sync": seed the slug to re-publish the
  // same pack; its metadata is seeded from the published manifest below.
  const seededRef = useRef(false)
  const selectionSeededRef = useRef(false)
  useEffect(() => {
    if (!open) return
    setError(null)
    setPublishedId(null)
    setPublishedVersion(null)
    setSlug(defaultSlug ?? '')
    setTitle(defaultSlug ? '' : storyName ? `${storyName} setup` : '')
    setDescription('')
    setReadme('')
    setTags([])
    setLicense(ERRATANET_LICENSES[1].value)
    seededRef.current = false
    selectionSeededRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Default the selection: a synced config restores the surfaces it bundled
  // before; a new share selects everything. Individual blocks can be unpicked.
  // Seeded once per open — the snapshot refetches on window focus (its
  // exportedAt stamp defeats structural sharing), and re-seeding would silently
  // discard the user's deselections right before they publish.
  useEffect(() => {
    if (!open || !snapshot || selectionSeededRef.current) return
    selectionSeededRef.current = true
    const full = fullSelection(snapshot.preview)
    setSelection(defaultIncludes && defaultIncludes.length > 0 ? restrictToSurfaces(full, defaultIncludes) : full)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, snapshot, defaultIncludes])

  // On sync, seed metadata from the existing pack's manifest so the update keeps
  // its title, description, tags, license, and readme. Once per open.
  useEffect(() => {
    if (!open || seededRef.current) return
    const manifest = (existingPack as { manifest?: Record<string, unknown> } | null | undefined)?.manifest
    if (!manifest) return
    seededRef.current = true
    if (Array.isArray(manifest.tags)) setTags(manifest.tags.filter((t): t is string => typeof t === 'string'))
    if (typeof manifest.description === 'string' && manifest.description) setDescription(manifest.description)
    if (typeof manifest.license === 'string' && manifest.license) setLicense(manifest.license)
    if (typeof manifest.readme === 'string') setReadme(manifest.readme)
    if (typeof manifest.title === 'string' && manifest.title) setTitle(manifest.title)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingPack])

  // Does the current selection still carry scripts? Only selected script blocks
  // count, so unpicking them drops the "runs code" flag.
  const willHaveScripts = snapshot ? selectedScripts(selection, snapshot.preview).length > 0 : false

  const publishMut = useMutation({
    mutationFn: async () => {
      if (!handle) throw new Error('Connect a hub account in Settings first.')
      const cleanSlug = slug.trim() || slugify(title)
      const id = `@${handle}/${cleanSlug}`
      if (!GLOBAL_PACK_ID_REGEX.test(id)) throw new Error('Slug must be lowercase letters, numbers, and dashes.')
      if (!title.trim()) throw new Error('Enter a title.')
      if (description.length > 250) throw new Error('Description must be 250 characters or fewer.')
      if (selectionIsEmpty(selection)) throw new Error('Select at least one part of the configuration.')

      // The server derives contentKind, capabilities, the agentConfig summary,
      // fragment fields, and the payload hash from the snapshot.
      const manifest: PackManifestDraft = {
        id,
        version: nextVersion,
        title: title.trim(),
        description: description.trim(),
        license,
        tags,
        nsfw: false,
        ...(readme.trim() ? { readme: readme.trim() } : {}),
        publisher: `@${handle}`,
      }
      return api.erratanet.agentConfig.publish({
        storyId,
        selection: toSelectionPayload(selection),
        manifest,
        unlisted: visibility === 'unlisted',
      })
    },
    onSuccess: (res) => {
      setPublishedId(res.id)
      setPublishedVersion(res.version)
      setError(null)
      qc.invalidateQueries({ queryKey: ['erratanet-pack', debouncedPackId] })
      // The publish stamps provenance on the story; refresh so the panel's
      // "Shared configs" list (and its sync button) picks up the new version.
      qc.invalidateQueries({ queryKey: ['story', storyId] })
      qc.invalidateQueries({ queryKey: ['stories'] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Publish failed.'),
  })

  const descOver = description.length > 250
  const nothingToShare = !loadingSnapshot && available.length === 0
  const canPublish =
    !!handle && !!effectiveSlug && !!title.trim() && !descOver && !selectionIsEmpty(selection) && !publishMut.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[88vh] flex flex-col overflow-hidden" data-component-id="share-agent-config-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-lg flex items-center gap-2">
            <UploadCloud className="size-4 text-muted-foreground" />
            Share agent configuration
          </DialogTitle>
          <DialogDescription>
            Publish how you&apos;ve tuned this story&apos;s agents as a config others can adopt.
          </DialogDescription>
        </DialogHeader>

        {publishedId ? (
          <ErratanetPublishSuccess verb="Shared" id={publishedId} version={publishedVersion} hubUrl={config?.hubUrl} />
        ) : (
          <div className="flex-1 overflow-y-auto space-y-5 py-1 pr-1">
            {!handle && <ErratanetAccountNotice action="sharing" />}

            {/* What to include — down to individual agents and blocks. */}
            <div>
              <Eyebrow asChild><h4 className="mb-2">Include</h4></Eyebrow>
              {loadingSnapshot ? (
                <Hint className="flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" /> Reading this story&apos;s config…
                </Hint>
              ) : nothingToShare || !snapshot ? (
                <Hint>
                  This story has no custom agent configuration yet. Tune some blocks, instructions, or
                  model assignments first.
                </Hint>
              ) : (
                <AgentConfigSelector preview={snapshot.preview} value={selection} onChange={setSelection} />
              )}
            </div>

            {/* Scripts notice */}
            {willHaveScripts && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="flex items-center gap-2 text-ui-body font-medium text-foreground">
                  <Code2 className="size-4 text-amber-500" />
                  This config runs code
                </p>
                <Hint className="mt-1 leading-snug">
                  It includes executable script blocks. The pack will be flagged &ldquo;runs code&rdquo;, and
                  importers must review the script source and confirm before it applies.
                </Hint>
              </div>
            )}

            <ErratanetIdentityFields
              fieldPrefix="share-config"
              handle={handle}
              slug={slug}
              slugPlaceholder={slugify(title) || 'cozy-writer'}
              onSlugChange={setSlug}
              title={title}
              titlePlaceholder="Cozy Writer"
              onTitleChange={setTitle}
              description={description}
              descriptionPlaceholder="What this configuration is good for…"
              onDescriptionChange={setDescription}
              readme={readme}
              readmePlaceholder="Setup notes, what it pairs well with, credits… Markdown supported."
              onReadmeChange={setReadme}
              license={license}
              onLicenseChange={setLicense}
              tags={tags}
              onTagsChange={setTags}
            />

            <ErratanetReleaseFields
              visibility={visibility}
              onVisibilityChange={setVisibility}
              bump={bump}
              onBumpChange={setBump}
              nextVersion={nextVersion}
              latestVersion={latestVersion}
              newLabel="New config, starting at 1.0.0"
            />

            <Hint className="leading-snug">
              API keys are never shared. Provider shape carries only the provider name, base URL, and model.
            </Hint>

            {error && <Hint className="text-destructive">{error}</Hint>}
          </div>
        )}

        <DialogFooter className="gap-2 pt-3 border-t border-border/30">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-xs">
            {publishedId ? 'Done' : 'Cancel'}
          </Button>
          {!publishedId && (
            <Button onClick={() => publishMut.mutate()} disabled={!canPublish} className="text-xs gap-1.5" data-component-id="share-config-submit">
              {publishMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />}
              Share {nextVersion}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
