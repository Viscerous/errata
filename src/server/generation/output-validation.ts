export type GenerationRejectionCode =
  | 'empty_output'
  | 'incomplete_finish'

export type GenerationCommitAssessment =
  | { accepted: true }
  | {
      accepted: false
      code: GenerationRejectionCode
      message: string
    }

/**
 * Final mechanical gate between a provider stream and durable story state.
 *
 * This deliberately avoids judging or rewriting model content. It only rejects
 * an absent response or a provider stream that did not finish successfully.
 */
export function assessGenerationForCommit(
  text: string,
  finishReason: string,
): GenerationCommitAssessment {
  const trimmed = text.trim()
  if (!trimmed) {
    return {
      accepted: false,
      code: 'empty_output',
      message: 'The model returned no prose. Nothing was saved.',
    }
  }

  if (finishReason !== 'stop') {
    return {
      accepted: false,
      code: 'incomplete_finish',
      message: finishReason === 'length'
        ? 'The model hit its output limit. The unfinished passage was not saved.'
        : `The model did not finish normally (${finishReason || 'unknown'}). The passage was not saved.`,
    }
  }

  return { accepted: true }
}
