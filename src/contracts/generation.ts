export const AUTHOR_INPUT_MODES = ['direct', 'play'] as const

/**
 * How prose generation interprets the author's text.
 *
 * `direct` is an instruction or scene brief for the writing assistant.
 * `play` is the protagonist's intended move, staged near the opening of the
 * new passage by the model before pivoting outward to the world's answer.
 */
export type AuthorInputMode = (typeof AUTHOR_INPUT_MODES)[number]

/**
 * Remove only an exact whole-turn echo at the start of a Play continuation.
 * Anything less certain belongs in the prompt, not in heuristic prose repair.
 */
export function stripAuthorTurnEcho(authorInput: string, generatedText: string): string {
  const authorTurn = authorInput.trim().replace(/\r\n/g, '\n')
  const continuation = generatedText.trimStart().replace(/\r\n/g, '\n')
  if (!authorTurn || !continuation) return generatedText

  if (!continuation.startsWith(authorTurn)) return generatedText

  const remainder = continuation.slice(authorTurn.length)
  return !remainder || /^\s/.test(remainder)
    ? remainder.trimStart()
    : generatedText
}

/**
 * Build the canonical manuscript text committed for a successful generation.
 *
 * In Direct mode, the author's input is a directing brief, and the generated
 * prose is the complete manuscript passage.
 *
 * In Play mode, the model stages and integrates the protagonist's intended move
 * near the opening of the passage and resolves with the world's answer. The
 * generated prose is the complete staged passage; the author's input is not
 * mechanically prepended.
 */
export function composeGeneratedProse(
  _authorInput: string,
  generatedText: string,
  _inputMode: AuthorInputMode,
): string {
  return generatedText
}
