// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProseViewToolbar } from '@/components/prose/ProseViewToolbar'

afterEach(cleanup)

describe('prose view toolbar', () => {
  it('groups mobile outline and view controls and keeps desktop collapse in the same bar', () => {
    const onOutlineOpenChange = vi.fn()
    const onMobileOutlineOpen = vi.fn()
    const onMainViewChange = vi.fn()
    const props = { hasOutline: true, onOutlineOpenChange, onMobileOutlineOpen, onMainViewChange }
    const { container, rerender } = render(createElement(ProseViewToolbar, { ...props, outlineOpen: false }))

    const toolbar = container.querySelector('[data-component-id="prose-view-toolbar"]')
    expect(toolbar).not.toBeNull()
    expect(toolbar?.querySelector('[data-component-id="prose-mobile-toc-trigger"]')).not.toBeNull()
    expect(toolbar?.querySelectorAll('[data-component-id="story-chat-switcher"]')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Open passages outline' }))
    expect(onMobileOutlineOpen).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Expand outline' }))
    expect(onOutlineOpenChange).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getAllByRole('button', { name: 'Character chat view' })[0])
    expect(onMainViewChange).toHaveBeenCalledWith('character-chat')

    rerender(createElement(ProseViewToolbar, { ...props, outlineOpen: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse outline' }))
    expect(onOutlineOpenChange).toHaveBeenCalledWith(false)
  })
})
