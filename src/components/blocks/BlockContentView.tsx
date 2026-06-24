import { useState, useRef, useCallback, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { componentId } from '@/lib/dom-ids'
import { EmptyHint } from '@/components/ui/prose-text'

interface BlockContentViewProps {
  messages: Array<{ role: string; content: string }>
  blocks?: Array<{ id: string; name: string; role: string }>
  /** Tools sent to the model via the SDK schema (shown as a dedicated section). */
  tools?: Array<{ name: string; description: string; enabled: boolean }>
  className?: string
}

const TOOLS_BLOCK_ID = '__tools__'

/**
 * Parse compiled messages into per-block segments using [@block=...] markers.
 * Supports both formats:
 *   [@block=id]              — builtin blocks
 *   [@block=slug src=id]     — named blocks (custom blocks with human-readable names)
 */
function parseBlockSegments(messages: Array<{ role: string; content: string }>) {
  const segments: Array<{ id: string; name: string; role: string; content: string }> = []

  for (const msg of messages) {
    const parts = msg.content.split(/\[@block=([^\]]+)\]\n?/)
    for (let i = 1; i < parts.length; i += 2) {
      const marker = parts[i]
      const content = (parts[i + 1] ?? '').replace(/\n{2,}$/, '')

      // Parse "slug src=id" format
      const srcMatch = marker.match(/^(.+?)\s+src=(.+)$/)
      if (srcMatch) {
        segments.push({ id: srcMatch[2], name: srcMatch[1], role: msg.role, content })
      } else {
        segments.push({ id: marker, name: marker, role: msg.role, content })
      }
    }
  }

  return segments
}

export function BlockContentView({ messages, blocks, tools, className }: BlockContentViewProps) {
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const segments = useMemo(() => parseBlockSegments(messages), [messages])
  const hasTools = (tools?.length ?? 0) > 0
  const enabledToolCount = useMemo(() => tools?.filter((t) => t.enabled).length ?? 0, [tools])

  // Build nav groups from explicit blocks list, or fall back to segments
  const navGroups = useMemo(() => {
    const source = blocks ?? segments.map((s) => ({ id: s.id, name: s.name, role: s.role }))
    const groups: Array<{ role: string; blocks: Array<{ id: string; name: string }> }> = []
    let currentRole = ''
    for (const block of source) {
      if (block.role !== currentRole) {
        currentRole = block.role
        groups.push({ role: block.role, blocks: [] })
      }
      groups[groups.length - 1].blocks.push({ id: block.id, name: block.name })
    }
    if (hasTools) {
      groups.push({ role: 'tools', blocks: [{ id: TOOLS_BLOCK_ID, name: `Tools · ${enabledToolCount}/${tools!.length}` }] })
    }
    return groups
  }, [blocks, segments, hasTools, enabledToolCount, tools])

  const scrollToBlock = useCallback((blockId: string) => {
    setActiveBlockId(blockId)
    const el = contentRef.current?.querySelector(`[data-block-id="${blockId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  if (segments.length === 0 && !hasTools) {
    return (
      <div className={cn('flex items-center justify-center py-16', className)}>
        <EmptyHint>No blocks in context</EmptyHint>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-1 min-h-0', className)} data-component-id="block-content-root">
      {/* Left nav */}
      <div className="w-[180px] shrink-0 border-r border-border/30 overflow-y-auto py-3 px-2" data-component-id="block-content-nav">
        {navGroups.map((group) => (
          <div key={group.role} className="mb-3 last:mb-0">
            <div className="flex items-center gap-1.5 px-2 mb-1">
              <div className="size-1 rounded-full bg-muted-foreground/50" />
              <span className="text-[0.5625rem] text-muted-foreground uppercase tracking-[0.15em] font-medium">
                {group.role}
              </span>
            </div>
            {group.blocks.map((block) => (
            <button
              key={block.id}
              className={cn(
                'w-full text-left px-2 py-1 rounded-md text-[0.6875rem] truncate transition-colors duration-100',
                activeBlockId === block.id
                  ? 'bg-accent/50 text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground/80 hover:bg-accent/25',
              )}
              onClick={() => scrollToBlock(block.id)}
              title={block.name}
              data-component-id={componentId('block-content-nav', block.id)}
            >
              {block.name}
            </button>
            ))}
          </div>
        ))}
      </div>

      {/* Right content */}
      <ScrollArea className="flex-1 min-w-0" data-component-id="block-content-scroll">
        <div ref={contentRef} className="p-4 space-y-2">
          {segments.map((seg) => (
            <div
              key={seg.id}
              data-block-id={seg.id}
              className={cn(
                'rounded-lg border border-border/20 overflow-hidden transition-colors duration-200',
                activeBlockId === seg.id && 'border-border/40 bg-accent/10',
              )}
            >
              {/* Block header */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/10 border-b border-border/10">
                <span className="text-[0.625rem] font-medium text-muted-foreground truncate">
                  {seg.name}
                </span>
                {seg.name !== seg.id && (
                  <span className="text-[0.5625rem] text-muted-foreground/50 font-mono truncate">
                    {seg.id}
                  </span>
                )}
                <span className="text-[0.5625rem] text-muted-foreground tabular-nums ml-auto shrink-0">
                  {seg.content.length.toLocaleString()} chars
                </span>
                <Badge
                  variant="outline"
                  className="text-[0.5625rem] h-3.5 px-1 font-normal border-transparent text-muted-foreground bg-muted/30 shrink-0"
                >
                  {seg.role}
                </Badge>
              </div>

              {/* Block content */}
              <pre className="whitespace-pre-wrap text-[0.6875rem] font-mono text-muted-foreground p-3 max-h-[300px] overflow-y-auto leading-relaxed">
                {seg.content}
              </pre>
            </div>
          ))}

          {hasTools && (
            <div
              data-block-id={TOOLS_BLOCK_ID}
              className={cn(
                'rounded-lg border border-border/20 overflow-hidden transition-colors duration-200',
                activeBlockId === TOOLS_BLOCK_ID && 'border-border/40 bg-accent/10',
              )}
            >
              <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/10 border-b border-border/10">
                <span className="text-[0.625rem] font-medium text-muted-foreground">Tools</span>
                <span className="text-[0.5625rem] text-muted-foreground/70">
                  sent to the model via the API tool schema
                </span>
                <span className="text-[0.5625rem] text-muted-foreground tabular-nums ml-auto shrink-0">
                  {enabledToolCount}/{tools!.length} enabled
                </span>
              </div>

              <div className="p-3 space-y-2">
                {tools!.map((t) => (
                  <div key={t.name} className={cn('flex flex-col gap-0.5', !t.enabled && 'opacity-45')}>
                    <div className="flex items-center gap-2">
                      <code className={cn('text-[0.6875rem] font-mono text-foreground/90', !t.enabled && 'line-through')}>
                        {t.name}
                      </code>
                      {!t.enabled && (
                        <Badge
                          variant="outline"
                          className="text-[0.5rem] h-3.5 px-1 font-normal border-transparent text-muted-foreground bg-muted/30 shrink-0 uppercase tracking-wide"
                        >
                          disabled
                        </Badge>
                      )}
                    </div>
                    {t.description && (
                      <p className="text-[0.625rem] text-muted-foreground leading-relaxed">{t.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
