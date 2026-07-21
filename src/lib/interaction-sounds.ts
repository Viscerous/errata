import { useCallback, useEffect, useState } from 'react'
import {
  bind,
  play,
  setEnabled as setCuelumeEnabled,
  sounds,
  type SoundName,
} from 'cuelume'

export const INTERACTION_SOUNDS_STORAGE_KEY = 'errata-interaction-sounds'

const INTERACTION_SOUNDS_EVENT = 'errata-interaction-sounds-change'
const SURFACE_SELECTOR = '[data-cuelume-surface]'
const DISCLOSURE_SELECTOR = '[data-cuelume-disclosure]'
const SOUND_NAMES = new Set<string>(sounds)

interface StorageReader {
  getItem: (key: string) => string | null
}

function resolveSound(value: string | null, fallback: SoundName): SoundName {
  return value && SOUND_NAMES.has(value) ? value as SoundName : fallback
}

function collectMatches(node: Node, selector: string, matches: Set<Element>) {
  if (!(node instanceof Element)) return
  if (node.matches(selector)) matches.add(node)
  node.querySelectorAll(selector).forEach((element) => matches.add(element))
}

function getBrowserStorage(): StorageReader | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readInteractionSoundsPreference(
  storage: StorageReader | null = getBrowserStorage(),
): boolean {
  if (!storage) return true
  try {
    return storage.getItem(INTERACTION_SOUNDS_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

export function useInteractionSounds(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(readInteractionSoundsPreference)

  useEffect(() => {
    const handleChange = (event: Event) => {
      setEnabledState((event as CustomEvent<boolean>).detail)
    }
    window.addEventListener(INTERACTION_SOUNDS_EVENT, handleChange)
    return () => window.removeEventListener(INTERACTION_SOUNDS_EVENT, handleChange)
  }, [])

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next)
    try {
      localStorage.setItem(INTERACTION_SOUNDS_STORAGE_KEY, String(next))
    } catch {
      // The preference still applies for this session when storage is blocked.
    }
    window.dispatchEvent(new CustomEvent<boolean>(INTERACTION_SOUNDS_EVENT, { detail: next }))
  }, [])

  return [enabled, setEnabled]
}

export function InteractionSoundsController() {
  const [enabled] = useInteractionSounds()

  useEffect(() => {
    setCuelumeEnabled(enabled)
  }, [enabled])

  useEffect(() => {
    bind()

    const observer = new MutationObserver((records) => {
      const openedSurfaces = new Set<Element>()
      const closedSurfaces = new Set<Element>()
      let disclosureCue: SoundName | null = null

      for (const record of records) {
        if (record.type === 'childList') {
          record.addedNodes.forEach((node) => collectMatches(node, SURFACE_SELECTOR, openedSurfaces))
          record.removedNodes.forEach((node) => collectMatches(node, SURFACE_SELECTOR, closedSurfaces))
          continue
        }

        if (
          record.type === 'attributes'
          && record.target instanceof Element
          && record.target.matches(DISCLOSURE_SELECTOR)
        ) {
          disclosureCue = record.target.getAttribute('aria-expanded') === 'true'
            ? 'bloom'
            : 'droplet'
        }
      }

      const openedSurface = openedSurfaces.values().next().value
      const closedSurface = Array.from(closedSurfaces).find(
        (surface) => surface.getAttribute('data-cuelume-close') !== 'none',
      )
      if (openedSurface) {
        play(resolveSound(openedSurface.getAttribute('data-cuelume-surface'), 'bloom'))
      } else if (closedSurface) {
        play(resolveSound(closedSurface.getAttribute('data-cuelume-close'), 'droplet'))
      } else if (disclosureCue) {
        play(disclosureCue)
      }
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded'],
    })

    return () => observer.disconnect()
  }, [])

  return null
}
