import { describe, expect, it } from 'vitest'
import { renderSegments, resolveSegments, segmentText, stripSegmentMarker } from '@/server/llm/segments'

const texts = (source: string) => segmentText(source).map((segment) => segment.text)

describe('sentence segmentation', () => {
  it('keeps offsets exact so a cited segment resolves to byte-identical source', () => {
    const source = 'First sentence. Second one!\n\nA new paragraph? Yes.'
    for (const segment of segmentText(source)) {
      expect(source.slice(segment.start, segment.end)).toBe(segment.text)
    }
  })

  it('numbers segments from one, in order', () => {
    expect(segmentText('One. Two. Three.').map((s) => s.index)).toEqual([1, 2, 3])
  })

  it('splits ordinary sentences and paragraphs', () => {
    expect(texts('She left. He stayed.\n\nMorning came.')).toEqual([
      'She left.',
      'He stayed.',
      'Morning came.',
    ])
  })

  it('keeps a dialogue attribution with its quotation', () => {
    expect(texts('"Ground yields," she said. He did not move.')).toEqual([
      '"Ground yields," she said.',
      'He did not move.',
    ])
  })

  it('closes a segment after a terminator inside quotes', () => {
    expect(texts('“Get out!” The door slammed.')).toEqual([
      '“Get out!”',
      'The door slammed.',
    ])
  })

  it('does not split on abbreviations or initials', () => {
    expect(texts('Dr. Algra arrived. She waited.')).toEqual(['Dr. Algra arrived.', 'She waited.'])
    expect(texts('J. R. Vollenhoven signed it. Nobody objected.')).toEqual([
      'J. R. Vollenhoven signed it.',
      'Nobody objected.',
    ])
  })

  it('treats repeated terminators as one boundary', () => {
    expect(texts('What?! Nothing. Wait...  Then silence.')).toEqual([
      'What?!',
      'Nothing.',
      'Wait...',
      'Then silence.',
    ])
  })

  it('handles a final sentence with no terminator', () => {
    expect(texts('It ended. And then')).toEqual(['It ended.', 'And then'])
  })

  /**
   * A record often opens with an unterminated line — a heading or a label —
   * above its prose, so the paragraph break is the only boundary there is.
   * Matching a fixed three-character window missed `\r\n\r\n` and any indented
   * blank line, merging the heading into the paragraph below it and leaving no
   * way to correct either one on its own.
   */
  it('breaks on a blank line however it is spelled', () => {
    for (const source of [
      'A heading\n\nThen prose.',
      'A heading\r\n\r\nThen prose.',
      'A heading\n   \nThen prose.',
      'A heading\n\t\nThen prose.',
    ]) {
      expect(texts(source)).toEqual(['A heading', 'Then prose.'])
    }
  })

  it('keeps offsets exact across a CRLF paragraph break', () => {
    const source = 'A heading\r\n\r\nThen prose.'
    for (const segment of segmentText(source)) {
      expect(source.slice(segment.start, segment.end)).toBe(segment.text)
    }
  })

  it('ignores blank input without producing empty segments', () => {
    expect(segmentText('   \n\n  ')).toEqual([])
    expect(segmentText('')).toEqual([])
  })

  it('renders one numbered line per segment', () => {
    expect(renderSegments(segmentText('One. Two.'))).toBe('[1] One.\n[2] Two.')
  })
})

describe('segment resolution', () => {
  const segments = segmentText('Alpha one. Beta two. Gamma three. Delta four.')

  it('resolves citations to exact source text in source order', () => {
    expect(resolveSegments(segments, [2, 1]).text).toBe('Alpha one. Beta two.')
  })

  it('marks a gap between non-adjacent citations', () => {
    expect(resolveSegments(segments, [1, 4]).text).toBe('Alpha one. ... Delta four.')
  })

  it('de-duplicates repeated citations', () => {
    expect(resolveSegments(segments, [3, 3, 3]).indexes).toEqual([3])
  })

  it('reports out-of-range citations instead of inventing text', () => {
    const resolved = resolveSegments(segments, [2, 99, 0])
    expect(resolved.indexes).toEqual([2])
    expect(resolved.invalid).toEqual([0, 99])
    expect(resolved.text).toBe('Beta two.')
  })

  it('returns empty text when nothing valid was cited', () => {
    expect(resolveSegments(segments, [42]).text).toBe('')
  })
})

/**
 * Numbering a record teaches the model that a sentence looks like
 * `[16] He is waiting.`, so it writes replacements the same way. The marker is
 * presentation and must never reach stored content.
 */
describe('stripSegmentMarker', () => {
  it('removes the marker renderSegments adds, and nothing else', () => {
    const rendered = renderSegments(segmentText('Alpha one. Beta two.'))
    for (const line of rendered.split('\n')) {
      expect(stripSegmentMarker(line)).not.toMatch(/^\[\d+\]/)
    }
    expect(stripSegmentMarker('[16] He is deceased.')).toBe('He is deceased.')
    expect(stripSegmentMarker('  [3]   Spacing survives the trim.')).toBe('Spacing survives the trim.')
  })

  it('leaves prose that merely begins with a bracket alone', () => {
    expect(stripSegmentMarker('[redacted] was struck from the record.')).toBe('[redacted] was struck from the record.')
    expect(stripSegmentMarker('He is waiting.')).toBe('He is waiting.')
    // Only the leading marker goes; a citation inside the sentence is content.
    expect(stripSegmentMarker('[2] See [4] for the rest.')).toBe('See [4] for the rest.')
  })
})
