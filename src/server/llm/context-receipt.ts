import type { Fragment } from '../fragments/schema'
import type { ContextBlock } from './context-builder'
import { fragmentTagPattern } from './fragment-tag'

export const CONTEXT_RECEIPT_VERSION = 1 as const

export type ContextReceiptAccess = 'full' | 'catalog' | 'read'
export type ContextReceiptActor = 'writer' | 'prewriter'

export interface ContextReceiptEntry {
  fragmentId: string
  access: ContextReceiptAccess
  actor: ContextReceiptActor
  reason: string
}

export interface ContextReceipt {
  version: typeof CONTEXT_RECEIPT_VERSION
  entries: ContextReceiptEntry[]
}

interface ToolCallLike {
  toolName: string
  args: unknown
}

function isReceiptEntry(value: unknown): value is ContextReceiptEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.fragmentId === 'string'
    && (entry.access === 'full' || entry.access === 'catalog' || entry.access === 'read')
    && (entry.actor === 'writer' || entry.actor === 'prewriter')
    && typeof entry.reason === 'string'
}

export function readContextReceipt(fragment: Fragment | null | undefined): ContextReceipt | null {
  const value = fragment?.meta?.contextReceipt
  if (!value || typeof value !== 'object') return null
  const receipt = value as Record<string, unknown>
  if (receipt.version !== CONTEXT_RECEIPT_VERSION || !Array.isArray(receipt.entries)) return null
  return {
    version: CONTEXT_RECEIPT_VERSION,
    entries: receipt.entries.filter(isReceiptEntry),
  }
}

function reasonForBlock(block: ContextBlock): string {
  const scope = block.fragmentContext?.scope
  if (block.id === 'system-fragments' || block.id === 'user-fragments') return 'sticky'
  if (scope === 'pinned') return 'sticky'
  if (scope === 'recent') return 'recent-context'
  if (scope === 'writer-context') return 'inherited-presentation'
  if (scope === 'candidate') return 'candidate'
  if (block.fragmentContext?.mode === 'summary-index') return 'catalog'
  return 'presented'
}

function taggedFragments(blocks: ContextBlock[]): Array<{ fragmentId: string; access: 'full' | 'catalog' }> {
  const tagged = new Map<string, 'full' | 'catalog'>()
  for (const block of blocks) {
    const tagPattern = fragmentTagPattern()
    let match: RegExpExecArray | null
    while ((match = tagPattern.exec(block.content)) !== null) {
      const access = match[2] === 'short' ? 'catalog' : 'full'
      // A full use dominates a short use when both appear.
      if (access === 'full' || !tagged.has(match[1])) tagged.set(match[1], access)
    }
  }
  return [...tagged].map(([fragmentId, access]) => ({ fragmentId, access }))
}

function readFragmentIds(calls: ToolCallLike[]): string[] {
  const ids = new Set<string>()
  for (const call of calls) {
    if (call.toolName !== 'readFragments' || !call.args || typeof call.args !== 'object') continue
    const fragmentIds = (call.args as Record<string, unknown>).fragmentIds
    if (!Array.isArray(fragmentIds)) continue
    for (const id of fragmentIds) {
      if (typeof id === 'string') ids.add(id)
    }
  }
  return [...ids]
}

export function createContextReceipt(params: {
  writerBlocks: ContextBlock[]
  /**
   * Blocks presented to the prewriter. In prewriter mode the writer receives a
   * brief plus prose, so the structured fragment surfaces live here. Without
   * them the receipt would record no full presentation at all, and re-analysis
   * would lose the records the passage was actually drafted from.
   */
  prewriterBlocks?: ContextBlock[]
  writerToolCalls?: ToolCallLike[]
  prewriterToolCalls?: ToolCallLike[]
}): ContextReceipt {
  const entries: ContextReceiptEntry[] = []
  const keys = new Set<string>()
  const add = (entry: ContextReceiptEntry) => {
    const key = `${entry.fragmentId}\u0000${entry.access}\u0000${entry.actor}\u0000${entry.reason}`
    if (keys.has(key)) return
    keys.add(key)
    entries.push(entry)
  }

  const addPresentation = (blocks: ContextBlock[], actor: ContextReceiptActor) => {
    for (const block of blocks) {
      const metadata = block.fragmentContext
      if (!metadata?.fragmentIds?.length) continue
      const access: ContextReceiptAccess = metadata.mode === 'full' ? 'full' : 'catalog'
      const reason = reasonForBlock(block)
      for (const fragmentId of metadata.fragmentIds) {
        add({ fragmentId, access, actor, reason })
      }
    }
    for (const tagged of taggedFragments(blocks)) {
      add({ ...tagged, actor, reason: 'explicit-tag' })
    }
  }

  addPresentation(params.writerBlocks, 'writer')
  if (params.prewriterBlocks) addPresentation(params.prewriterBlocks, 'prewriter')

  for (const fragmentId of readFragmentIds(params.writerToolCalls ?? [])) {
    add({ fragmentId, access: 'read', actor: 'writer', reason: 'explicit-read' })
  }
  for (const fragmentId of readFragmentIds(params.prewriterToolCalls ?? [])) {
    add({ fragmentId, access: 'read', actor: 'prewriter', reason: 'explicit-read' })
  }

  return { version: CONTEXT_RECEIPT_VERSION, entries }
}

/**
 * The pre-receipt provenance field. Read only as a fallback for passages
 * written before receipts existed, and only for auditing — never for the
 * bridge, because it recorded plain full presentation and reviving it there
 * would restore the self-renewing working set receipts exist to end.
 */
function legacyWriterContextIds(fragment: Fragment | null | undefined): string[] {
  const value = fragment?.meta?.writerContextIds
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string'))]
}

/**
 * Full/read provenance for auditing the passage against the same durable
 * records its generation used. Catalog rows are deliberately excluded.
 */
export function contextReceiptProvenanceIds(fragment: Fragment | null | undefined): string[] {
  const receipt = readContextReceipt(fragment)
  if (!receipt) return legacyWriterContextIds(fragment)
  return [...new Set(
    receipt.entries
      .filter((entry) => entry.access === 'full' || entry.access === 'read')
      .map((entry) => entry.fragmentId),
  )]
}

/**
 * A short bridge for the next generation while asynchronous mention analysis
 * may still be pending. Merely being presented in full never renews relevance.
 */
export function contextReceiptBridgeIds(fragment: Fragment | null | undefined): string[] {
  const receipt = readContextReceipt(fragment)
  if (!receipt) return []
  return [...new Set(
    receipt.entries
      .filter((entry) => entry.access === 'read' || entry.reason === 'explicit-tag')
      .map((entry) => entry.fragmentId),
  )]
}
