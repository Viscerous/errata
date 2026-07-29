import { describe, it, expect } from 'vitest'
import { threadContinuityRows } from '@/components/sidebar/LibrarianPanel'

describe('threadContinuityRows', () => {
  // Lifecycle and focus describe the same threads, so listing the two lanes end
  // to end showed one thread twice: "the_trial_of_two_grounds: advance" then
  // "the_trial_of_two_grounds: foreground".
  it('folds a thread lifecycle and its focus into one readable row', () => {
    const rows = threadContinuityRows(
      [{ threadKey: 'the_trial_of_two_grounds', action: 'advance' }],
      [{ threadKey: 'the_trial_of_two_grounds', visibility: 'foreground' }],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('The trial of two grounds — advanced, in the foreground')
  })

  it('prefers a label the analysis supplied over the humanized key', () => {
    const rows = threadContinuityRows(
      [{ threadKey: 'who_sent_the_letter', action: 'open', label: 'Who sent the letter?' }],
      [],
    )

    expect(rows[0].content).toBe('Who sent the letter? — opened')
  })

  it('keeps a focus-only thread and a lifecycle-only thread as separate rows', () => {
    const rows = threadContinuityRows(
      [{ threadKey: 'the_missing_heir', action: 'resolve' }],
      [{ threadKey: 'the_border_treaty', visibility: 'background' }],
    )

    expect(rows.map((row) => row.content)).toEqual([
      'The missing heir — resolved',
      'The border treaty — in the background',
    ])
  })

  it('joins repeated lifecycle actions on one thread rather than repeating it', () => {
    const rows = threadContinuityRows(
      [
        { threadKey: 'the_siege', action: 'open' },
        { threadKey: 'the_siege', action: 'advance' },
      ],
      [],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('The siege — opened, advanced')
  })
})
