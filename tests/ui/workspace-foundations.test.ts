import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PassageListItem } from '@/components/prose/PassageListItem'
import { SettingsGroup, SettingsSection } from '@/components/settings/primitives'
import { WorkspaceHeader, WorkspaceTitle } from '@/components/ui/workspace'
import type { Fragment } from '@/lib/api'

const fragment: Fragment = {
  id: 'pr-one',
  type: 'prose',
  name: '',
  description: 'Opening passage',
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
}

describe('workspace foundations', () => {
  it('gives shared passage rows navigation semantics', () => {
    const html = renderToStaticMarkup(createElement(PassageListItem, {
      fragment,
      number: 1,
      active: true,
      meta: '4w',
    }))

    expect(html).toContain('aria-current="location"')
    expect(html).toContain('Opening passage')
    expect(html).toContain('Once upon a time.')
  })

  it('keeps settings categories content-sized', () => {
    const html = renderToStaticMarkup(createElement(SettingsSection, {
      id: 'appearance',
      label: 'Appearance',
      group: 'Interface',
      children: 'Settings',
    }))

    expect(html).toContain('data-toc="Appearance"')
    expect(html).not.toContain('min-h-[80vh]')
    expect(html).not.toContain('snap-start')
  })

  it('gives nested settings one shared group treatment', () => {
    const html = renderToStaticMarkup(createElement(SettingsGroup, {
      title: 'Context',
      description: 'What the model can read.',
      children: createElement('div', null, 'Controls'),
    }))

    expect(html).toContain('Context')
    expect(html).toContain('What the model can read.')
    expect(html).toContain('bg-panel-muted/60')
  })

  it('uses one semantic header treatment', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceHeader, null, createElement(WorkspaceTitle, null, 'Editor')),
    )

    expect(html).toContain('data-slot="workspace-header"')
    expect(html).toContain('data-slot="workspace-title"')
  })
})
