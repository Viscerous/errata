import { describe, expect, it } from 'vitest'
import type {
  LibrarianAnalysis as SharedLibrarianAnalysis,
  LibrarianStatusResponse,
  StoredLibrarianState,
} from '@/contracts/librarian'
import type {
  LibrarianAnalysis as ClientLibrarianAnalysis,
  LibrarianFragmentChangeProposal as ClientProposal,
  LibrarianStatusResponse as ClientStatusResponse,
} from '@/lib/api/types'
import type {
  LibrarianAnalysis as ServerLibrarianAnalysis,
  LibrarianFragmentChangeProposal as ServerProposal,
  LibrarianState as ServerLibrarianState,
} from '@/server/librarian/storage'

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false
type Assignable<Target, Source extends Target> = [Source] extends [Target] ? true : never

describe('shared librarian contracts', () => {
  it('shares the complete analysis envelope while preserving proposal precision', () => {
    const clientUsesSharedEnvelope: Equal<
      ClientLibrarianAnalysis,
      SharedLibrarianAnalysis<ClientProposal>
    > = true
    const serverUsesSharedEnvelope: Equal<
      ServerLibrarianAnalysis,
      SharedLibrarianAnalysis<ServerProposal>
    > = true
    const serverResponseFitsClient: Assignable<
      ClientLibrarianAnalysis,
      ServerLibrarianAnalysis
    > = true

    expect(clientUsesSharedEnvelope).toBe(true)
    expect(serverUsesSharedEnvelope).toBe(true)
    expect(serverResponseFitsClient).toBe(true)
  })

  it('distinguishes stored state from the complete status response', () => {
    const serverStoresOnlyDurableState: Equal<ServerLibrarianState, StoredLibrarianState> = true
    const clientConsumesRuntimeStatus: Equal<ClientStatusResponse, LibrarianStatusResponse> = true

    expect(serverStoresOnlyDurableState).toBe(true)
    expect(clientConsumesRuntimeStatus).toBe(true)
  })
})
