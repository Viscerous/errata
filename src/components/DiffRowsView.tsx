import { cn } from '@/lib/utils'
import type { DiffRow } from '@/lib/diff'

/**
 * Renders the rows from {@link diffRows} in the shared diff vocabulary used by
 * every diff surface: red-struck removals, green additions, muted context,
 * inline word-level `modify` rows, and collapsed `gap` markers. Emits bare `<div>`
 * rows so each caller controls the surrounding container (font size, `<pre>`,
 * scroll) itself.
 */
export function DiffRowsView({ rows, rowClassName }: { rows: DiffRow[]; rowClassName?: string }) {
  return (
    <>
      {rows.map((row, i) => {
        if (row.type === 'gap') {
          return (
            <div key={i} className={cn('select-none py-0.5 text-center text-muted-foreground/50', rowClassName)}>
              ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'} ⋯
            </div>
          )
        }
        if (row.type === 'modify') {
          return (
            <div key={i} className={cn('whitespace-pre-wrap break-words bg-amber-500/5', rowClassName)}>
              <span className="text-muted-foreground/50">{'~ '}</span>
              {row.segments.map((seg, j) => (
                <span
                  key={j}
                  className={cn(
                    seg.type === 'remove' && 'text-red-400 line-through bg-red-500/10',
                    seg.type === 'add' && 'text-emerald-400 bg-emerald-500/10',
                    seg.type === 'context' && 'text-muted-foreground',
                  )}
                >
                  {seg.text}
                </span>
              ))}
            </div>
          )
        }
        return (
          <div
            key={i}
            className={cn(
              'whitespace-pre-wrap break-words',
              row.type === 'remove' && 'text-red-400 bg-red-500/10',
              row.type === 'add' && 'text-emerald-400 bg-emerald-500/10',
              row.type === 'context' && 'text-muted-foreground',
              rowClassName,
            )}
          >
            {row.type === 'remove' ? '- ' : row.type === 'add' ? '+ ' : '  '}{row.text}
          </div>
        )
      })}
    </>
  )
}
