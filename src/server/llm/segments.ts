/**
 * Stable sentence addressing for text the model must cite.
 *
 * The Librarian contracts used to ask the model to retype an excerpt of the
 * passage it had just been shown, and a fuzzy matcher then absorbed the
 * transcription errors. Numbering the text instead lets the model *point*: a
 * segment index is verifiable by construction, costs one integer instead of a
 * few hundred output characters, and turns "could not quote it" into "cited the
 * wrong sentence" — a reviewable judgement rather than a mechanical retry.
 *
 * Offsets are exact, so `source.slice(start, end) === text` always holds and a
 * cited segment resolves to byte-identical source text.
 */

export interface TextSegment {
  /** 1-based; the model sees these numbers. */
  index: number
  text: string
  start: number
  end: number
}

/**
 * Abbreviations whose trailing period is not a sentence end. Kept deliberately
 * short: a missed split yields a slightly longer segment, which is harmless,
 * while an over-eager list risks joining genuine sentences.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'lt', 'sgt', 'capt',
  'no', 'vs', 'etc', 'e.g', 'i.e', 'approx', 'dept', 'est',
])

const SENTENCE_END = /[.!?]/
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '»'])

function endsWithAbbreviation(text: string): boolean {
  const match = /([A-Za-z.]+)\.$/.exec(text.trimEnd())
  if (!match) return false
  return ABBREVIATIONS.has(match[1].toLowerCase())
}

/**
 * A single capital letter before the period is an initial ("J. R. R."), not a
 * sentence end.
 */
function endsWithInitial(text: string): boolean {
  return /(^|\s)[A-Z]\.$/.test(text.trimEnd())
}

function isSegmentBoundary(source: string, cursor: number): boolean {
  let index = cursor
  // Absorb repeated terminators ("?!", "...") and any closing quotes/brackets.
  while (index < source.length && SENTENCE_END.test(source[index])) index += 1
  while (index < source.length && CLOSERS.has(source[index])) index += 1
  if (index >= source.length) return true
  if (!/\s/.test(source[index])) return false

  let next = index
  while (next < source.length && /\s/.test(source[next])) next += 1
  if (next >= source.length) return true
  // A continuation like `he said` after dialogue is the same sentence.
  return !/[a-z]/.test(source[next])
}

/**
 * True when the newline at `cursor` is followed by an empty line. Scanning
 * forward rather than matching a fixed window keeps this honest about `\r\n`
 * and about indented blank lines: a windowed `\n[ \t]*\n` missed
 * `A heading\r\n\r\nThen prose.` entirely, merging a heading and the paragraph
 * under it into one addressable segment.
 */
function blankLineFollows(source: string, cursor: number): boolean {
  let index = cursor + 1
  while (index < source.length && /[ \t\r]/.test(source[index])) index += 1
  return index < source.length && source[index] === '\n'
}

function boundaryEnd(source: string, cursor: number): number {
  let index = cursor
  while (index < source.length && SENTENCE_END.test(source[index])) index += 1
  while (index < source.length && CLOSERS.has(source[index])) index += 1
  return index
}

/**
 * Split into addressable sentences. Blank lines end a segment so a paragraph
 * break can never be swallowed into the middle of one.
 */
export function segmentText(source: string): TextSegment[] {
  const segments: TextSegment[] = []
  let segmentStart = 0
  let cursor = 0

  const push = (start: number, end: number) => {
    const text = source.slice(start, end)
    if (!text.trim()) return
    const leading = text.length - text.trimStart().length
    const trailing = text.length - text.trimEnd().length
    segments.push({
      index: segments.length + 1,
      text: source.slice(start + leading, end - trailing),
      start: start + leading,
      end: end - trailing,
    })
  }

  while (cursor < source.length) {
    const char = source[cursor]

    if (char === '\n' && blankLineFollows(source, cursor)) {
      push(segmentStart, cursor)
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
      segmentStart = cursor
      continue
    }

    if (SENTENCE_END.test(char)) {
      const candidate = source.slice(segmentStart, cursor + 1)
      if (
        (char !== '.' || (!endsWithAbbreviation(candidate) && !endsWithInitial(candidate)))
        && isSegmentBoundary(source, cursor)
      ) {
        const end = boundaryEnd(source, cursor)
        push(segmentStart, end)
        cursor = end
        segmentStart = cursor
        continue
      }
    }

    cursor += 1
  }

  push(segmentStart, source.length)
  return segments
}

/** Render for a prompt block: `[1] First sentence.` one per line. */
export function renderSegments(segments: TextSegment[]): string {
  return segments.map((segment) => `[${segment.index}] ${segment.text}`).join('\n')
}

const SEGMENT_MARKER_RE = /^\s*\[\d+\]\s*/

/**
 * The inverse of the marker `renderSegments` adds, for text a model writes back.
 * Numbering a record so it can be addressed by sentence teaches the model that a
 * sentence looks like `[16] He is waiting.`, so it writes the replacement the
 * same way: Timeline 12 sent `[16] He is deceased...` and nothing removed the
 * marker, which both inflated the length check and would have written `[16] `
 * verbatim into the record had the check passed.
 *
 * Stripping it here keeps the presentation format from leaking into stored
 * content no matter which surface echoes it back, and it lives beside the
 * renderer so the two cannot drift.
 */
export function stripSegmentMarker(text: string): string {
  return text.replace(SEGMENT_MARKER_RE, '')
}

export interface ResolvedSegments {
  text: string
  indexes: number[]
  invalid: number[]
}

/**
 * Resolve cited indices to exact source text, in source order and de-duplicated.
 * Non-adjacent citations join with an ellipsis so the stored excerpt still reads
 * as one quotation for review and for later re-checking.
 */
export function resolveSegments(segments: TextSegment[], cited: number[]): ResolvedSegments {
  const byIndex = new Map(segments.map((segment) => [segment.index, segment]))
  const invalid = [...new Set(cited)].filter((index) => !byIndex.has(index)).sort((a, b) => a - b)
  const valid = [...new Set(cited)].filter((index) => byIndex.has(index)).sort((a, b) => a - b)

  const parts: string[] = []
  let previous: number | undefined
  for (const index of valid) {
    if (previous !== undefined && index !== previous + 1) parts.push('...')
    parts.push(byIndex.get(index)!.text)
    previous = index
  }

  return { text: parts.join(' '), indexes: valid, invalid }
}
