import { describe, expect, it } from 'vitest'
import { ContinuityProjectionSchema, type ContinuityProjection } from '@/contracts/continuity'
import { liveStateItemId } from '@/contracts/live-state'
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
      version: 3,
      scene: { transition: 'continue', line: 'present' },
      stateOperations: [],
      threadOperations: [],
      threadFocus: [],
      knowledgeOperations: [],
    }
    expect(projection.version).toBe(3)
  })

  it('accepts only canonical persisted projections', () => {
    const projection: ContinuityProjection = {
      version: 3,
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

  it('accepts live-state reports that set fields, add entries, and end them', () => {
    const secretId = liveStateItemId('Secrets', 'carries the map')
    const projection: ContinuityProjection = {
      version: 3,
      scene: { transition: 'continue', line: 'present' },
      stateOperations: [],
      threadOperations: [],
      threadFocus: [],
      knowledgeOperations: [],
      liveStates: [{
        kind: 'character',
        key: 'ch-0001',
        fragmentId: 'ch-0001',
        name: 'Alice',
        present: true,
        set: [{ field: 'Currently', value: 'catching her breath' }],
        add: [{ id: liveStateItemId('Knows', 'the gate is unlatched'), field: 'Knows', text: 'the gate is unlatched' }],
        update: [{ id: secretId, happened: 'revealed', to: ['ch-0002'] }],
      }],
    }
    expect(ContinuityProjectionSchema.safeParse(projection).success).toBe(true)
  })

  it('derives the same item identity from the same statement however it is spelled', () => {
    expect(liveStateItemId('Knows', 'The gate is unlatched.')).toBe(liveStateItemId('knows', 'the gate is  unlatched'))
    expect(liveStateItemId('Knows', 'the gate is unlatched')).not.toBe(liveStateItemId('Secrets', 'the gate is unlatched'))
  })
})
