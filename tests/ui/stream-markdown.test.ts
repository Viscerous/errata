// @vitest-environment jsdom
import { createElement } from 'react'
import { render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StreamMarkdown } from '@/components/ui/stream-markdown'

describe('StreamMarkdown', () => {
  it('resolves inline markdown while streaming', () => {
    const html = renderToStaticMarkup(createElement(StreamMarkdown, {
      content: 'This is **important** and _live_.',
      streaming: true,
    }))

    expect(html).toContain('<strong')
    expect(html).toContain('important')
    expect(html).toContain('<em')
    expect(html).toContain('live')
  })

  it('reveals streaming text inline and keeps the cursor at the rendered tail', () => {
    const html = renderToStaticMarkup(createElement(StreamMarkdown, {
      content: 'This is **important** and _live_.',
      streaming: true,
    }))

    expect(html).toContain('stream-markdown-reveal')
    expect(html).toContain('stream-markdown-cursor')
    expect(html.indexOf('stream-markdown-cursor')).toBeGreaterThan(html.lastIndexOf('stream-markdown-reveal'))
  })

  it('does not add streaming reveal or cursor markup after generation settles', () => {
    const html = renderToStaticMarkup(createElement(StreamMarkdown, {
      content: 'This is **important** and _settled_.',
    }))

    expect(html).not.toContain('stream-markdown-reveal')
    expect(html).not.toContain('stream-markdown-cursor')
  })

  it('keeps earlier appended text in the reveal window on the next stream tick', () => {
    const { container, rerender } = render(createElement(StreamMarkdown, {
      content: 'First',
      streaming: true,
    }))

    rerender(createElement(StreamMarkdown, {
      content: 'First second',
      streaming: true,
    }))

    const revealText = Array
      .from(container.querySelectorAll('.stream-markdown-reveal'))
      .map(element => element.textContent ?? '')
      .join('')

    expect(revealText).toContain('First')
    expect(revealText).toContain('second')
  })

  it('renders GitHub-flavored markdown tables', () => {
    const html = renderToStaticMarkup(createElement(StreamMarkdown, {
      content: [
        '| Character | Status |',
        '| --- | --- |',
        '| Mira | Missing |',
      ].join('\n'),
    }))

    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('Character')
    expect(html).toContain('<td')
    expect(html).toContain('Missing')
  })

  it('renders GitHub-flavored markdown tables while streaming', () => {
    const html = renderToStaticMarkup(createElement(StreamMarkdown, {
      content: [
        '| Character | Status |',
        '| --- | --- |',
        '| Mira | Missing |',
      ].join('\n'),
      streaming: true,
    }))

    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('Character')
    expect(html).toContain('<td')
    expect(html).toContain('Missing')
  })
})
