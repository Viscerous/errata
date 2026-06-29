import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
  Children,
  isValidElement,
  cloneElement,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type StreamMarkdownVariant = 'default' | 'prose'

interface StreamMarkdownProps {
  content: string
  streaming?: boolean
  /** Typography variant. "prose" uses serif fonts for the reading experience. */
  variant?: StreamMarkdownVariant
  /** Optional transform applied to text nodes (e.g. for character mention highlighting) */
  textTransform?: (text: string) => ReactNode
  /** Optional key to uniquely represent/cache the textTransform state dependencies */
  textTransformKey?: string
  /** Optional stable anchor applied to the first rendered paragraph for scroll compensation. */
  anchorId?: string
}

const renderedMarkdownCache = new Map<string, ReactNode>()
const MAX_CACHE_SIZE = 300

function getCachedMarkdown(key: string): ReactNode | undefined {
  return renderedMarkdownCache.get(key)
}

function setCachedMarkdown(key: string, value: ReactNode) {
  if (renderedMarkdownCache.size >= MAX_CACHE_SIZE) {
    const firstKey = renderedMarkdownCache.keys().next().value
    if (firstKey !== undefined) {
      renderedMarkdownCache.delete(firstKey)
    }
  }
  renderedMarkdownCache.set(key, value)
}

const variantStyles: Record<StreamMarkdownVariant, {
  root: string
  p: string
  strong: string
  em: string
  ul: string
  ol: string
  li: string
  codeBlock: string
  codeInline: string
  heading: string
  blockquote: string
  hr: string
  tableWrap: string
  table: string
  th: string
  td: string
  cursor: string
}> = {
  default: {
    root: '',
    p: 'mb-2 last:mb-0',
    strong: 'font-semibold',
    em: 'italic',
    ul: 'list-disc pl-4 mb-2 last:mb-0',
    ol: 'list-decimal pl-4 mb-2 last:mb-0',
    li: 'mb-0.5',
    codeBlock: 'block bg-muted/50 rounded px-2 py-1.5 my-1.5 text-[0.6875rem] font-mono overflow-x-auto whitespace-pre',
    codeInline: 'bg-muted/50 rounded px-1 py-0.5 text-[0.6875rem] font-mono',
    heading: 'font-semibold mb-1',
    blockquote: 'border-l-2 border-border/50 pl-2 my-1.5 text-muted-foreground',
    hr: 'border-border/30 my-2',
    tableWrap: 'block my-2 max-w-full overflow-x-auto rounded-md border border-border/30',
    table: 'w-full min-w-max border-collapse text-[0.6875rem]',
    th: 'border-b border-border/30 bg-muted/40 px-2 py-1 text-left font-semibold text-foreground/80 whitespace-nowrap',
    td: 'border-t border-border/20 px-2 py-1 text-foreground/75 align-top',
    cursor: 'stream-markdown-cursor inline-block w-0.5 h-[1em] bg-primary/60 animate-pulse motion-reduce:animate-none ml-px align-text-bottom',
  },
  prose: {
    root: 'prose-content',
    p: 'mb-[0.85em] last:mb-0',
    strong: 'font-semibold',
    em: 'italic',
    ul: 'list-disc pl-6 mb-[0.85em] last:mb-0',
    ol: 'list-decimal pl-6 mb-[0.85em] last:mb-0',
    li: 'mb-1 pl-0.5',
    codeBlock: 'block bg-muted/40 rounded-md px-3 py-2 my-3 text-[0.75rem] font-mono overflow-x-auto whitespace-pre leading-relaxed',
    codeInline: 'bg-muted/40 rounded px-1.5 py-0.5 text-[0.75rem] font-mono',
    heading: 'font-display font-normal text-[1.15em] mb-2 mt-4 first:mt-0',
    blockquote: 'border-l-2 border-primary/20 pl-4 my-4 italic text-foreground/70',
    hr: 'border-border/20 my-6',
    tableWrap: 'block my-4 max-w-full overflow-x-auto rounded-md border border-border/25',
    table: 'w-full min-w-max border-collapse text-[0.8em] font-sans',
    th: 'border-b border-border/25 bg-muted/30 px-3 py-1.5 text-left font-semibold text-foreground/80 whitespace-nowrap',
    td: 'border-t border-border/15 px-3 py-1.5 text-foreground/75 align-top',
    cursor: 'stream-markdown-cursor inline-block w-[2px] h-[1.1em] bg-primary/50 animate-pulse motion-reduce:animate-none ml-0.5 align-text-bottom rounded-full',
  },
}

const STREAM_REVEAL_DURATION_MS = 1000
const CURSOR_MOVE_MAX_DISTANCE = 360
const CURSOR_MOVE_MIN_DURATION_MS = 70
const CURSOR_MOVE_MAX_DURATION_MS = 170

interface StreamMarkdownBlock {
  key: string
  content: string
  start: number
  end: number
}

interface RevealSegment {
  start: number
  end: number
  startedAt: number
}

interface RenderRevealSegment {
  start: number
  end: number
  elapsedMs: number
}

interface CursorRect {
  left: number
  top: number
}

const streamCursorRects = new Map<string, CursorRect>()
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

function hashBlock(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i += 1) {
    hash = ((hash << 5) + hash) ^ content.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

function getNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function trimMarkdownRange(source: string, start: number, end: number) {
  let trimmedStart = start
  let trimmedEnd = end

  while (trimmedStart < trimmedEnd && /\s/.test(source[trimmedStart])) trimmedStart += 1
  while (trimmedEnd > trimmedStart && /\s/.test(source[trimmedEnd - 1])) trimmedEnd -= 1

  if (trimmedStart >= trimmedEnd) return null

  return {
    content: source.slice(trimmedStart, trimmedEnd),
    start: trimmedStart,
    end: trimmedEnd,
  }
}

function splitStreamingMarkdownBlocks(content: string): StreamMarkdownBlock[] {
  if (!content) return []

  const blocks: StreamMarkdownBlock[] = []
  let blockStart = 0
  let lineStart = 0
  let inFence = false
  let fenceMarker = ''
  let index = 0

  while (lineStart < content.length) {
    let lineEnd = content.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = content.length
    const line = content.slice(lineStart, lineEnd)
    const trimmedStart = line.trimStart()
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})/)

    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        inFence = false
      }
    }

    const nextLineStart = lineEnd < content.length ? lineEnd + 1 : content.length
    if (!inFence && line.trim() === '' && nextLineStart < content.length) {
      const block = trimMarkdownRange(content, blockStart, lineStart)
      if (block) {
        blocks.push({
          key: `${index}-${block.content.length}-${hashBlock(block.content)}`,
          ...block,
        })
        index += 1
      }
      blockStart = nextLineStart
    }

    lineStart = nextLineStart
  }

  const tail = trimMarkdownRange(content, blockStart, content.length)
  if (tail || blocks.length === 0) {
    blocks.push({
      key: `${index}-active`,
      content: tail?.content ?? '',
      start: tail?.start ?? content.length,
      end: tail?.end ?? content.length,
    })
  }

  return blocks
}

/** Recursively apply textTransform to string children in a React node tree */
function processChildren(children: ReactNode, textTransform: (text: string) => ReactNode): ReactNode {
  return Children.map(children, child => {
    if (typeof child === 'string') {
      return textTransform(child)
    }
    if (isValidElement(child) && (child.props as Record<string, unknown>).children) {
      return cloneElement(child, {}, processChildren((child.props as Record<string, unknown>).children as ReactNode, textTransform))
    }
    return child
  })
}

function hasHastClass(node: any, className: string): boolean {
  const classes = node.properties?.className
  if (Array.isArray(classes)) return classes.includes(className)
  if (typeof classes === 'string') return classes.split(/\s+/).includes(className)
  return false
}

function getClassNames(className: unknown): string {
  if (Array.isArray(className)) return className.join(' ')
  return typeof className === 'string' ? className : ''
}

function normalizeStyle(style: unknown): CSSProperties | undefined {
  if (!style) return undefined
  if (typeof style === 'object') return style as CSSProperties
  if (typeof style !== 'string') return undefined

  const revealDelay = style.match(/--stream-markdown-reveal-delay\s*:\s*([^;]+)/)
  if (!revealDelay) return undefined

  return {
    '--stream-markdown-reveal-delay': revealDelay[1].trim(),
  } as CSSProperties
}

function SmoothStreamCursor({
  className,
  cursorId,
}: {
  className: string
  cursorId: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const isMountedRef = useRef(false)

  useIsomorphicLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof window === 'undefined') return

    const container = element.closest('.stream-markdown')
    const containerRect = container ? container.getBoundingClientRect() : { left: 0, top: 0 }

    // 1. Measure current visual position (including active transition)
    const rect = element.getBoundingClientRect()
    const visualLeft = rect.left - containerRect.left
    const visualTop = rect.top - containerRect.top

    // 2. Temporarily disable transition to snap to layout position and measure it
    const oldTransition = element.style.transition
    element.style.transition = 'none'
    const layoutRect = element.getBoundingClientRect()
    const localLeft = layoutRect.left - containerRect.left
    const localTop = layoutRect.top - containerRect.top
    element.style.transition = oldTransition

    const previous = streamCursorRects.get(cursorId)
    streamCursorRects.set(cursorId, { left: localLeft, top: localTop })

    let dx = 0
    let dy = 0

    if (isMountedRef.current) {
      // Within the same block/paragraph: animate from the current visual position
      dx = visualLeft - localLeft
      dy = visualTop - localTop
    } else {
      // New block / Paragraph crossing: animate from the stored previous cursor position
      isMountedRef.current = true
      if (previous) {
        dx = previous.left - localLeft
        dy = previous.top - localTop
      } else {
        return // First mount of the entire stream
      }
    }

    const distance = Math.hypot(dx, dy)
    if (distance < 0.5 || distance > CURSOR_MOVE_MAX_DISTANCE) return

    element.style.transition = 'none'
    element.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    
    // Force layout reflow synchronously to ensure the starting position is registered
    element.offsetHeight

    const duration = Math.min(
      CURSOR_MOVE_MAX_DURATION_MS,
      Math.max(CURSOR_MOVE_MIN_DURATION_MS, distance * 2.5),
    )
    
    element.style.transition = `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`
    element.style.transform = 'translate3d(0, 0, 0)'
  })

  return (
    <span
      ref={ref}
      className={className}
      style={{ willChange: 'transform' }}
      aria-hidden="true"
    />
  )
}

function appendCursorToHast(node: any, cursorNode: any): boolean {
  if (node.type === 'element' && hasHastClass(node, 'stream-markdown-reveal')) {
    return true
  }
  if (node.type === 'text') {
    return true
  }
  if (node.type === 'element' || node.type === 'root') {
    if (!node.children || node.children.length === 0) {
      node.children = [cursorNode]
      return false
    }
    const lastIndex = node.children.length - 1
    const lastChild = node.children[lastIndex]

    if (lastChild.type === 'element' && ['table', 'thead', 'tbody', 'tr'].includes(lastChild.tagName)) {
      node.children.push(cursorNode)
      return false
    }

    const shouldAppend = appendCursorToHast(lastChild, cursorNode)
    if (shouldAppend) {
      node.children.push(cursorNode)
    }
    return false
  }
  return false
}

function rehypeCursorPlugin(cursorNode: any) {
  return () => (tree: any) => {
    appendCursorToHast(tree, cursorNode)
  }
}

function getNodeOffsetRange(node: any): { start: number; end: number } | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return null
  return { start, end }
}

function sourceOffsetToTextIndex(value: string, sourceStart: number, sourceEnd: number, offset: number): number {
  const sourceLength = sourceEnd - sourceStart
  if (sourceLength <= 0) return 0
  if (sourceLength === value.length) return Math.max(0, Math.min(value.length, offset - sourceStart))

  const ratio = (offset - sourceStart) / sourceLength
  return Math.max(0, Math.min(value.length, Math.round(ratio * value.length)))
}

function revealSpan(value: string, elapsedMs: number) {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['stream-markdown-reveal'],
      style: `--stream-markdown-reveal-delay: -${Math.max(0, Math.round(elapsedMs))}ms`,
    },
    children: [{ type: 'text', value }],
  }
}

function splitTextNodeByRevealSegments(node: any, revealSegments: RenderRevealSegment[]) {
  const value = String(node.value ?? '')
  const range = getNodeOffsetRange(node)
  if (!value || !range) return [node]

  const intersections = revealSegments
    .map(segment => {
      const start = Math.max(range.start, segment.start)
      const end = Math.min(range.end, segment.end)
      if (end <= start) return null
      return {
        startIndex: sourceOffsetToTextIndex(value, range.start, range.end, start),
        endIndex: sourceOffsetToTextIndex(value, range.start, range.end, end),
        elapsedMs: segment.elapsedMs,
      }
    })
    .filter((part): part is { startIndex: number; endIndex: number; elapsedMs: number } => part !== null)
    .sort((a, b) => a.startIndex - b.startIndex)

  if (intersections.length === 0) return [node]

  const children = []
  let cursor = 0

  for (const intersection of intersections) {
    const startIndex = Math.max(cursor, intersection.startIndex)
    const endIndex = Math.max(startIndex, intersection.endIndex)
    if (startIndex > cursor) {
      children.push({ ...node, value: value.slice(cursor, startIndex) })
    }
    if (endIndex > startIndex) {
      children.push(revealSpan(value.slice(startIndex, endIndex), intersection.elapsedMs))
    }
    cursor = endIndex
  }

  if (cursor < value.length) {
    children.push({ ...node, value: value.slice(cursor) })
  }

  return children
}

function revealTextRangesInHast(node: any, revealSegments: RenderRevealSegment[]) {
  if (!node || !Array.isArray(node.children)) return

  const children = []
  for (const child of node.children) {
    if (child.type === 'text') {
      children.push(...splitTextNodeByRevealSegments(child, revealSegments))
      continue
    }
    revealTextRangesInHast(child, revealSegments)
    children.push(child)
  }
  node.children = children
}

function rehypeRevealRangesPlugin(revealSegments: RenderRevealSegment[]) {
  return () => (tree: any) => {
    if (revealSegments.length > 0) {
      revealTextRangesInHast(tree, revealSegments)
    }
  }
}

function getBlockRevealSegments(
  block: StreamMarkdownBlock,
  revealSegments: RenderRevealSegment[],
): RenderRevealSegment[] {
  if (revealSegments.length === 0 || block.content.length === 0) return []

  return revealSegments
    .map(segment => {
      const start = Math.max(block.start, segment.start)
      const end = Math.min(block.end, segment.end)
      if (end <= start) return null
      return {
        start: start - block.start,
        end: end - block.start,
        elapsedMs: segment.elapsedMs,
      }
    })
    .filter((segment): segment is RenderRevealSegment => segment !== null)
}

function MarkdownBlock({
  content,
  variant,
  textTransform,
  textTransformKey,
  anchorId,
  showCursor,
  cursorId,
  revealSegments = [],
}: {
  content: string
  variant: StreamMarkdownVariant
  textTransform?: (text: string) => ReactNode
  textTransformKey?: string
  anchorId?: string
  showCursor?: boolean
  cursorId?: string
  revealSegments?: RenderRevealSegment[]
}) {
  const hasRevealSegments = revealSegments.length > 0
  const cacheKey = useMemo(() => {
    if (anchorId) return null
    return `${content}::${variant}::${textTransformKey ?? 'notx'}`
  }, [content, variant, textTransformKey, anchorId])

  const cached = cacheKey ? getCachedMarkdown(cacheKey) : undefined
  if (cached && !showCursor && !hasRevealSegments) {
    return <>{cached}</>
  }

  const s = variantStyles[variant]
  const tx = textTransform
    ? (children: ReactNode) => processChildren(children, textTransform)
    : (children: ReactNode) => children
  let anchorUsed = false
  const anchorAttrs = () => {
    if (!anchorId || anchorUsed) return {}
    anchorUsed = true
    return { 'data-scroll-anchor': anchorId }
  }

  const cursorNode = showCursor ? {
    type: 'element',
    tagName: 'span',
    properties: {
      className: s.cursor.split(' '),
      'data-stream-cursor-id': cursorId,
    },
    children: [],
  } : null

  const rehypePlugins = []
  if (hasRevealSegments) {
    rehypePlugins.push(rehypeRevealRangesPlugin(revealSegments))
  }
  if (cursorNode) {
    rehypePlugins.push(rehypeCursorPlugin(cursorNode))
  }

  const element = (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins.length > 0 ? rehypePlugins : undefined}
      components={{
        p: ({ children }) => <p className={s.p} {...anchorAttrs()}>{tx(children)}</p>,
        strong: ({ children }) => <strong className={s.strong}>{children}</strong>,
        em: ({ children }) => <em className={s.em}>{children}</em>,
        ul: ({ children }) => <ul className={s.ul} {...anchorAttrs()}>{children}</ul>,
        ol: ({ children }) => <ol className={s.ol} {...anchorAttrs()}>{children}</ol>,
        li: ({ children }) => <li className={s.li}>{tx(children)}</li>,
        code: ({ className, children }) => {
          const isBlock = className?.includes('language-')
          if (isBlock) {
            return <code className={s.codeBlock} {...anchorAttrs()}>{children}</code>
          }
          return <code className={s.codeInline}>{children}</code>
        },
        pre: ({ children }) => <>{children}</>,
        h1: ({ children }) => <p className={s.heading} {...anchorAttrs()}>{tx(children)}</p>,
        h2: ({ children }) => <p className={s.heading} {...anchorAttrs()}>{tx(children)}</p>,
        h3: ({ children }) => <p className={s.heading} {...anchorAttrs()}>{tx(children)}</p>,
        blockquote: ({ children }) => (
          <blockquote className={s.blockquote} {...anchorAttrs()}>{tx(children)}</blockquote>
        ),
        span: ({ node: _node, className, style, children, ...props }) => {
          const classNames = getClassNames(className)
          if (classNames.split(/\s+/).includes('stream-markdown-cursor')) {
            return (
              <SmoothStreamCursor
                className={classNames}
                cursorId={String((props as Record<string, unknown>)['data-stream-cursor-id'] ?? 'default')}
              />
            )
          }
          return (
            <span className={classNames || undefined} style={normalizeStyle(style)}>
              {children}
            </span>
          )
        },
        hr: () => <hr className={s.hr} {...anchorAttrs()} />,
        table: ({ children }) => (
          <div className={s.tableWrap} {...anchorAttrs()}>
            <table className={s.table}>{children}</table>
          </div>
        ),
        th: ({ children, style }) => <th className={s.th} style={style}>{tx(children)}</th>,
        td: ({ children, style }) => <td className={s.td} style={style}>{tx(children)}</td>,
      }}
    >
      {content}
    </Markdown>
  )

  if (cacheKey && !showCursor && !hasRevealSegments) {
    setCachedMarkdown(cacheKey, element)
  }

  return element
}

const MemoMarkdownBlock = memo(MarkdownBlock)

/**
 * Markdown renderer optimized for streaming.
 *
 * During streaming (`streaming=true`), splits content into markdown blocks and
 * lets memoized stable blocks stay frozen while only the tail block reparses.
 *
 * When streaming ends, renders the full content through react-markdown once.
 */
export const StreamMarkdown = memo(function StreamMarkdown({
  content,
  streaming,
  variant = 'default',
  textTransform,
  textTransformKey,
  anchorId,
}: StreamMarkdownProps) {
  const s = variantStyles[variant]
  const cursorId = useId()

  useEffect(() => () => {
    streamCursorRects.delete(cursorId)
  }, [cursorId])
  const previousContentRef = useRef('')
  const revealSegmentsRef = useRef<RevealSegment[]>([])
  const streamingBlocks = useMemo(() => {
    if (!streaming) return []
    return splitStreamingMarkdownBlocks(content)
  }, [content, streaming])

  const revealSegments = useMemo<RenderRevealSegment[]>(() => {
    const now = getNowMs()

    if (!streaming || content.length === 0) {
      previousContentRef.current = content
      revealSegmentsRef.current = []
      return []
    }

    const previousContent = previousContentRef.current
    let revealSegments = revealSegmentsRef.current.filter(segment => (
      now - segment.startedAt < STREAM_REVEAL_DURATION_MS
      && segment.end <= content.length
    ))

    if (previousContent !== content) {
      if (previousContent && content.startsWith(previousContent)) {
        if (content.length > previousContent.length) {
          revealSegments.push({
            start: previousContent.length,
            end: content.length,
            startedAt: now,
          })
        }
      } else {
        revealSegments = [{ start: 0, end: content.length, startedAt: now }]
      }
      previousContentRef.current = content
    }

    revealSegmentsRef.current = revealSegments
    return revealSegments.map(segment => ({
      start: segment.start,
      end: segment.end,
      elapsedMs: Math.min(STREAM_REVEAL_DURATION_MS, now - segment.startedAt),
    }))
  }, [content, streaming])

  if (streaming) {
    if (streamingBlocks.length === 0) {
      return (
        <div className={`stream-markdown ${s.root}`}>
          <span className={s.cursor} />
        </div>
      )
    }
    return (
      <div className={`stream-markdown ${s.root}`}>
        {streamingBlocks.map((block, index) => {
          const isActiveBlock = index === streamingBlocks.length - 1
          const blockRevealSegments = getBlockRevealSegments(block, revealSegments)
          return (
            <MemoMarkdownBlock
              key={block.key}
              content={block.content}
              variant={variant}
              textTransform={textTransform}
              textTransformKey={textTransformKey}
              anchorId={index === 0 ? anchorId : undefined}
              showCursor={isActiveBlock}
              cursorId={cursorId}
              revealSegments={blockRevealSegments.length > 0 ? blockRevealSegments : undefined}
            />
          )
        })}
      </div>
    )
  }

  return (
    <div className={`stream-markdown ${s.root}`}>
      <MemoMarkdownBlock
        content={content}
        variant={variant}
        textTransform={textTransform}
        textTransformKey={textTransformKey}
        anchorId={anchorId}
      />
    </div>
  )
})
