import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatConfig } from '@/components/character-chat/ChatConfig'
import { StoryChatSwitcher } from '@/components/shared/StoryChatSwitcher'

function renderConfig(historyOpen = false, mobileMenuTrigger?: React.ReactNode): string {
  return renderToStaticMarkup(React.createElement(ChatConfig, {
    mobileMenuTrigger,
    characters: [],
    selectedCharacterId: null,
    onCharacterChange: vi.fn(),
    persona: { type: 'stranger' },
    onPersonaChange: vi.fn(),
    proseChain: null,
    proseFragments: [],
    storyPointId: null,
    onStoryPointChange: vi.fn(),
    onShowConversations: vi.fn(),
    historyOpen,
    onClose: vi.fn(),
    mediaById: new Map(),
  }))
}

function elementWithComponentId(html: string, componentId: string): string {
  const element = html.match(new RegExp(`<[^>]+data-component-id="${componentId}"[^>]*>`))?.[0]
  if (!element) throw new Error(`Missing component ${componentId}`)
  return element
}

describe('character chat config', () => {
  it('keeps chat navigation pinned while selectors contract', () => {
    const html = renderConfig()
    const selectors = elementWithComponentId(html, 'character-chat-config-selectors')
    const actions = elementWithComponentId(html, 'character-chat-config-actions')

    expect(selectors).toContain('min-w-0')
    expect(selectors).toContain('flex-1')
    expect(selectors).toContain('overflow-hidden')
    expect(actions).toContain('shrink-0')
  })

  it('places the mobile menu in the chat header flow', () => {
    const html = renderConfig(false, React.createElement('button', { 'data-component-id': 'mobile-menu-trigger' }, 'Menu'))
    const header = html.match(/<div[^>]+data-component-id="character-chat-config"[^>]*>[\s\S]*?<div[^>]+data-component-id="character-chat-config-selectors"/)?.[0]
    expect(header).toContain('data-component-id="mobile-menu-trigger"')
  })

  it('keeps Story and Chat navigation available in the chat header', () => {
    const html = renderConfig()
    expect(html).toContain('data-component-id="story-chat-switcher"')
    expect(html).toContain('aria-label="Story view"')
    expect(html).toContain('aria-label="Character chat view"')
    expect(html).not.toContain('character-chat-return-to-story')
  })

  it('marks History as selected only while that subview is open', () => {
    expect(renderConfig(false)).toContain('aria-label="Previous conversations" aria-pressed="false"')
    expect(renderConfig(true)).toContain('aria-label="Previous conversations" aria-pressed="true"')
  })

  it('compacts the shared switcher without losing accessible view names', () => {
    const html = renderToStaticMarkup(React.createElement(StoryChatSwitcher, {
      value: 'prose',
      onChange: vi.fn(),
      compact: true,
    }))
    expect(html).toContain('aria-label="Story view"')
    expect(html).toContain('aria-label="Character chat view"')
    expect(html).not.toContain('>Story</span>')
    expect(html).not.toContain('>Chat</span>')
    expect(html).toContain('size-7')
  })
})
