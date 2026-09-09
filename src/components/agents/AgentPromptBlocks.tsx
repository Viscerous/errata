import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Code2, FileText, GripVertical, Plus, Trash2 } from 'lucide-react'
import type { BlockOverride, CustomBlockDefinition } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { BlockCreateDialog } from '@/components/blocks/BlockCreateDialog'
import { FragmentReference, ScriptBlockEditor } from '@/components/blocks/ScriptBlockEditor'
import { SegmentedControl, Toggle } from '@/components/settings/primitives'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Eyebrow, MetaLabel } from '@/components/ui/prose-text'

export interface AgentPromptBlock {
  id: string
  name: string
  role: 'system' | 'user'
  order: number
  source: 'builtin' | 'custom'
  enabled: boolean
  content: string
  contentPreview: string
  customDef?: CustomBlockDefinition
  override?: BlockOverride
}

type ContentMode = 'none' | 'prepend' | 'append' | 'override'

const CONTENT_MODES: Array<{ value: ContentMode; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'prepend', label: 'Prepend' },
  { value: 'append', label: 'Append' },
  { value: 'override', label: 'Replace' },
]

interface AgentPromptBlocksProps {
  storyId: string
  agentName: string
  blocks: AgentPromptBlock[]
  pending: boolean
  onOrderChange: (ids: string[]) => void
  onToggle: (id: string, enabled: boolean) => void
  onModeChange: (id: string, mode: Exclude<ContentMode, 'none'> | null) => void
  onContentChange: (id: string, content: string) => void
  onUpdateCustom: (id: string, updates: Partial<Omit<CustomBlockDefinition, 'id'>>) => void
  onDeleteCustom: (id: string) => void
  onCreate: (block: { name: string; role: 'system' | 'user'; type: 'simple' | 'script'; content: string }) => void
}

export function AgentPromptBlocks({
  storyId,
  agentName,
  blocks,
  pending,
  onOrderChange,
  onToggle,
  onModeChange,
  onContentChange,
  onUpdateCustom,
  onDeleteCustom,
  onCreate,
}: AgentPromptBlocksProps) {
  const [expanded, setExpanded] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const dragItem = useRef<number | null>(null)
  const dragTarget = useRef<number | null>(null)
  const roleTransitions = useMemo(() => new Set(
    blocks.flatMap((block, index) => index === 0 || block.role !== blocks[index - 1].role ? [index] : []),
  ), [blocks])

  const finishDrag = () => {
    if (dragItem.current !== null && dragTarget.current !== null && dragItem.current !== dragTarget.current) {
      const reordered = [...blocks]
      const [removed] = reordered.splice(dragItem.current, 1)
      reordered.splice(dragTarget.current, 0, removed)
      onOrderChange(reordered.map((block) => block.id))
    }
    dragItem.current = null
    dragTarget.current = null
    setDragIndex(null)
  }

  return (
    <section>
      <button type="button" className="mb-1.5 flex w-full items-center gap-2 px-0.5" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <Eyebrow>Prompt blocks</Eyebrow>
        <MetaLabel>{blocks.length}</MetaLabel>
        <div className="h-px flex-1 bg-border/20" />
        <ChevronDown className={cn('size-3 text-muted-foreground transition-transform duration-150', expanded && 'rotate-180')} />
      </button>

      {expanded && (
        <div className="space-y-1">
          {blocks.map((block, index) => (
            <div key={block.id}>
              {roleTransitions.has(index) && <RoleDivider role={block.role} separated={index > 0} />}
              <PromptBlock
                storyId={storyId}
                agentName={agentName}
                block={block}
                expanded={expandedId === block.id}
                dragging={dragIndex === index}
                pending={pending}
                onExpand={() => setExpandedId(expandedId === block.id ? null : block.id)}
                onDragStart={() => {
                  dragItem.current = index
                  setDragIndex(index)
                }}
                onDragEnter={() => { dragTarget.current = index }}
                onDragEnd={finishDrag}
                onToggle={() => onToggle(block.id, !block.enabled)}
                onModeChange={(mode) => onModeChange(block.id, mode === 'none' ? null : mode)}
                onContentChange={(content) => onContentChange(block.id, content)}
                onUpdateCustom={(updates) => onUpdateCustom(block.id, updates)}
                onDelete={() => onDeleteCustom(block.id)}
              />
            </div>
          ))}
          <button
            type="button"
            className="group mt-3 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border/30 py-3.5 text-ui-caption text-muted-foreground transition-all duration-200 hover:border-primary/30 hover:bg-primary/[0.02] hover:text-primary/60"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-3.5 transition-transform duration-200 group-hover:scale-110" />
            <span className="font-medium">Add context block</span>
          </button>
        </div>
      )}

      <BlockCreateDialog open={creating} onOpenChange={setCreating} onSubmit={onCreate} />
    </section>
  )
}

function RoleDivider({ role, separated }: { role: AgentPromptBlock['role']; separated: boolean }) {
  return (
    <div className={cn('flex items-center gap-2 px-1', separated ? 'mb-1.5 mt-3' : 'mb-1.5')}>
      <div className="size-1 rounded-full bg-muted-foreground/50" />
      <Eyebrow>{role} messages</Eyebrow>
      <div className="h-px flex-1 bg-border/20" />
    </div>
  )
}

function PromptBlock({
  storyId,
  agentName,
  block,
  expanded,
  dragging,
  pending,
  onExpand,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onToggle,
  onModeChange,
  onContentChange,
  onUpdateCustom,
  onDelete,
}: {
  storyId: string
  agentName: string
  block: AgentPromptBlock
  expanded: boolean
  dragging: boolean
  pending: boolean
  onExpand: () => void
  onDragStart: () => void
  onDragEnter: () => void
  onDragEnd: () => void
  onToggle: () => void
  onModeChange: (mode: ContentMode) => void
  onContentChange: (content: string) => void
  onUpdateCustom: (updates: Partial<Omit<CustomBlockDefinition, 'id'>>) => void
  onDelete: () => void
}) {
  const custom = block.source === 'custom'
  const script = custom && block.customDef?.type === 'script'
  return (
    <div className={cn(
      'rounded-lg border border-border/30 transition-all duration-200',
      !block.enabled && 'opacity-40',
      expanded && 'border-border/50 bg-accent/15 shadow-sm',
      custom && !expanded && 'border-dashed',
    )}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnter={onDragEnter}
        onDragEnd={onDragEnd}
        onDragOver={(event) => event.preventDefault()}
        className={cn('group flex select-none items-center px-2.5 py-2 transition-all duration-150', dragging && 'scale-[0.97] opacity-40')}
      >
        <button
          type="button"
          aria-expanded={expanded}
          data-cuelume-disclosure=""
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          onClick={onExpand}
        >
          <GripVertical className="-ml-0.5 size-3.5 shrink-0 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover:opacity-50" />
          {custom && (script ? <Code2 className="size-3.5 shrink-0 text-amber-500/60" /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" />)}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-tight">{block.name}</p>
            {!expanded && block.contentPreview && <MetaLabel asChild><p className="mt-0.5 truncate leading-snug">{block.contentPreview.slice(0, 80)}</p></MetaLabel>}
          </div>
          <Badge variant="outline" className="h-4 shrink-0 border-transparent bg-muted/30 px-1.5 text-ui-label font-normal text-muted-foreground">{block.role}</Badge>
          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-200', expanded && 'rotate-180')} />
        </button>
        <span className="ml-2">
          <Toggle checked={block.enabled} onChange={onToggle} disabled={pending} label={`${block.enabled ? 'Disable' : 'Enable'} ${block.name}`} />
        </span>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border/20 px-3 pb-3 pt-3">
          {custom && block.customDef ? (
            <>
              <Badge variant="outline" className={cn('h-5 px-2 text-ui-label font-normal', script ? 'border-amber-500/15 bg-amber-500/5 text-amber-500/70' : 'bg-muted/20 text-muted-foreground')}>{script ? 'JavaScript' : 'Plain text'}</Badge>
              {script ? (
                <>
                  <ScriptBlockEditor storyId={storyId} blockId={block.id} blockName={block.name} blockRole={block.role} value={block.customDef.content} onSave={(content) => onUpdateCustom({ content })} context={{ type: 'agent', agentName }} />
                  <FragmentReference storyId={storyId} />
                </>
              ) : (
                <BlurSaveTextarea value={block.customDef.content} onSave={(content) => onUpdateCustom({ content })} className="min-h-[80px] resize-y border-border/30 text-xs focus:border-border/60" rows={4} placeholder="Block content…" />
              )}
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-destructive/60 hover:bg-destructive/5 hover:text-destructive" onClick={onDelete}><Trash2 className="size-3" />Delete</Button>
              </div>
            </>
          ) : (
            <>
              <div>
                <Eyebrow asChild><h4 className="mb-1.5">Original content</h4></Eyebrow>
                <pre className="max-h-[120px] overflow-y-auto whitespace-pre-wrap rounded-md border border-border/15 bg-muted/15 p-3 text-ui-caption leading-relaxed text-muted-foreground">{block.contentPreview}{block.contentPreview.length >= 200 ? '…' : ''}</pre>
              </div>
              <div>
                <Eyebrow asChild><h4 className="mb-1.5">Modify</h4></Eyebrow>
                <SegmentedControl value={(block.override?.contentMode ?? 'none') as ContentMode} options={CONTENT_MODES} onChange={onModeChange} disabled={pending} />
              </div>
              {block.override?.contentMode && (
                <BlurSaveTextarea value={block.override.customContent ?? ''} onSave={onContentChange} placeholder={`Content to ${block.override.contentMode}…`} className="min-h-[60px] resize-y border-border/30 bg-muted/10 font-mono text-xs focus:border-border/60" rows={3} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function BlurSaveTextarea({ value, onSave, ...props }: { value: string; onSave: (value: string) => void } & Omit<React.ComponentProps<typeof Textarea>, 'value' | 'onChange' | 'onBlur'>) {
  const [local, setLocal] = useState(value)
  const saved = useRef(value)
  useEffect(() => {
    setLocal(value)
    saved.current = value
  }, [value])
  return <Textarea value={local} onChange={(event) => setLocal(event.target.value)} onBlur={() => { if (local !== saved.current) onSave(local) }} {...props} />
}
