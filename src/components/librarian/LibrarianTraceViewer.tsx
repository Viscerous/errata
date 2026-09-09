import { useState } from 'react'
import { Brain, Check, ChevronDown, ChevronRight, Wrench, X } from 'lucide-react'
import type { LibrarianAnalysis } from '@/lib/api'
import { toolResultOutcome } from '@/lib/librarian-outcome'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

type CollapsedTraceItem =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; toolName: string; args: Record<string, unknown> }
  | { kind: 'tool-result'; toolName: string; result: unknown }

export function collapseLibrarianTrace(trace: LibrarianAnalysis['trace']): CollapsedTraceItem[] {
  if (!trace) return []
  const items: CollapsedTraceItem[] = []
  let reasoning = ''
  let text = ''

  const flushText = () => {
    if (reasoning) items.push({ kind: 'reasoning', text: reasoning })
    if (text) items.push({ kind: 'text', text })
    reasoning = ''
    text = ''
  }

  for (const event of trace) {
    if (event.type === 'reasoning') {
      if (text) flushText()
      reasoning += event.text ?? ''
      continue
    }
    if (event.type === 'text') {
      if (reasoning) flushText()
      text += event.text ?? ''
      continue
    }

    flushText()
    if (event.type === 'tool-call') {
      const toolCall = event as { toolName?: string; args?: Record<string, unknown> }
      items.push({ kind: 'tool-call', toolName: toolCall.toolName ?? '', args: toolCall.args ?? {} })
    } else if (event.type === 'tool-result') {
      const toolResult = event as { toolName?: string; result?: unknown }
      items.push({ kind: 'tool-result', toolName: toolResult.toolName ?? '', result: toolResult.result })
    }
  }
  flushText()
  return items
}

export function LibrarianTraceViewer({ trace }: { trace: LibrarianAnalysis['trace'] }) {
  const [expanded, setExpanded] = useState(false)
  const items = collapseLibrarianTrace(trace)
  if (items.length === 0) return null

  return (
    <div data-component-id="librarian-analysis-trace">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setExpanded(current => !current)}
        aria-expanded={expanded}
        className="px-1 text-muted-foreground"
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
        Analysis trace
        <span className="opacity-60">({items.length})</span>
      </Button>
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {items.map((item, index) => (
            <TraceItem key={`${item.kind}-${index}`} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

function TraceItem({ item }: { item: CollapsedTraceItem }) {
  const [expanded, setExpanded] = useState(false)

  if (item.kind === 'reasoning' || item.kind === 'tool-call') {
    const isReasoning = item.kind === 'reasoning'
    return (
      <div className="overflow-hidden rounded-md border border-border/20 bg-background/20">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setExpanded(current => !current)}
          aria-expanded={expanded}
          className="h-7 w-full justify-start rounded-none px-2 text-muted-foreground"
        >
          {isReasoning
            ? <Brain className="text-purple-400/60" />
            : <Wrench className="text-blue-400/60" />}
          {isReasoning ? (
            <>
              <span>Reasoning</span>
              <span className="ml-auto opacity-60">{item.text.length} chars</span>
            </>
          ) : (
            <Badge variant="outline" className="h-4 px-1 text-ui-label">{item.toolName}</Badge>
          )}
        </Button>
        {expanded && (
          <div className="border-t border-border/10 px-2 py-1.5">
            {isReasoning ? (
              <p className="whitespace-pre-wrap break-words font-mono text-ui-label leading-relaxed text-muted-foreground">{item.text}</p>
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-ui-label leading-relaxed text-muted-foreground">{JSON.stringify(item.args, null, 2)}</pre>
            )}
          </div>
        )}
      </div>
    )
  }

  if (item.kind === 'text') {
    return <p className="px-2 py-0.5 text-ui-label leading-relaxed text-foreground/50">{item.text}</p>
  }

  const outcome = toolResultOutcome(item.result)
  return (
    <div className="flex flex-col gap-0.5 px-2 py-0.5">
      <div className="flex items-center gap-1">
        {outcome.ok
          ? <Check className="size-2.5 text-emerald-500/50" />
          : <X className="size-2.5 text-amber-500/70" />}
        <span className="text-ui-label text-muted-foreground">
          {item.toolName} {outcome.ok ? 'completed' : 'rejected'}
          {outcome.ok && outcome.dropped > 0 ? ` — ${outcome.dropped} skipped` : ''}
        </span>
      </div>
      {outcome.reasons.map((reason, index) => (
        <p key={index} className="pl-3.5 text-ui-label leading-relaxed text-amber-500/60">{reason}</p>
      ))}
      {outcome.dropped > outcome.reasons.length && (
        <p className="pl-3.5 text-ui-label italic leading-relaxed text-amber-500/40">
          {outcome.dropped - outcome.reasons.length} gave no reason
        </p>
      )}
    </div>
  )
}
