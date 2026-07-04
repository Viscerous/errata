// Shared diff for every diff surface (version preview, proposed-change previews).
// One LCS aligner drives both the line and word passes. Since a "line" here is often
// a whole paragraph, an edited paragraph is re-diffed at word level and shown inline,
// so a one-word change highlights that word instead of repainting the paragraph.
// Long unchanged runs collapse into a single gap marker, like Git.

export type DiffLineType = 'context' | 'add' | 'remove'

/** A typed span of text, used for both whole lines and intra-line word tokens. */
export interface DiffSegment {
  type: DiffLineType
  text: string
}

export type DiffLine = DiffSegment
export type WordSegment = DiffSegment

/**
 * A renderable row: a whole added/removed/context line, an edited line carrying
 * word-level segments, or a collapsed run of unchanged lines.
 */
export type DiffRow =
  | DiffSegment
  | { type: 'modify'; segments: WordSegment[] }
  | { type: 'gap'; count: number }

/** Intermediate row before context collapsing (no gaps yet). */
type PreRow = DiffSegment | { type: 'modify'; segments: WordSegment[] }

/**
 * LCS alignment of two token sequences (lines or words). O(n*m) in time and
 * space over the changed span — {@link diffSequence} trims the common head and
 * tail first, so for a typical edit the core only sees the few tokens that differ.
 */
function lcsDiff(a: string[], b: string[]): DiffSegment[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffSegment[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'remove', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'remove', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}

/** Aligned diff of two token sequences with common prefix/suffix trimmed off first. */
function diffSequence(a: string[], b: string[]): DiffSegment[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const out: DiffSegment[] = []
  for (let k = 0; k < start; k++) out.push({ type: 'context', text: a[k] })
  out.push(...lcsDiff(a.slice(start, endA), b.slice(start, endB)))
  for (let k = endA; k < a.length; k++) out.push({ type: 'context', text: a[k] })
  return out
}

/**
 * Aligned line diff of `before` → `after`. `remove` lines come only from
 * `before`, `add` lines only from `after`, `context` lines are common. Correct
 * under insertion and deletion — a single inserted line shows as one `add`, not a
 * cascade of false changes.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length ? before.split('\n') : []
  const b = after.length ? after.split('\n') : []
  return diffSequence(a, b)
}

/** Split into word and whitespace tokens, preserving both so join('') restores the text. */
function tokenizeWords(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token.length > 0)
}

/**
 * Aligned word diff of `before` → `after`, tokenized on whitespace boundaries.
 * Whitespace tokens are diffed too, so spacing is preserved when segments are
 * concatenated.
 */
export function diffWords(before: string, after: string): WordSegment[] {
  return diffSequence(tokenizeWords(before), tokenizeWords(after))
}

/**
 * Below this fraction of shared characters, two paired lines are treated as a rewrite,
 * not an edit, and shown as separate remove/add lines — an inline word diff would
 * otherwise interleave incidental shared words ("the", "and") into confetti.
 */
const WORD_DIFF_SIMILARITY_THRESHOLD = 0.25

function editedRow(before: string, after: string): PreRow[] {
  const segments = diffWords(before, after)
  const shared = segments
    .filter((segment) => segment.type === 'context')
    .reduce((total, segment) => total + segment.text.length, 0)
  const scale = Math.max(before.length, after.length) || 1
  if (shared / scale < WORD_DIFF_SIMILARITY_THRESHOLD) {
    return [{ type: 'remove', text: before }, { type: 'add', text: after }]
  }
  return [{ type: 'modify', segments }]
}

/**
 * Pair each removed line that is immediately followed by an added line into a
 * single `modify` row carrying an inline word diff. Unpaired removes/adds and all
 * context pass through unchanged.
 */
function pairModifications(ops: DiffSegment[]): PreRow[] {
  const rows: PreRow[] = []
  let idx = 0
  while (idx < ops.length) {
    if (ops[idx].type !== 'remove') {
      rows.push(ops[idx])
      idx++
      continue
    }
    const removes: DiffSegment[] = []
    while (idx < ops.length && ops[idx].type === 'remove') removes.push(ops[idx++])
    const adds: DiffSegment[] = []
    while (idx < ops.length && ops[idx].type === 'add') adds.push(ops[idx++])

    const pairs = Math.min(removes.length, adds.length)
    for (let k = 0; k < pairs; k++) rows.push(...editedRow(removes[k].text, adds[k].text))
    for (let k = pairs; k < removes.length; k++) rows.push(removes[k])
    for (let k = pairs; k < adds.length; k++) rows.push(adds[k])
  }
  return rows
}

/** True when a diff contains at least one added or removed segment. */
export function hasChanges(ops: DiffSegment[]): boolean {
  return ops.some((op) => op.type !== 'context')
}

/**
 * Collapse runs of unchanged lines more than `context` away from any change into
 * a single `gap` row, keeping `context` lines on each side of every change
 * (Git's `@@ … @@` behaviour). Returns an empty list when nothing changed.
 */
export function collapseContext(rows: PreRow[], context = 3): DiffRow[] {
  const isChange = (row: PreRow) => row.type !== 'context'
  if (!rows.some(isChange)) return []

  const keep = new Array<boolean>(rows.length).fill(false)
  rows.forEach((row, idx) => {
    if (!isChange(row)) return
    const lo = Math.max(0, idx - context)
    const hi = Math.min(rows.length - 1, idx + context)
    for (let k = lo; k <= hi; k++) keep[k] = true
  })

  const out: DiffRow[] = []
  let skipped = 0
  for (let idx = 0; idx < rows.length; idx++) {
    if (keep[idx]) {
      if (skipped > 0) {
        out.push({ type: 'gap', count: skipped })
        skipped = 0
      }
      out.push(rows[idx])
    } else {
      skipped++
    }
  }
  if (skipped > 0) out.push({ type: 'gap', count: skipped })
  return out
}

/**
 * Full diff of `before` → `after` as renderable rows: line-aligned, edited
 * paragraphs word-diffed inline, unchanged runs collapsed into gaps.
 */
export function diffRows(before: string, after: string, context = 3): DiffRow[] {
  return collapseContext(pairModifications(diffLines(before, after)), context)
}
