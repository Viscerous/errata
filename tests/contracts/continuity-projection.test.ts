import { describe, expect, it } from 'vitest'
import type { ContinuityProjection } from '@/contracts/continuity'
import type { LibrarianAnalysis as ClientLibrarianAnalysis } from '@/lib/api/types'

type ClientContinuityProjection = NonNullable<ClientLibrarianAnalysis['continuityProjection']>
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false

describe('continuity projection contract', () => {
  it('uses the canonical projection type in the client analysis', () => {
    const usesCanonicalType: Equal<ClientContinuityProjection, ContinuityProjection> = true
    expect(usesCanonicalType).toBe(true)

    const projection: ContinuityProjection = {
      version: 1,
      temporalFrame: { relation: 'forward' },
      stateOperations: [],
      threadOperations: [],
      threadFocus: [],
      knowledgeOperations: [],
    }
    expect(projection.version).toBe(1)
  })
})
