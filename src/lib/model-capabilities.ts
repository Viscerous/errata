/** Compact model-window label for selectors and context diagnostics. */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }
  return tokens.toLocaleString()
}

export function modelOptionLabel(model: {
  id: string
  owned_by?: string
  isFree?: boolean
  contextWindow?: number
}): string {
  const details = [
    model.isFree ? 'free' : model.owned_by,
    model.contextWindow ? `${formatContextWindow(model.contextWindow)} context` : undefined,
  ].filter(Boolean)
  return details.length > 0 ? `${model.id} (${details.join(' · ')})` : model.id
}
