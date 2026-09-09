import { useCallback, useMemo, useRef, useState } from 'react'
import { ImagePlus, Snowflake, Upload } from 'lucide-react'
import type { FrozenSection } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Eyebrow, Hint, Metric } from '@/components/ui/prose-text'

interface FragmentMediaFieldProps {
  type: 'image' | 'icon'
  name: string
  value: string
  previewUrl: string | null
  editable: boolean
  onChange: (value: string) => void
}

async function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  })
}

export function FragmentMediaField({
  type,
  name,
  value,
  previewUrl,
  editable,
  onChange,
}: FragmentMediaFieldProps) {
  const [error, setError] = useState<string | null>(null)

  const upload = async (file: File) => {
    try {
      setError(null)
      onChange(await readImageFile(file))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not upload image')
    }
  }

  const fileInput = (
    <input
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.[0]
        if (file) void upload(file)
      }}
    />
  )

  return (
    <section>
      <Eyebrow asChild><label>{type === 'icon' ? 'Icon' : 'Image'}</label></Eyebrow>
      {previewUrl ? (
        <div className="mt-2 space-y-2">
          <div className="overflow-hidden rounded-lg border border-border/40 bg-muted/20">
            <img src={previewUrl} alt={name || 'Preview'} className="max-h-64 w-full object-contain" />
          </div>
          {editable && (
            <>
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50">
                  <Upload className="size-3" />Replace{fileInput}
                </label>
                <Hint>or paste a URL below</Hint>
              </div>
              <Input
                value={value.startsWith('data:') ? '' : value}
                onChange={(event) => onChange(event.target.value)}
                placeholder="https://example.com/image.png"
                className="h-7 bg-transparent font-mono text-xs"
              />
            </>
          )}
        </div>
      ) : (
        <>
          <label
            className={cn(
              'mt-2 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border/50 py-12 transition-colors',
              editable && 'cursor-pointer hover:border-primary/40 hover:bg-accent/30',
            )}
            onDragOver={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const file = event.dataTransfer.files[0]
              if (editable && file?.type.startsWith('image/')) void upload(file)
            }}
          >
            <ImagePlus className="size-8 text-muted-foreground" />
            <div className="text-center">
              <Hint size="sm">{editable ? 'Drop an image here or click to upload' : 'No image set'}</Hint>
              <Hint className="mt-1">PNG, JPG, SVG, or paste a URL</Hint>
            </div>
            {editable && fileInput}
          </label>
          {editable && (
            <Input
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder="https://example.com/image.png"
              className="mt-2 h-7 bg-transparent font-mono text-xs"
            />
          )}
        </>
      )}
      {error && <Hint className="mt-1 text-destructive">{error}</Hint>}
    </section>
  )
}

export type ContentSegment =
  | { type: 'editable'; text: string }
  | { type: 'frozen'; text: string; id: string }

export function segmentFrozenContent(content: string, frozenSections: FrozenSection[]): ContentSegment[] | null {
  const matches = frozenSections
    .map((section) => {
      const start = content.indexOf(section.text)
      return start === -1 ? null : { start, end: start + section.text.length, ...section }
    })
    .filter((match): match is { start: number; end: number; id: string; text: string } => match !== null)
    .sort((a, b) => a.start - b.start)

  if (matches.length === 0) return null

  const nonOverlapping: typeof matches = []
  let lastEnd = 0
  for (const match of matches) {
    if (match.start < lastEnd) continue
    nonOverlapping.push(match)
    lastEnd = match.end
  }
  const segments: ContentSegment[] = []
  let position = 0
  for (const match of nonOverlapping) {
    segments.push({ type: 'editable', text: content.slice(position, match.start) })
    segments.push({ type: 'frozen', text: match.text, id: match.id })
    position = match.end
  }
  segments.push({ type: 'editable', text: content.slice(position) })
  return segments
}

interface FragmentTextFieldProps {
  content: string
  frozenSections: FrozenSection[]
  editable: boolean
  canFreeze: boolean
  mutationPending: boolean
  onChange: (value: string) => void
  onFreeze: (text: string) => void
  onUnfreeze: (sectionId: string) => void
}

export function FragmentTextField({
  content,
  frozenSections,
  editable,
  canFreeze,
  mutationPending,
  onChange,
  onFreeze,
  onUnfreeze,
}: FragmentTextFieldProps) {
  const [selection, setSelection] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const segments = useMemo(() => segmentFrozenContent(content, frozenSections), [content, frozenSections])
  const orphaned = useMemo(
    () => frozenSections.filter((section) => !content.includes(section.text)),
    [content, frozenSections],
  )
  const recordSelection = (textarea: HTMLTextAreaElement) => {
    setSelection(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd))
  }
  const resize = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return
    textarea.style.height = '0'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [])
  const changeSegment = (segmentIndex: number, text: string) => {
    if (!segments) return
    onChange(segments.map((segment, index) => index === segmentIndex ? text : segment.text).join(''))
  }

  return (
    <section>
      <Eyebrow asChild><label>Content</label></Eyebrow>
      <div className="mt-2">
        {segments ? (
          <div className="min-h-[200px] overflow-hidden rounded-md border border-input focus-within:ring-1 focus-within:ring-ring">
            {segments.map((segment, index) => segment.type === 'editable' ? (
              <textarea
                key={`segment-${index}`}
                ref={resize}
                value={segment.text}
                onChange={(event) => {
                  changeSegment(index, event.target.value)
                  resize(event.target)
                }}
                onSelect={(event) => recordSelection(event.currentTarget)}
                disabled={!editable}
                rows={Math.max(1, segment.text.split('\n').length)}
                className="block w-full resize-none border-none bg-transparent px-3 py-1.5 font-mono text-sm leading-relaxed outline-none focus:ring-0 focus-visible:ring-0"
              />
            ) : (
              <div key={segment.id} className="group relative bg-sky-500/[0.06] dark:bg-sky-400/[0.06]">
                <div className="absolute inset-y-0 left-0 w-0.5 bg-sky-500/40" />
                <div className="flex items-start gap-2 py-1.5 pl-3 pr-2">
                  <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground/80">{segment.text}</pre>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onUnfreeze(segment.id)}
                        disabled={mutationPending}
                        className="mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-ui-label text-sky-600/70 opacity-0 transition-all hover:bg-sky-500/10 hover:text-sky-700 group-hover:opacity-100 dark:text-sky-400/60 dark:hover:text-sky-300"
                      >
                        <Snowflake className="size-2.5" />Unfreeze
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Remove freeze protection</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(event) => onChange(event.target.value)}
            onSelect={(event) => recordSelection(event.currentTarget)}
            disabled={!editable}
            className="min-h-[40vh] resize-none bg-transparent font-mono text-sm leading-relaxed"
            required
          />
        )}
      </div>

      <div className="mt-1.5 flex items-center justify-between">
        {canFreeze ? (
          <button
            type="button"
            onClick={() => onFreeze(selection)}
            disabled={!selection.trim() || mutationPending}
            className={cn(
              'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-ui-caption transition-all',
              selection.trim()
                ? 'cursor-pointer border border-sky-500/25 bg-sky-500/10 text-sky-600 hover:bg-sky-500/20 dark:text-sky-400'
                : 'cursor-default text-muted-foreground/50',
            )}
          >
            <Snowflake className="size-3" />
            {selection.trim() ? 'Freeze selected text' : 'Select text to freeze'}
          </button>
        ) : <span />}
        <div className="flex gap-3">
          <Metric>{content.trim() ? content.trim().split(/\s+/).length : 0} words</Metric>
          <Metric>{content.length} chars</Metric>
        </div>
      </div>

      {orphaned.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Hint className="text-amber-600 dark:text-amber-400/70">Orphaned:</Hint>
          {orphaned.map((section) => (
            <span key={section.id} className="inline-flex h-5 items-center gap-1 rounded border border-amber-500/20 bg-amber-500/[0.05] px-1.5 text-ui-label text-amber-700 dark:text-amber-400/60">
              <span className="max-w-[120px] truncate">{section.text}</span>
              <button type="button" onClick={() => onUnfreeze(section.id)} className="transition-colors hover:text-destructive" aria-label={`Unfreeze ${section.text}`}>&times;</button>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
