import { useMemo } from 'react'
import { Trash2 } from 'lucide-react'
import type { Fragment, FragmentVersion } from '@/lib/api'
import { diffRows } from '@/lib/diff'
import { cn } from '@/lib/utils'
import { DiffRowsView } from '@/components/DiffRowsView'
import { Button } from '@/components/ui/button'
import { Eyebrow, Hint, MetaLabel } from '@/components/ui/prose-text'
import { describeVersionReason } from './fragment-version-label'

interface FragmentVersionHistoryProps {
  fragment: Fragment
  content: string
  versions: FragmentVersion[]
  preview: FragmentVersion | null
  switching: boolean
  deleting: boolean
  onPreview: (version: FragmentVersion | null) => void
  onSwitch: (version: number) => void
  onDelete: (version: number) => void
}

export function FragmentVersionHistory({
  fragment,
  content,
  versions,
  preview,
  switching,
  deleting,
  onPreview,
  onSwitch,
  onDelete,
}: FragmentVersionHistoryProps) {
  const diff = useMemo(() => preview ? diffRows(content, preview.content) : [], [content, preview])

  return (
    <section className="space-y-2 px-6 py-4">
      <div className="flex items-center justify-between">
        <Eyebrow>Version history</Eyebrow>
        <MetaLabel>Current v{fragment.version ?? 1}</MetaLabel>
      </div>
      {versions.length === 0 ? (
        <Hint>No version history yet.</Hint>
      ) : (
        <div className="max-h-36 space-y-1.5 overflow-auto pr-1">
          {versions.map((version) => {
            const current = version.version === (fragment.version ?? 1)
            const reason = describeVersionReason(version.reason, version.version === versions[0]?.version)
            return (
              <div
                key={version.version}
                className={cn(
                  'flex items-center justify-between rounded-md border px-2 py-1.5',
                  current ? 'border-primary/40 bg-primary/5' : 'border-border/40',
                )}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    v{version.version}
                    {current && <span className="text-ui-label uppercase tracking-wide text-primary/80">current</span>}
                  </p>
                  <MetaLabel asChild>
                    <p className="truncate" title={version.reason}>
                      {new Date(version.createdAt).toLocaleString()}{reason ? ` · ${reason}` : ''}
                    </p>
                  </MetaLabel>
                </div>
                <div className="flex items-center gap-1">
                  <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={() => onPreview(version)}>Preview</Button>
                  <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={() => onSwitch(version.version)} disabled={switching || current}>Switch</Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(version.version)}
                    disabled={deleting || current}
                    title={current ? 'Switch to another version before deleting this one' : 'Delete this version'}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {preview && (
        <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">Diff preview for v{preview.version}</p>
            <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={() => onPreview(null)}>Close</Button>
          </div>
          <Hint>`-` current content, `+` selected version; `~` edited lines show word-level changes.</Hint>
          <pre className="max-h-40 overflow-auto rounded border border-border/30 bg-background/50 p-2 text-ui-caption leading-4">
            {diff.length === 0 ? 'No content differences.' : <DiffRowsView rows={diff} />}
          </pre>
        </div>
      )}
    </section>
  )
}
