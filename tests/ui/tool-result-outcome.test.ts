import { describe, it, expect } from 'vitest'
import { toolResultOutcome } from '@/lib/librarian-outcome'

/**
 * The analysis tools refuse work by returning `{ ok: false, skipped: [...] }`
 * rather than throwing, so a trace row that renders every result it receives as
 * "completed" reports a refusal as a success. Timeline 12 showed
 * `proposeRecordCorrections completed` on a call that had rejected the only
 * correction in it, which is how a growth-limit regression survived a kill test.
 */
describe('toolResultOutcome', () => {
  it('reads a refusal that arrived as a normal return value', () => {
    const outcome = toolResultOutcome({
      ok: false,
      proposalCount: 0,
      invalid: 1,
      skipped: [{
        operationId: '',
        action: 'replace_text',
        reason: 'The replacement is 119 characters against a 14-character assertion (limit 94).',
      }],
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.dropped).toBe(1)
    expect(outcome.reasons).toEqual([
      'The replacement is 119 characters against a 14-character assertion (limit 94).',
    ])
  })

  /**
   * Counting reasons instead of entries hid the loss that hides best. One
   * stored run dropped seven mentions that carried no `reason` — the
   * explanation lived in a sibling note — and the panel reported it as a plain
   * success even after it had learned to report refusals.
   */
  it('counts work dropped without an explanation', () => {
    const outcome = toolResultOutcome({
      ok: true,
      mentionCount: 2,
      skippedMentions: [
        { fragmentId: 'ch-0001', text: 'her quiet menace' },
        { fragmentId: 'ch-0001', text: 'the long silence' },
      ],
      skippedMentionNote: 'These texts do not appear verbatim in the prose.',
    })

    expect(outcome.dropped).toBe(2)
    expect(outcome.reasons).toEqual([])
  })

  it('surfaces a partial loss on a call that otherwise succeeded', () => {
    // reportAnalysis keeps what it could ground and drops the rest, so `ok` is
    // true while continuity operations were silently lost.
    const outcome = toolResultOutcome({
      ok: true,
      stateOperationCount: 1,
      skippedContinuity: [{ kind: 'state', key: 'seal_color', reason: 'Cited sentence 7 does not exist in the passage.' }],
      skippedMentions: [{ text: 'the seal', reason: 'Not verbatim in the prose.' }],
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.reasons).toEqual([
      'Cited sentence 7 does not exist in the passage.',
      'Not verbatim in the prose.',
    ])
  })

  it('treats a plain success as a success', () => {
    expect(toolResultOutcome({ ok: true, queuedOperationCount: 1 })).toEqual({ ok: true, dropped: 0, reasons: [] })
    // Read tools and finishAnalysis return payloads with no `ok` field at all.
    expect(toolResultOutcome({ matches: [], total: 0 })).toEqual({ ok: true, dropped: 0, reasons: [] })
    expect(toolResultOutcome(undefined)).toEqual({ ok: true, dropped: 0, reasons: [] })
  })
})
