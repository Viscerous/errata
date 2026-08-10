import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatConfig } from '@/components/character-chat/ChatConfig'

function renderConfig(): string {
  return renderToStaticMarkup(React.createElement(ChatConfig, {
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

  it('uses an explicit mobile return-to-story affordance', () => {
    const html = renderConfig()
    const buttonStart = elementWithComponentId(html, 'character-chat-return-to-story')
    const button = html.slice(html.indexOf(buttonStart), html.indexOf('</button>', html.indexOf(buttonStart)))

    expect(buttonStart).toContain('aria-label="Return to story"')
    expect(buttonStart).toContain('title="Return to story"')
    expect(button).toContain('md:hidden')
    expect(button).toContain('md:block')
  })
})
