import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  INTERACTION_SOUNDS_STORAGE_KEY,
  readInteractionSoundsPreference,
} from '../../src/lib/interaction-sounds'

describe('interaction sound preference', () => {
  it('starts enabled when no preference has been saved', () => {
    const storage = { getItem: () => null }

    expect(readInteractionSoundsPreference(storage)).toBe(true)
  })

  it('honors an explicit disabled preference', () => {
    const storage = {
      getItem: (key: string) => key === INTERACTION_SOUNDS_STORAGE_KEY ? 'false' : null,
    }

    expect(readInteractionSoundsPreference(storage)).toBe(false)
  })

  it('falls back to enabled when storage is unavailable', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage blocked')
      },
    }

    expect(readInteractionSoundsPreference(storage)).toBe(true)
  })
})

describe('shared interaction sound coverage', () => {
  it('wires the controller and shared controls declaratively', () => {
    const rootSource = readFileSync('src/routes/__root.tsx', 'utf8')
    const buttonSource = readFileSync('src/components/ui/button.tsx', 'utf8')
    const checkboxSource = readFileSync('src/components/ui/checkbox.tsx', 'utf8')
    const tabsSource = readFileSync('src/components/ui/tabs.tsx', 'utf8')
    const settingsSource = readFileSync('src/components/settings/primitives.tsx', 'utf8')
    const interactionSource = readFileSync('src/lib/interaction-sounds.ts', 'utf8')
    const dialogSource = readFileSync('src/components/ui/dialog.tsx', 'utf8')
    const sheetSource = readFileSync('src/components/ui/sheet.tsx', 'utf8')
    const collapsibleSource = readFileSync('src/components/ui/collapsible.tsx', 'utf8')
    const detailPanelSource = readFileSync('src/components/sidebar/DetailPanel.tsx', 'utf8')
    const settingsViewSource = readFileSync('src/components/sidebar/SettingsView.tsx', 'utf8')
    const sidebarSource = readFileSync('src/components/ui/sidebar.tsx', 'utf8')
    const dropdownSource = readFileSync('src/components/ui/dropdown-menu.tsx', 'utf8')
    const storyLibrarySource = readFileSync('src/routes/index.tsx', 'utf8')

    expect(rootSource).toContain('<InteractionSoundsController />')
    expect(buttonSource).toContain('data-cuelume-press')
    expect(buttonSource).toContain('data-cuelume-release')
    expect(checkboxSource).toContain('data-cuelume-toggle')
    expect(tabsSource).toContain('data-cuelume-toggle')
    expect(settingsSource).toContain('data-cuelume-toggle')
    expect(interactionSource).toContain('MutationObserver')
    expect(interactionSource).toContain('[data-cuelume-surface]')
    expect(interactionSource).toContain('[data-cuelume-disclosure]')
    expect(dialogSource).toContain('data-cuelume-surface="bloom"')
    expect(sheetSource).toContain('data-cuelume-surface="bloom"')
    expect(sheetSource).toContain("data-cuelume-close={silentClose ? 'none' : undefined}")
    expect(collapsibleSource).toContain('data-cuelume-disclosure=""')
    expect(detailPanelSource).toContain('data-cuelume-surface="bloom"')
    expect(detailPanelSource).toContain('data-cuelume-close="none"')
    expect(settingsViewSource).toContain('data-cuelume-surface="bloom"')
    expect(settingsViewSource).toContain('data-cuelume-close="none"')
    expect(interactionSource).toContain("getAttribute('data-cuelume-close') !== 'none'")
    expect(sidebarSource).toContain('data-cuelume-toggle="press"')
    expect(sidebarSource).not.toContain('data-cuelume-hover')
    expect(dropdownSource).not.toContain('data-cuelume-hover')
    expect(storyLibrarySource).not.toContain('data-cuelume-hover')
  })
})
