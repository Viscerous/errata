// @vitest-environment jsdom
import { createElement } from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProseInlineEditor } from '@/components/prose/ProseInlineEditor'
import { ProseBlock } from '@/components/prose/ProseBlock'
import { ConfirmProvider } from '@/components/ui/confirm-dialog'
import type { Fragment } from '@/lib/api'

const updateMock = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...mod,
    api: {
      ...mod.api,
      fragments: { ...mod.api.fragments, update: (...args: unknown[]) => updateMock(...args) },
      stories: { ...mod.api.stories, get: vi.fn().mockResolvedValue({ settings: {} }) },
    },
  }
})

function makeFragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: 'pr-abcd',
    type: 'prose',
    name: 'Opening',
    description: 'A beginning',
    content: 'Once upon a time.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
    meta: {},
    archived: false,
    ...overrides,
  }
}

beforeEach(() => {
  updateMock.mockReset()
  updateMock.mockResolvedValue(makeFragment())
})

describe('ProseInlineEditor', () => {
  it('starts from the fragment content and saves on Ctrl+Enter', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(createElement(ProseInlineEditor, { content: 'Once.', onSave, onCancel }))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('Once.')

    fireEvent.change(textarea, { target: { value: 'Twice.' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(onSave).toHaveBeenCalledWith('Twice.')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels on Escape and treats an unchanged save as cancel', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(createElement(ProseInlineEditor, { content: 'Once.', onSave, onCancel }))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(onSave).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('ProseInlineEditor click-away', () => {
  it('saves a dirty draft when the reader clicks outside the passage', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(createElement(ProseInlineEditor, { content: 'Once.', onSave, onCancel }))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Twice.' } })

    // Clicks inside the editor chrome do nothing
    fireEvent.mouseDown(textarea)
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.mouseDown(document.body)
    expect(onSave).toHaveBeenCalledWith('Twice.')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('just closes when the draft is unchanged', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(createElement(ProseInlineEditor, { content: 'Once.', onSave, onCancel }))
    fireEvent.mouseDown(document.body)
    expect(onSave).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores outside clicks while a save is in flight', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(createElement(ProseInlineEditor, { content: 'Once.', saving: true, onSave, onCancel }))
    fireEvent.mouseDown(document.body)
    expect(onSave).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('ProseBlock double-click editing', () => {
  function renderBlock(fragment = makeFragment()) {
    const client = new QueryClient()
    return render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          ConfirmProvider,
          null,
          createElement(ProseBlock, {
            storyId: 's1',
            fragment,
            displayIndex: 0,
            sectionIndex: 0,
            chainEntry: null,
            isLast: true,
            onSelect: () => {},
            quickSwitch: false,
          }),
        ),
      ),
    )
  }

  it('opens the inline editor on double-click and saves edited content', async () => {
    const { container } = renderBlock()
    expect(container.querySelector('[data-component-id="prose-inline-editor"]')).toBeNull()

    const surface = container.querySelector('[data-component-id="prose-pr-abcd-select"]') as HTMLElement
    fireEvent.doubleClick(surface)

    const textarea = container.querySelector('[data-component-id="prose-inline-editor"] textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.value).toBe('Once upon a time.')
    // Double-click must not leave the action toolbar open underneath the editor
    expect(container.querySelector('[data-component-id="prose-block-actions"]')).toBeNull()

    fireEvent.change(textarea, { target: { value: 'Once upon a rewritten time.' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith('s1', 'pr-abcd', {
        name: 'Opening',
        description: 'A beginning',
        content: 'Once upon a rewritten time.',
      })
    })
    // Editor closes once the save resolves and the passage renders again
    await waitFor(() => {
      expect(container.querySelector('[data-component-id="prose-inline-editor"]')).toBeNull()
    })
    expect(container.querySelector('[data-component-id="prose-pr-abcd-select"]')).not.toBeNull()
  })

  it('closes without saving on Escape', () => {
    const { container } = renderBlock()
    const surface = container.querySelector('[data-component-id="prose-pr-abcd-select"]') as HTMLElement
    fireEvent.doubleClick(surface)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(container.querySelector('[data-component-id="prose-inline-editor"]')).toBeNull()
    expect(updateMock).not.toHaveBeenCalled()
  })
})

describe('ProseBlock action toolbar placement', () => {
  it('opens just below the click point, so the second click of a double-click lands on the prose', () => {
    const client = new QueryClient()
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          ConfirmProvider,
          null,
          createElement(ProseBlock, {
            storyId: 's1',
            fragment: makeFragment(),
            displayIndex: 0,
            sectionIndex: 0,
            chainEntry: null,
            isLast: true,
            onSelect: () => {},
            quickSwitch: false,
          }),
        ),
      ),
    )
    const surface = container.querySelector('[data-component-id="prose-pr-abcd-select"]') as HTMLElement
    fireEvent.click(surface, { clientY: 300 })
    const toolbar = container.querySelector('[data-component-id="prose-block-actions"]') as HTMLElement
    expect(toolbar).not.toBeNull()
    expect(toolbar.style.top).toBe('308px')
  })
})
