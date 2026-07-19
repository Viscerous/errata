import { useCallback, useState } from 'react'
import type { Fragment } from '@/lib/api'
import { notifyPluginPanelClose, notifyPluginPanelOpen } from '@/lib/plugin-panels'

export type WorkspaceSurface =
  | { kind: 'story-setup' }
  | { kind: 'debug'; logId: string }
  | { kind: 'providers' }
  | { kind: 'export' }
  | { kind: 'prose-editor'; fragmentId: string; selectionText: string | null }
  | { kind: 'fragment-editor'; fragment: Fragment; mode: 'edit' }
  | null

function surfacesEqual(current: WorkspaceSurface, next: WorkspaceSurface): boolean {
  if (current === null || next === null) return current === next
  if (current.kind !== next.kind) return false

  switch (current.kind) {
    case 'story-setup':
    case 'providers':
    case 'export':
      return true
    case 'debug':
      return next.kind === 'debug' && current.logId === next.logId
    case 'prose-editor':
      return next.kind === 'prose-editor'
        && current.fragmentId === next.fragmentId
        && current.selectionText === next.selectionText
    case 'fragment-editor':
      return next.kind === 'fragment-editor'
        && current.fragment.id === next.fragment.id
        && current.mode === next.mode
  }
}

function notifySurfaceClosed(surface: Exclude<WorkspaceSurface, null>, storyId: string): void {
  switch (surface.kind) {
    case 'story-setup':
      notifyPluginPanelClose({ panel: 'wizard' }, { storyId })
      break
    case 'debug':
      notifyPluginPanelClose({ panel: 'debug' }, { storyId })
      break
    case 'providers':
      notifyPluginPanelClose({ panel: 'providers' }, { storyId })
      break
    case 'export':
      notifyPluginPanelClose({ panel: 'export' }, { storyId })
      break
    case 'fragment-editor':
      notifyPluginPanelClose({ panel: 'fragment-editor' }, { storyId })
      break
    case 'prose-editor':
      break
  }
}

function notifySurfaceOpened(surface: Exclude<WorkspaceSurface, null>, storyId: string): void {
  switch (surface.kind) {
    case 'story-setup':
      notifyPluginPanelOpen({ panel: 'wizard' }, { storyId })
      break
    case 'debug':
      notifyPluginPanelOpen({ panel: 'debug' }, { storyId })
      break
    case 'providers':
      notifyPluginPanelOpen({ panel: 'providers' }, { storyId })
      break
    case 'export':
      notifyPluginPanelOpen({ panel: 'export' }, { storyId })
      break
    case 'fragment-editor':
      notifyPluginPanelOpen(
        { panel: 'fragment-editor', fragment: surface.fragment, mode: surface.mode },
        { storyId },
      )
      break
    case 'prose-editor':
      break
  }
}

export function useWorkspaceSurface(storyId: string) {
  const [surface, setSurface] = useState<WorkspaceSurface>(null)

  const transition = useCallback((next: WorkspaceSurface) => {
    if (surfacesEqual(surface, next)) return
    if (surface) notifySurfaceClosed(surface, storyId)
    setSurface(next)
    if (next) notifySurfaceOpened(next, storyId)
  }, [storyId, surface])

  const updateProseFragment = useCallback((fragmentId: string) => {
    setSurface(current => current?.kind === 'prose-editor'
      ? { ...current, fragmentId }
      : current)
  }, [])

  const updateFragment = useCallback((fragment: Fragment) => {
    setSurface(current => current?.kind === 'fragment-editor'
      ? { ...current, fragment }
      : current)
  }, [])

  return { surface, transition, updateFragment, updateProseFragment }
}
