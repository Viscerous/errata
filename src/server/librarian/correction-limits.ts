/**
 * Structural limits for record maintenance that online analysis may apply
 * unattended. These are a safety boundary, not a style preference, so the tool
 * contract and the auto-apply re-check must read the same numbers.
 */
import { segmentText } from '../llm/segments'

export const MAX_CORRECTION_SPAN_CHARS = 1200
export const MAX_NEW_FRAGMENT_CONTENT_CHARS = 4000
export const MIN_CORRECTION_ANCHOR_CHARS = 3

/**
 * A correction replaces exactly one numbered segment, and a segment is exactly
 * one sentence, so the replacement is one sentence as well. Sentence count is
 * the structural half of "correct the assertion, do not restate the scene": a
 * paragraph recap stops being expressible rather than being caught by its size.
 * Timeline 9's worst case — a 79-character assertion replaced by 298 characters
 * of scene summary — is two sentences around a paragraph break, so shape alone
 * rejects it.
 *
 * Size still matters, because a recap can be comma-spliced into one sentence,
 * and there it is measured against the assertion being replaced. What changed is
 * the floor. It used to grant a flat 80 extra characters, which is not enough
 * room to make a terse assertion specific: Timeline 12 could not correct
 * `He is waiting.` (14 characters) to say the character had been killed, because
 * the allowance derived from those fourteen characters was 94. The floor is now
 * an absolute allowance for one ordinary sentence, which is what the rule always
 * meant by "so short assertions remain correctable" — a terse assertion has room
 * for a full sentence no matter how terse it was, while a long one stays bounded
 * proportionally.
 *
 * Observed one-sentence corrections: 114 and 153 characters legitimate; 236 a
 * single-sentence recap that must not pass.
 */
export const MAX_CORRECTION_GROWTH_RATIO = 1.5
export const MIN_CORRECTION_SENTENCE_CHARS = 180

export function correctionGrowthLimit(oldTextLength: number): number {
  return Math.max(Math.ceil(oldTextLength * MAX_CORRECTION_GROWTH_RATIO), MIN_CORRECTION_SENTENCE_CHARS)
}

/**
 * The sentence count is derived here rather than passed in: a caller that
 * forgot to segment, or segmented something else, would silently disable the
 * shape half of the rule and leave only the size backstop standing.
 */
export function correctionShapeError(oldText: string, newText: string): string | null {
  const sentenceCount = segmentText(newText).length
  if (sentenceCount > 1) {
    return `The replacement is ${sentenceCount} sentences. A correction replaces one numbered sentence with one sentence: correct that assertion and leave the rest of the record alone.`
  }
  const limit = correctionGrowthLimit(oldText.length)
  if (newText.length > limit) {
    return `The replacement is ${newText.length} characters against a ${oldText.length}-character assertion (limit ${limit}). Correct the stale assertion itself; do not restate the scene.`
  }
  return null
}
