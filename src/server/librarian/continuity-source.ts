import { createHash } from 'node:crypto'
import type { Fragment } from '../fragments/schema'
import type { AnalysisSourceRevision } from '@/contracts/continuity'

/** Hash only material prose fields; Librarian annotation metadata must not stale its own Analysis. */
export function proseContentHash(fragment: Pick<Fragment, 'name' | 'description' | 'content'>): string {
  return createHash('sha256')
    .update(JSON.stringify([fragment.name, fragment.description, fragment.content]))
    .digest('hex')
}

export function analysisSourceRevision(fragment: Fragment): AnalysisSourceRevision {
  return {
    contentHash: proseContentHash(fragment),
    ...(fragment.version !== undefined ? { fragmentVersion: fragment.version } : {}),
    updatedAt: fragment.updatedAt,
  }
}
