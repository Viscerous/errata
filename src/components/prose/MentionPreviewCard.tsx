import type { Fragment } from '@/lib/api'
import { FragmentAvatar } from '@/components/shared/CharacterAvatar'
import { Badge } from '@/components/ui/badge'

export function MentionPreviewCard({
  fragment,
  mediaById,
}: {
  fragment: Fragment
  mediaById: Map<string, Fragment>
}) {
  // Filter out internal tags (color=, etc.)
  const displayTags = fragment.tags
    .filter(t => !t.startsWith('color='))
    .slice(0, 3)

  return (
    <div className="flex flex-col gap-2.5 p-3">
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
        <div className="relative">
          <p className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-3 mention-preview-fade">
            {fragment.content}
          </p>
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
