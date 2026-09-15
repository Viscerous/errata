/**
 * Normalize presentation-only differences that commonly appear when a model
 * copies source text into a tool call. Word choice and word order remain intact.
 */
export function normalizeEvidenceText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/gu, "'")
    .replace(/[“”„‟″«»]/gu, '"')
    .replace(/[‐‑‒–—―−]/gu, '-')
    // Models frequently reproduce an exact excerpt with different quote
    // delimiters, Markdown emphasis, or capitalization. These are presentation
    // choices rather than changes to the asserted words or their order.
    .replace(/[*_~`'"«»]/gu, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .trim()
}

const ELLIPSIS_RE = /\s*(?:…|\.{3,})\s*/gu

interface EvidenceSpan {
  text: string
  trailingDelimiter?: string
}

function parseEvidenceSpans(evidence: string): EvidenceSpan[] {
  const spans: EvidenceSpan[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  ELLIPSIS_RE.lastIndex = 0
  while ((match = ELLIPSIS_RE.exec(evidence)) !== null) {
    const text = evidence.slice(lastIndex, match.index).trim()
    const delimiter = match[0]
    if (text) {
      spans.push({ text, trailingDelimiter: delimiter })
    }
    lastIndex = match.index + match[0].length
  }
  const tail = evidence.slice(lastIndex).trim()
  if (tail) {
    spans.push({ text: tail })
  }
  return spans
}

function mergeContiguousSourceSpans(source: string, rawSpans: EvidenceSpan[]): string[] {
  if (rawSpans.length === 0) return []

  const merged: string[] = []
  let current = rawSpans[0].text
  let delimiter = rawSpans[0].trailingDelimiter

  for (let i = 1; i < rawSpans.length; i += 1) {
    const next = rawSpans[i]
    if (delimiter !== undefined) {
      const combined = `${current}${delimiter}${next.text}`
      if (source.includes(combined)) {
        current = combined
        delimiter = next.trailingDelimiter
        continue
      }
    }
    merged.push(current)
    current = next.text
    delimiter = next.trailingDelimiter
  }
  merged.push(current)
  return merged
}

/**
 * Accept a contiguous excerpt after typography/whitespace normalization, or
 * multiple normalized verbatim spans joined by an ellipsis in source order.
 * Ellipsis matching deliberately requires substantial anchors so it cannot
 * degrade into keyword presence or paraphrase acceptance.
 */
export function evidenceAppearsInText(
  sourceContent: string | undefined,
  evidenceText: string,
): boolean {
  if (!sourceContent || !evidenceText.trim()) return false

  const source = normalizeEvidenceText(sourceContent)
  const evidence = normalizeEvidenceText(evidenceText)
  if (!source || !evidence) return false
  if (source.includes(evidence)) return true

  const rawSpans = parseEvidenceSpans(evidence)
  const spans = mergeContiguousSourceSpans(source, rawSpans)
  if (spans.length === 1 && spans[0].length >= 8) return source.includes(spans[0])
  if (spans.length < 2 || spans.some((span) => span.length < 3)) return false
  if (spans.reduce((length, span) => length + span.length, 0) < 8) return false

  let cursor = 0
  for (const span of spans) {
    const position = source.indexOf(span, cursor)
    if (position < 0) return false
    cursor = position + span.length
  }
  return true
}
