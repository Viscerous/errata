/**
 * What a librarian tool call actually did.
 *
 * The analysis tools decline work by *returning* `{ ok: false, skipped: [...] }`
 * rather than throwing, and they keep partial results by returning `ok: true`
 * alongside a list of what they had to drop. Any reader that treats a returned
 * value as success reports a refusal as a success — which is how a limit that
 * blocked its own paradigm case survived a kill test.
 *
 * The trace panel and the stored-analysis audit both read outcomes through
 * here, so a run cannot look clean in one and lossy in the other.
 */

const SKIP_LIST_KEYS = ['skipped', 'skippedContinuity', 'skippedMentions', 'skippedContradictions'] as const

export interface ToolOutcome {
  ok: boolean
  /**
   * How many pieces of work were dropped. Counted from the entries themselves,
   * not from the reasons: an entry that explains nothing is still a loss, and
   * counting reasons would hide exactly the losses that are hardest to see.
   */
  dropped: number
  /** The subset of those that said why, taken from each entry's own `reason`. */
  reasons: string[]
}

export function toolResultOutcome(result: unknown): ToolOutcome {
  if (!result || typeof result !== 'object') return { ok: true, dropped: 0, reasons: [] }
  const payload = result as Record<string, unknown>
  const reasons: string[] = []
  let dropped = 0
  for (const key of SKIP_LIST_KEYS) {
    const entries = payload[key]
    if (!Array.isArray(entries)) continue
    dropped += entries.length
    for (const entry of entries) {
      const reason = entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>).reason
        : null
      if (typeof reason === 'string' && reason.trim()) reasons.push(reason.trim())
    }
  }
  return { ok: payload.ok !== false, dropped, reasons }
}
