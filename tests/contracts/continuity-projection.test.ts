import { describe, expect, it } from 'vitest'
import type { ContinuityProjection as ServerContinuityProjection } from '@/server/librarian/continuity-types'
import type { LibrarianAnalysis as ClientLibrarianAnalysis } from '@/lib/api/types'

type ClientContinuityProjection = NonNullable<ClientLibrarianAnalysis['continuityProjection']>

/**
 * The client mirrors the projection shape by hand, as it does for the rest of
 * the Librarian analysis. That mirror is what the panel renders, so a server
 * field that is renamed, retyped, or narrowed without the client following must
 * fail here rather than silently render as undefined for the author.
 */
type AssertAssignable<Target, Source extends Target> = (source: Source) => Target

describe('continuity projection contract', () => {
  it('keeps the client projection mirror assignable from the server type', () => {
    // The real assertion is this type: it stops compiling if the shapes drift.
    const mirror: AssertAssignable<ClientContinuityProjection, ServerContinuityProjection> =
      (source) => source
    expect(mirror).toBeTypeOf('function')

    const projection: ClientContinuityProjection = {
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
