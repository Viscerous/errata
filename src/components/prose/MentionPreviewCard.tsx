import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Fragment } from '@/lib/api'
import { FragmentAvatar } from '@/components/shared/CharacterAvatar'
import { Badge } from '@/components/ui/badge'

const SCROLLBAR_HIDE_DELAY_MS = 700

type PreviewScrollState = {
  active: boolean
  atBottom: boolean
  canScroll: boolean
  thumbHeight: number
  thumbTop: number
}

export function MentionPreviewCard({
  fragment,
  mediaById,
}: {
  fragment: Fragment
  mediaById: Map<string, Fragment>
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const hideScrollbarTimerRef = useRef<number | null>(null)
  const [scrollState, setScrollState] = useState<PreviewScrollState>({
    active: false,
    atBottom: true,
    canScroll: false,
    thumbHeight: 0,
    thumbTop: 0,
  })

  const updateScrollState = useCallback((active: boolean) => {
    const body = bodyRef.current
    if (!body) return

    const { clientHeight, scrollHeight, scrollTop } = body
    const canScroll = scrollHeight > clientHeight + 1
    const scrollRange = Math.max(1, scrollHeight - clientHeight)
    const trackHeight = Math.max(1, clientHeight - 8)
    const thumbHeight = canScroll
      ? Math.max(20, Math.round((clientHeight / scrollHeight) * trackHeight))
      : 0
    const thumbTop = canScroll
      ? Math.round((scrollTop / scrollRange) * Math.max(0, trackHeight - thumbHeight))
      : 0
    const atBottom = !canScroll || scrollTop + clientHeight >= scrollHeight - 1

    setScrollState(previous => {
      if (
        previous.active === active &&
        previous.atBottom === atBottom &&
        previous.canScroll === canScroll &&
        previous.thumbHeight === thumbHeight &&
        previous.thumbTop === thumbTop
      ) {
        return previous
      }

      return {
        active,
        atBottom,
        canScroll,
        thumbHeight,
        thumbTop,
      }
    })
  }, [])

  const showScrollbar = useCallback(() => {
    if (hideScrollbarTimerRef.current !== null) {
      window.clearTimeout(hideScrollbarTimerRef.current)
    }

    updateScrollState(true)
    hideScrollbarTimerRef.current = window.setTimeout(() => {
      hideScrollbarTimerRef.current = null
      updateScrollState(false)
    }, SCROLLBAR_HIDE_DELAY_MS)
  }, [updateScrollState])

  useLayoutEffect(() => {
    updateScrollState(false)
  }, [fragment.content, updateScrollState])

  useEffect(() => {
    const body = bodyRef.current
    if (!body || !window.ResizeObserver) return

    const observer = new ResizeObserver(() => updateScrollState(false))
    observer.observe(body)

    return () => observer.disconnect()
  }, [updateScrollState])

  useEffect(() => () => {
    if (hideScrollbarTimerRef.current !== null) {
      window.clearTimeout(hideScrollbarTimerRef.current)
    }
  }, [])

  // Filter out internal tags (color=, etc.)
  const displayTags = fragment.tags
    .filter(t => !t.startsWith('color='))
    .slice(0, 3)

  return (
    <div className="flex max-h-[inherit] flex-col gap-2.5 p-3">
      {/* Header: avatar + name + description */}
      <div className="flex items-start gap-3">
        <FragmentAvatar fragment={fragment} mediaById={mediaById} size="lg" />
        <div className="flex-1 min-w-0">
          <div className="font-display text-sm tracking-tight text-popover-foreground">
            {fragment.name}
          </div>
          {fragment.description && (
            <p className="text-[0.6875rem] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
              {fragment.description}
            </p>
          )}
        </div>
      </div>

      {/* Content preview */}
      {fragment.content && (
        <div
          className={[
            'mention-preview-scroll-shell relative min-h-0',
            scrollState.canScroll && !scrollState.atBottom
              ? 'mention-preview-scroll-shell-fade'
              : '',
          ].join(' ')}
        >
          <div
            ref={bodyRef}
            onScroll={showScrollbar}
            className="mention-preview-scroll max-h-40 overflow-y-auto overscroll-contain pr-2 text-xs text-muted-foreground/80 leading-relaxed whitespace-pre-wrap"
          >
            {fragment.content}
          </div>
          {scrollState.canScroll && (
            <div
              aria-hidden="true"
              className={[
                'mention-preview-scrollbar',
                scrollState.active ? 'opacity-100' : 'opacity-0',
              ].join(' ')}
            >
              <div
                className="mention-preview-scrollbar-thumb"
                style={{
                  height: scrollState.thumbHeight,
                  transform: `translateY(${scrollState.thumbTop}px)`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Tags */}
      {displayTags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {displayTags.map(tag => (
            <Badge
              key={tag}
              variant="secondary"
              className="text-[0.625rem] px-1.5 py-0 h-4"
            >
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
