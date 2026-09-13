// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FragmentTextField } from '@/components/fragments/FragmentContentFields'

afterEach(cleanup)

describe('fragment Markdown preview', () => {
  it('renders saved Markdown and previews the current unsaved draft', () => {
    const onFreeze = vi.fn()

    function Editor() {
      const [content, setContent] = useState('**Initial** text')
      return createElement(FragmentTextField, {
        content,
        initialView: 'preview',
        frozenSections: [],
        editable: true,
        canFreeze: true,
        mutationPending: false,
        onChange: setContent,
        onFreeze,
        onUnfreeze: vi.fn(),
      })
    }

    const { container } = render(createElement(Editor))
    expect(container.querySelector('strong')?.textContent).toBe('Initial')
    expect(screen.getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: /freeze selected text/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Write' }))
    const textarea = screen.getByRole('textbox')
    expect((textarea as HTMLTextAreaElement).value).toBe('**Initial** text')
    fireEvent.change(textarea, { target: { value: '# Revised\n\n- first\n- second' } })

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(container.querySelector('h1')?.textContent).toBe('Revised')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Write' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('# Revised\n\n- first\n- second')
    expect(onFreeze).not.toHaveBeenCalled()
  })
})
