import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { buildContextPayloadBreakdown } from '@/lib/context-payload'
import { formatContextWindow } from '@/lib/model-capabilities'

interface ContextPayloadOverviewProps {
  messages: Array<{ role: string; content: string }>
  blocks?: Array<{ id: string; name: string; role: string; content?: string }>
  tools?: Array<{ name: string; characters: number; enabled?: boolean }>
  toolStages?: Array<{
    id: string
    label: string
    description: string
    conditional: boolean
    toolNames: string[]
  }>
  contextWindowTokens?: number
  className?: string
}

const partColors: Record<string, string> = {
  system: 'bg-violet-400/70',
  user: 'bg-sky-400/70',
  assistant: 'bg-emerald-400/70',
  tool: 'bg-amber-400/70',
}

export function ContextPayloadOverview({ messages, blocks, tools, toolStages, contextWindowTokens, className }: ContextPayloadOverviewProps) {
  const [selectedStageId, setSelectedStageId] = useState(toolStages?.[0]?.id)
  const selectedStage = toolStages?.find((stage) => stage.id === selectedStageId) ?? toolStages?.[0]
  const breakdown = useMemo(() => buildContextPayloadBreakdown({
    messages,
    blocks,
    tools,
    activeToolNames: selectedStage?.toolNames,
  }), [messages, blocks, tools, selectedStage])
  const largestCharacters = breakdown.largestSources[0]?.characters ?? 1
  const contextUsage = contextWindowTokens
    ? Math.round((breakdown.estimatedTokens / contextWindowTokens) * 100)
    : null

  return (
    <section className={cn('rounded-lg border border-border/30 bg-muted/[0.06] p-3', className)} data-component-id="context-payload-overview">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-foreground/90">Request payload</h3>
            {selectedStage && (
              <Badge variant="outline" className="h-4 border-border/30 px-1.5 text-ui-label font-normal text-muted-foreground">
                {selectedStage.label}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-ui-label text-muted-foreground">
            Exact compiled messages and serialized tool schemas
          </p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-sm font-medium tabular-nums text-foreground/90">~{breakdown.estimatedTokens.toLocaleString()} tokens</p>
          <p className="text-ui-label tabular-nums text-muted-foreground">{breakdown.estimatedCharacters.toLocaleString()} characters</p>
        </div>
      </div>

      {(toolStages?.length ?? 0) > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {toolStages!.map((stage) => (
            <button
              key={stage.id}
              type="button"
              className={cn(
                'rounded-md border px-2 py-1 text-ui-label transition-colors',
                selectedStage?.id === stage.id
                  ? 'border-primary/30 bg-primary/[0.07] text-foreground'
                  : 'border-border/30 text-muted-foreground hover:bg-accent/30 hover:text-foreground/80',
              )}
              onClick={() => setSelectedStageId(stage.id)}
              title={stage.description}
            >
              {stage.label}{stage.conditional ? ' · when needed' : ''}
            </button>
          ))}
        </div>
      )}
      {selectedStage && (
        <p className="mt-1.5 text-ui-label leading-relaxed text-muted-foreground">{selectedStage.description}</p>
      )}

      {contextWindowTokens && contextUsage !== null && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-3 text-ui-label text-muted-foreground">
            <span>
              Estimated prompt · {contextUsage}% of {formatContextWindow(contextWindowTokens)} advertised context
            </span>
            <span className="shrink-0 tabular-nums">
              {contextUsage <= 100
                ? `~${Math.max(0, contextWindowTokens - breakdown.estimatedTokens).toLocaleString()} left for output`
                : `~${(breakdown.estimatedTokens - contextWindowTokens).toLocaleString()} over`}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted/30">
            <div
              className={cn('h-full rounded-full', contextUsage > 100 ? 'bg-amber-400/75' : 'bg-primary/55')}
              style={{ width: `${Math.min(100, contextUsage)}%` }}
            />
          </div>
        </div>
      )}

      {breakdown.estimatedCharacters > 0 && (
        <>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted/30" aria-label="Relative request payload composition">
            {breakdown.requestParts.map((part) => (
              <span
                key={part.id}
                className={part.kind === 'tool' ? partColors.tool : partColors[part.role ?? ''] ?? 'bg-muted-foreground/50'}
                style={{ flexGrow: part.characters }}
                title={`${part.label}: ~${part.estimatedTokens.toLocaleString()} tokens`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {breakdown.requestParts.map((part) => (
              <div key={part.id} className="flex items-center gap-1.5 text-ui-label text-muted-foreground">
                <span className={cn('size-1.5 rounded-full', part.kind === 'tool' ? partColors.tool : partColors[part.role ?? ''] ?? 'bg-muted-foreground/50')} />
                <span>{part.label}</span>
                <span className="tabular-nums">~{part.estimatedTokens.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {breakdown.largestSources.length > 0 && (
        <div className="mt-3 border-t border-border/20 pt-2.5">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="text-ui-label font-medium text-foreground/80">Largest declared sources</p>
            <p className="text-ui-label text-muted-foreground">Blocks are measured before final message hooks</p>
          </div>
          <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {breakdown.largestSources.map((part) => (
              <div key={part.id} className="min-w-0">
                <div className="flex items-center gap-2 text-ui-label">
                  <span className="truncate text-muted-foreground" title={part.label}>{part.label}</span>
                  <Badge variant="outline" className="ml-auto h-4 border-transparent bg-muted/30 px-1 text-ui-label font-normal text-muted-foreground">
                    {part.kind === 'tool' ? 'tool' : part.role}
                  </Badge>
                  <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">~{part.estimatedTokens.toLocaleString()}</span>
                </div>
                <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted/30">
                  <div
                    className={cn('h-full rounded-full', part.kind === 'tool' ? partColors.tool : partColors[part.role ?? ''] ?? 'bg-muted-foreground/50')}
                    style={{ width: `${Math.max(2, (part.characters / largestCharacters) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
