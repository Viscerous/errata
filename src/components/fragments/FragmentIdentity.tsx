import type { ReactNode } from 'react'
import type { Fragment } from '@/lib/api'
import { generateBubbles, resolveFragmentVisual } from '@/lib/fragment-visuals'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Metric } from '@/components/ui/prose-text'
import { FragmentBubbleShape } from './FragmentBubbleShape'

interface FragmentArtworkProps {
  fragment: Fragment
  mediaById: Map<string, Fragment>
  className?: string
}

export function FragmentArtwork({ fragment, mediaById, className }: FragmentArtworkProps) {
  const visual = resolveFragmentVisual(fragment, mediaById)
  const boundary = visual.boundary

  if (visual.imageUrl) {
    const cropped = boundary && boundary.width < 1 && boundary.height < 1
    return (
      <div
        className={cn('size-9 shrink-0 overflow-hidden rounded-lg border border-border/40 bg-muted', className)}
        style={cropped ? {
          backgroundImage: `url("${visual.imageUrl}")`,
          backgroundSize: `${100 / boundary.width}% ${100 / boundary.height}%`,
          backgroundPosition: `${boundary.width < 1 ? (boundary.x / (1 - boundary.width)) * 100 : 50}% ${boundary.height < 1 ? (boundary.y / (1 - boundary.height)) * 100 : 50}%`,
        } : undefined}
      >
        {!cropped && <img src={visual.imageUrl} alt="" className="size-full object-cover" />}
      </div>
    )
  }

  const bubbleSet = generateBubbles(fragment.id, fragment.type)
  return (
    <div className={cn('size-9 shrink-0 overflow-hidden rounded-lg', className)}>
      <svg viewBox="0 0 36 36" className="size-full" aria-hidden>
        <rect width="36" height="36" fill={bubbleSet.bg} />
        {bubbleSet.bubbles.map((bubble) => (
          <FragmentBubbleShape key={`${bubble.cx}-${bubble.cy}`} bubble={bubble} />
        ))}
      </svg>
    </div>
  )
}

interface FragmentMetadataProps {
  fragment: Fragment
  showType?: boolean
  typeControl?: ReactNode
  className?: string
}

export function FragmentMetadata({
  fragment,
  showType = true,
  typeControl,
  className,
}: FragmentMetadataProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <Metric className="truncate font-mono">{fragment.id}</Metric>
      {fragment.sticky && <Badge variant="secondary" className="h-4 px-1 text-ui-label">pinned</Badge>}
      {fragment.sticky && fragment.placement === 'system' && (
        <Badge variant="outline" className="h-4 px-1 text-ui-label">system</Badge>
      )}
      {typeControl ?? (showType && (
        <Badge variant="outline" className="h-4 px-1 text-ui-label">{fragment.type}</Badge>
      ))}
    </div>
  )
}
