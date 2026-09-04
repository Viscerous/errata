import { describe, expect, it } from 'vitest'
import { ContinuityProjectionSchema, type ContinuityProjection } from '@/contracts/continuity'
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
      version: 2,
      scene: { transition: 'continue', line: 'present' },
      stateOperations: [],
      threadOperations: [],
      threadFocus: [],
      knowledgeOperations: [],
    }
    expect(projection.version).toBe(2)
  })

  it('accepts only canonical persisted v2 projections', () => {
    const projection: ContinuityProjection = {
      version: 2,
      scene: { transition: 'enter-flashback', line: 'flashback' },
      stateOperations: [],
      threadOperations: [],
      threadFocus: [],
      knowledgeOperations: [],
    }
    expect(ContinuityProjectionSchema.safeParse(projection).success).toBe(true)
    expect(ContinuityProjectionSchema.safeParse({ ...projection, version: 1 }).success).toBe(false)
    expect(ContinuityProjectionSchema.safeParse({ ...projection, extra: true }).success).toBe(false)
    expect(ContinuityProjectionSchema.safeParse({
      ...projection,
      scene: { transition: 'enter-flashback', line: 'present' },
    }).success).toBe(false)
    expect(ContinuityProjectionSchema.safeParse({
      ...projection,
      scene: {
        transition: 'cut',
        line: 'present',
        time: {
          label: 'an impossible range',
          certainty: 'bounded',
          earliest: '2026-01-02T00:00:00.000Z',
          latest: '2026-01-01T00:00:00.000Z',
        },
      },
    }).success).toBe(false)
  })
})
