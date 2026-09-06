import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Eye, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { AuthorInputMode } from '@/contracts/generation'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface ContextPreviewDialogProps {
  storyId: string
  input: string
  inputMode: AuthorInputMode
  disabled?: boolean
}

/** A composer-adjacent receipt built by the same compiler as generation. */
export function ContextPreviewDialog({ storyId, input, inputMode, disabled }: ContextPreviewDialogProps) {
  const [open, setOpen] = useState(false)
  const preview = useMutation({
    mutationFn: () => api.generation.previewContext(storyId, input, inputMode),
  })

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next) preview.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          disabled={disabled}
          data-component-id="generation-context-preview-open"
        >
          <Eye className="size-3.5" />
          Context
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]" data-component-id="generation-context-preview">
        <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12">
          <DialogTitle className="font-display text-lg font-normal">What the next write sees</DialogTitle>
          <DialogDescription>
            A live receipt from the generation context compiler, including your current {inputMode === 'play' ? 'Play turn' : 'direction'}.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {preview.isPending ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Compiling context…
            </div>
          ) : preview.isError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {preview.error instanceof Error ? preview.error.message : 'Context preview failed.'}
            </div>
          ) : preview.data ? (
            <div className="space-y-5">
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded-full border border-border/50 px-2 py-1">{preview.data.pipeline} pipeline</span>
                <span className="rounded-full border border-border/50 px-2 py-1">{preview.data.inputMode} input</span>
                <span className="rounded-full border border-border/50 px-2 py-1">~{preview.data.estimatedTokens.toLocaleString()} tokens</span>
                <span className="rounded-full border border-border/50 px-2 py-1">messages ~{Math.ceil(preview.data.messageCharacters / 4).toLocaleString()}</span>
                <span className="rounded-full border border-border/50 px-2 py-1">tools ~{Math.ceil(preview.data.toolCharacters / 4).toLocaleString()}</span>
                <span className="rounded-full border border-border/50 px-2 py-1">{preview.data.blocks.length} blocks</span>
                <span className="rounded-full border border-border/50 px-2 py-1">{preview.data.tools.length} tools</span>
              </div>

              {preview.data.caveat && (
                <p className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {preview.data.caveat}
                </p>
              )}

              <section className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-base">Ordered blocks</h3>
                  <span className="text-xs text-muted-foreground">Expand any block to inspect it</span>
                </div>
                {preview.data.blocks.map(block => (
                  <details key={block.id} className="group rounded-md border border-border/40 bg-muted/10">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
                      <span className="font-medium">{block.name}</span>
                      <span className="ml-auto text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{block.role}</span>
                      <span className="text-[0.6875rem] text-muted-foreground">{block.source}</span>
                      <span className="text-[0.6875rem] tabular-nums text-muted-foreground">~{block.estimatedTokens.toLocaleString()} tokens</span>
                    </summary>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/30 px-3 py-3 font-mono text-xs leading-relaxed text-foreground/80">
                      {block.content}
                    </pre>
                  </details>
                ))}
              </section>

              <details className="rounded-md border border-border/40">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Exact compiled messages</summary>
                <div className="space-y-3 border-t border-border/30 p-3">
                  {preview.data.messages.map((message, index) => (
                    <div key={`${message.role}-${index}`}>
                      <p className="mb-1 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{message.role}</p>
                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/20 p-3 font-mono text-xs leading-relaxed">
                        {message.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>

              <details className="rounded-md border border-border/40">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Available tools ({preview.data.tools.length})</summary>
                <div className="space-y-2 border-t border-border/30 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                  {preview.data.tools.length > 0 ? preview.data.tools.map(tool => (
                    <details key={tool.name} className="rounded border border-border/30 px-2 py-1.5">
                      <summary className="cursor-pointer list-none">
                        <code className="text-foreground/80">{tool.name}</code>
                        <span className="float-right tabular-nums">~{tool.estimatedTokens.toLocaleString()} tokens</span>
                        {tool.description && <p>{tool.description}</p>}
                      </summary>
                      {tool.schema && (
                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/20 pt-2 font-mono text-[0.6875rem] leading-relaxed">
                          {tool.schema}
                        </pre>
                      )}
                    </details>
                  )) : 'No tools enabled'}
                </div>
              </details>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
