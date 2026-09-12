import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { WorkspaceHeader, WorkspaceTitle } from '@/components/ui/workspace'
import { SettingsPanel } from './SettingsPanel'
import type { StoryMeta } from '@/lib/api'

interface SettingsViewProps {
  storyId: string
  story: StoryMeta
  visible: boolean
  onClose: () => void
  onTransitionEnd: () => void
  onManageProviders: () => void
  onOpenPluginPanel?: (pluginName: string) => void
  onTogglePluginSidebar?: (pluginName: string, visible: boolean) => void
  pluginSidebarVisibility?: Record<string, boolean>
}

interface TocItem {
  id: string
  label: string
  group: string
}

/**
 * Settings as a left-docked half-page overlay (covers the story sidebar), with a
 * sticky table of contents that scroll-spies the section in view. Used in place
 * of the inline detail panel because there are now too many settings to scroll.
 */
export function SettingsView({
  storyId,
  story,
  visible,
  onClose,
  onTransitionEnd,
  onManageProviders,
  onOpenPluginPanel,
  onTogglePluginSidebar,
  pluginSidebarVisibility,
}: SettingsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Suppress scroll-spy briefly after an explicit TOC click so a near-bottom
  // section (which can't scroll to the top band) stays the active one.
  const clickLockRef = useRef(0)
  const [toc, setToc] = useState<TocItem[]>([])
  const [activeId, setActiveId] = useState('')

  // Build the TOC from the rendered sections and scroll-spy the active one.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    let sections: HTMLElement[] = []

    const refreshToc = () => {
      sections = Array.from(root.querySelectorAll<HTMLElement>('[data-toc]'))
      setToc(sections.map((s) => ({ id: s.id, label: s.dataset.toc || s.id, group: s.dataset.tocGroup || '' })))
      setActiveId((prev) => {
        if (prev && sections.some((s) => s.id === prev)) return prev
        return sections[0]?.id || ''
      })
    }

    const atBottom = () => root.scrollTop + root.clientHeight >= root.scrollHeight - 4

    const resolveActive = () => {
      if (Date.now() < clickLockRef.current) return
      const lastId = sections[sections.length - 1]?.id
      // When scrolled to the very end, the last section is active.
      if (atBottom() && lastId) { setActiveId(lastId); return }
      // Otherwise: the last section whose top has passed the activation line.
      const line = root.getBoundingClientRect().top + 80
      let current = sections[0]?.id
      for (const s of sections) {
        if (s.getBoundingClientRect().top - 1 <= line) current = s.id
        else break
      }
      if (current) setActiveId(current)
    }

    refreshToc()
    resolveActive()
    root.addEventListener('scroll', resolveActive, { passive: true })
    const observer = new MutationObserver(() => {
      refreshToc()
      resolveActive()
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      root.removeEventListener('scroll', resolveActive)
      observer.disconnect()
    }
  }, [])

  // Escape to close; focus the panel when it opens.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (visible) panelRef.current?.focus()
  }, [visible])

  const jump = (id: string) => {
    clickLockRef.current = Date.now() + 700
    setActiveId(id)
    scrollRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-cuelume-surface="bloom"
      data-cuelume-close="none"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 cursor-default bg-background/60 backdrop-blur-[2px] transition-opacity duration-200 motion-reduce:transition-none',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Left-docked panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        onTransitionEnd={(e) => { if (e.target === e.currentTarget) onTransitionEnd() }}
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-full flex-col border-r border-border/50 bg-panel shadow-[8px_0_40px_-12px_rgba(0,0,0,0.35)] outline-none',
          'sm:w-[min(46rem,55vw)]',
          'transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          visible ? 'translate-x-0' : '-translate-x-full',
        )}
        data-component-id="settings-view-root"
      >
        {/* Header */}
        <WorkspaceHeader>
          <WorkspaceTitle>Settings</WorkspaceTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </WorkspaceHeader>

        {/* Body: TOC + scrollable content */}
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Settings sections"
            className="hidden w-44 shrink-0 overflow-y-auto border-r border-border/30 p-2.5 sm:block"
          >
            {toc.map((item, i) => (
              <div key={item.id}>
                {item.group && item.group !== toc[i - 1]?.group && (
                  <div className="px-2.5 pb-1 pt-3.5 text-ui-label font-medium uppercase tracking-[0.13em] text-muted-foreground/55 first:pt-1">
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => jump(item.id)}
                  aria-current={activeId === item.id ? 'true' : undefined}
                  data-cuelume-toggle="page"
                  className={cn(
                    'block w-full rounded-md px-2.5 py-1.5 text-left text-ui-body transition-colors',
                    activeId === item.id
                      ? 'bg-primary/10 font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground/90',
                  )}
                >
                  {item.label}
                </button>
              </div>
            ))}
          </nav>

          <div
            ref={scrollRef}
            className="min-w-0 flex-1 overflow-y-auto"
            data-slot="settings-scroll"
          >
            <SettingsPanel
              storyId={storyId}
              story={story}
              onManageProviders={onManageProviders}
              onOpenPluginPanel={onOpenPluginPanel}
              onTogglePluginSidebar={onTogglePluginSidebar}
              pluginSidebarVisibility={pluginSidebarVisibility}
            />
            {/* Enough tail for the final compact section to become the active
                TOC item without turning every category into a full page. */}
            <div aria-hidden className="h-24" />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
