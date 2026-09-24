// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { anchorFromTextPosition, resolveCaretOffset } from '@/lib/prose-caret'

describe('resolveCaretOffset', () => {
  const source = '## The Void\n\nHe tried to open his eyes.\n\nThere was nothing to open them *with*.\n\nHe tried again.'
  // Rendered text drops the "## " and the "*" markers.
  const rendered = 'The Void\n\nHe tried to open his eyes.\n\nThere was nothing to open them with.\n\nHe tried again.'

  it('returns the start when there is no anchor', () => {
    expect(resolveCaretOffset(source, null)).toBe(0)
    expect(resolveCaretOffset(source, { word: '  ', renderedOffset: 5, renderedLength: rendered.length })).toBe(0)
  })

  it('finds a unique word despite markdown offsets shifting the text', () => {
    const offset = resolveCaretOffset(source, {
      word: 'with',
      renderedOffset: rendered.indexOf('with'),
      renderedLength: rendered.length,
    })
    expect(source.slice(offset, offset + 4)).toBe('with')
  })

  it('picks the occurrence closest to the proportional click position', () => {
    const second = rendered.lastIndexOf('tried')
    const offset = resolveCaretOffset(source, { word: 'tried', renderedOffset: second, renderedLength: rendered.length })
    expect(offset).toBe(source.lastIndexOf('tried'))

    const first = rendered.indexOf('tried')
    expect(resolveCaretOffset(source, { word: 'tried', renderedOffset: first, renderedLength: rendered.length }))
      .toBe(source.indexOf('tried'))
  })

  it('falls back to the proportional position when the word is not in the source', () => {
    const offset = resolveCaretOffset(source, { word: 'zebra', renderedOffset: rendered.length / 2, renderedLength: rendered.length })
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThan(source.length)
  })
})

describe('anchorFromTextPosition', () => {
  it('expands to the word under the offset and measures its rendered position', () => {
    const surface = document.createElement('div')
    surface.innerHTML = '<p>He tried to <em>open</em> his eyes.</p><p>Nothing came back.</p>'
    document.body.appendChild(surface)
    const em = surface.querySelector('em')!.firstChild!
    const anchor = anchorFromTextPosition(surface, em, 2)
    expect(anchor).toEqual({
      word: 'open',
      renderedOffset: 'He tried to '.length,
      renderedLength: 'He tried to open his eyes.Nothing came back.'.length,
    })

    const second = surface.querySelectorAll('p')[1]!.firstChild!
    const anchor2 = anchorFromTextPosition(surface, second, 'Nothing came'.length)
    expect(anchor2?.word).toBe('came')
    expect(anchor2?.renderedOffset).toBe('He tried to open his eyes.Nothing '.length)
    surface.remove()
  })

  it('returns null for nodes outside the surface', () => {
    const surface = document.createElement('div')
    const other = document.createElement('p')
    other.textContent = 'elsewhere'
    document.body.append(surface, other)
    expect(anchorFromTextPosition(surface, other.firstChild!, 1)).toBeNull()
    surface.remove(); other.remove()
  })
})
