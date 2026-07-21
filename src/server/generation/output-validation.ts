export type GenerationRejectionCode =
  | 'empty_output'
  | 'incomplete_finish'
  | 'reasoning_leak'

export type GenerationCommitAssessment =
  | { accepted: true }
  | {
      accepted: false
      code: GenerationRejectionCode
      message: string
    }

const REASONING_SENTINEL_PREFIXES = [
  /^\.thought(?:\s|$)/i,
  /^<think(?:ing)?>/i,
  /^<analysis>/i,
  /^```(?:analysis|reasoning)(?:\s|$)/i,
]

/**
 * Final mechanical gate between a provider stream and durable story state.
 *
 * This deliberately avoids judging prose quality or story semantics. Those
 * belong to a future validation stage. It only rejects responses that are
 * objectively incomplete or unmistakably routed from a reasoning channel.
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

  const prefix = trimmed.replace(/^\uFEFF/, '').trimStart()
  if (REASONING_SENTINEL_PREFIXES.some(pattern => pattern.test(prefix))) {
    return {
      accepted: false,
      code: 'reasoning_leak',
      message: 'The model returned internal reasoning instead of prose. The passage was not saved.',
    }
  }

  return { accepted: true }
}
