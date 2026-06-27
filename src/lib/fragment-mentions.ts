import { type ReactNode, createElement, Children, isValidElement, cloneElement } from 'react'
import { hashString, CHARACTER_MENTION_COLORS, KNOWLEDGE_MENTION_COLORS } from './fragment-visuals'
import { MentionSpan } from '@/components/prose/MentionSpan'

export interface Annotation {
  type: string
  fragmentId: string
  text: string
}

function colorForId(fragmentId: string): string {
  if (fragmentId.startsWith('kn-')) {
    const idx = Math.abs(hashString(fragmentId)) % KNOWLEDGE_MENTION_COLORS.length
    return KNOWLEDGE_MENTION_COLORS[idx]
  }
  const idx = Math.abs(hashString(fragmentId)) % CHARACTER_MENTION_COLORS.length
  return CHARACTER_MENTION_COLORS[idx]
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeMentionText(text: string): string {
  return text.trim().toLowerCase()
}

export function buildAnnotationHighlighter(
  annotations: Annotation[],
  onClick: (fragmentId: string) => void,
  colorOverrides?: Map<string, string>,
): ((text: string) => ReactNode) | null {
  const mentions = annotations.filter(a => a.type === 'mention' && a.fragmentId && a.text.trim())
  if (mentions.length === 0) return null

  // Deduplicate by text (case-insensitive), keep longest first
  const seen = new Set<string>()
  const unique: Annotation[] = []
  // Sort longest-first so longer names match before shorter substrings
  const sorted = [...mentions].sort((a, b) => b.text.length - a.text.length)
  for (const m of sorted) {
    const key = normalizeMentionText(m.text)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(m)
  }
  if (unique.length === 0) return null

  // Build a map from lowercase text -> annotation for lookup
  const textMap = new Map<string, Annotation>()
  for (const m of unique) {
    textMap.set(normalizeMentionText(m.text), m)
  }

  // Match whole terms without relying on \b, which fails for terms like C++ or #13.
  const pattern = unique.map(m => escapeRegex(m.text.trim())).join('|')
  const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])(${pattern})(?=$|[^\\p{L}\\p{N}_])`, 'giu')

  return (text: string): ReactNode => {
    const parts: ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    // Reset regex state
    regex.lastIndex = 0

    while ((match = regex.exec(text)) !== null) {
      const prefix = match[1] ?? ''
      const matchedText = match[2] ?? ''
      if (!matchedText) {
        regex.lastIndex += 1
        continue
      }
      const matchStart = match.index + prefix.length
      const annotation = textMap.get(normalizeMentionText(matchedText))
      if (!annotation) continue

      // Add text before match
      if (matchStart > lastIndex) {
        parts.push(text.slice(lastIndex, matchStart))
      }

      const color = colorOverrides?.get(annotation.fragmentId) ?? colorForId(annotation.fragmentId)
      parts.push(
        createElement(
          MentionSpan,
          {
            key: `${matchStart}-${matchedText}`,
            fragmentId: annotation.fragmentId,
            className: 'mention-highlight',
            style: { color },
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation()
              onClick(annotation.fragmentId)
            },
            role: 'button',
            tabIndex: 0,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                e.preventDefault()
                onClick(annotation.fragmentId)
              }
            },
          },
          matchedText,
        ),
      )

      lastIndex = matchStart + matchedText.length
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex))
    }

    // If no matches found, return original text
    if (parts.length === 0) return text

    return parts
  }
}

/**
 * Strip markdown emphasis markers (* and _) from inside dialogue quotes
 * so that markdown parsing doesn't split dialogue across element boundaries.
 * e.g. `"I don't *really* know"` → `"I don't really know"`
 *
 * Since the entire dialogue is wrapped in `<em>` by `formatDialogue`,
 * inner emphasis is redundant and can be safely removed.
 */
export function stripEmphasisInDialogue(content: string): string {
  return content.replace(/[""\u201c](?:[^""\u201c\u201d])*?[""\u201d]/g, (dialogue) =>
    dialogue.replace(/(\*{1,3}|_{1,3})(.+?)\1/g, '$2'),
  )
}

/** Italicize dialogue enclosed in double quotes (ASCII " or curly \u201c\u201d) */
export function formatDialogue(text: string): ReactNode {
  const regex = /[""\u201c](?:[^""\u201c\u201d])*?[""\u201d]/g
  let lastIndex = 0
  const parts: ReactNode[] = []
  let key = 0

  for (const match of text.matchAll(regex)) {
    const start = match.index!
    if (start > lastIndex) parts.push(text.slice(lastIndex, start))
    parts.push(createElement('em', { key: key++, className: 'prose-dialogue' }, match[0]))
    lastIndex = start + match[0].length
  }

  if (parts.length === 0) return text
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts
}

/** Compose two text transforms: apply `first`, then apply `second` to any remaining string children */
export function composeTextTransforms(
  first: (text: string) => ReactNode,
  second: (text: string) => ReactNode,
): (text: string) => ReactNode {
  return (text: string) => {
    const result = first(text)
    if (typeof result === 'string') return second(result)
    return applyToStringChildren(result, second)
  }
}

function applyToStringChildren(node: ReactNode, transform: (text: string) => ReactNode): ReactNode {
  return Children.map(node, child => {
    if (typeof child === 'string') return transform(child)
    if (isValidElement(child) && (child.props as Record<string, unknown>).children) {
      return cloneElement(child, {}, applyToStringChildren((child.props as Record<string, unknown>).children as ReactNode, transform))
    }
    return child
  })
}
