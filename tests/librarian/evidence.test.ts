import { describe, expect, it } from 'vitest'
import { evidenceAppearsInText, normalizeEvidenceText } from '@/server/librarian/evidence'

describe('Librarian evidence matching', () => {
  it('normalizes typography and whitespace without changing words', () => {
    const source = 'Alice says, “The key is gone.”\n\nBob answers — quietly.'
    const evidence = 'Alice says, "The key is gone." Bob answers - quietly.'

    expect(evidenceAppearsInText(source, evidence)).toBe(true)
    expect(normalizeEvidenceText('‘One’\u00a0—\u00a0“Two”')).toBe('one - two')
  })

  it('ignores presentation-only casing, emphasis, and quote delimiters', () => {
    const source = 'Victoria said, “You are Ground.” Then she *loved* the answer.'

    expect(evidenceAppearsInText(source, "victoria said, 'you are *ground*.'" )).toBe(true)
    expect(evidenceAppearsInText(source, 'Then she loved the answer.')).toBe(true)
  })

  it('accepts substantial verbatim spans separated by an ellipsis in source order', () => {
    const source = 'Alice crossed the crowded north hall, stopped beneath the clock, and took the iron key.'

    expect(evidenceAppearsInText(source, 'Alice crossed the crowded north hall ... and took the iron key.')).toBe(true)
    expect(evidenceAppearsInText(source, 'Alice crossed … beneath the clock … the iron key.')).toBe(true)
    expect(evidenceAppearsInText(source, 'Alice crossed the crowded north hall ...')).toBe(true)
  })

  it('rejects paraphrases, reversed spans, and keyword-sized ellipsis anchors', () => {
    const source = 'Alice crossed the crowded north hall and took the iron key.'

    expect(evidenceAppearsInText(source, 'Alice walked through the hall and collected the key.')).toBe(false)
    expect(evidenceAppearsInText(source, 'iron key ... Alice crossed')).toBe(false)
    expect(evidenceAppearsInText(source, 'the ... key')).toBe(false)
  })
})
