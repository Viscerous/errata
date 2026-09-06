export const AUTHOR_INPUT_MODES = ['direct', 'play'] as const

/**
 * How prose generation interprets the author's text.
 *
 * `direct` is an instruction to the writing assistant. `play` is a canonical
 * turn inside the fiction that the writer must preserve and continue from.
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
 * Direction text is prompt-only. In Play, the author's turn is prose, so it is
 * stored immediately before the model's continuation.
 */
export function composeGeneratedProse(
  authorInput: string,
  generatedText: string,
  inputMode: AuthorInputMode,
): string {
  if (inputMode !== 'play') return generatedText

  const authorTurn = authorInput.trim()
  const continuation = stripAuthorTurnEcho(authorInput, generatedText).trimStart()
  if (!authorTurn) return generatedText
  if (!continuation) return authorTurn
  return `${authorTurn}\n\n${continuation}`
}
