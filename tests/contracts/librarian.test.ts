import { describe, expect, it } from 'vitest'
import type {
  LibrarianAnalysis as SharedLibrarianAnalysis,
  LibrarianFragmentChangeProposal as SharedProposal,
  LibrarianStatusResponse,
} from '@/contracts/librarian'
import type {
  LibrarianAnalysis as ClientLibrarianAnalysis,
  LibrarianFragmentChangeProposal as ClientProposal,
  LibrarianStatusResponse as ClientStatusResponse,
} from '@/lib/api/types'
import type {
  LibrarianAnalysis as ServerLibrarianAnalysis,
  LibrarianFragmentChangeProposal as ServerProposal,
} from '@/server/librarian/storage'

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false
describe('shared librarian contracts', () => {
  it('shares the complete analysis and proposal contracts', () => {
    const clientUsesSharedEnvelope: Equal<
      ClientLibrarianAnalysis,
      SharedLibrarianAnalysis
    > = true
    const serverUsesSharedEnvelope: Equal<
      ServerLibrarianAnalysis,
      SharedLibrarianAnalysis
    > = true
    const clientUsesSharedProposal: Equal<ClientProposal, SharedProposal> = true
    const serverUsesSharedProposal: Equal<ServerProposal, SharedProposal> = true

    expect(clientUsesSharedEnvelope).toBe(true)
    expect(serverUsesSharedEnvelope).toBe(true)
    expect(clientUsesSharedProposal).toBe(true)
    expect(serverUsesSharedProposal).toBe(true)
  })

  it('distinguishes stored state from the complete status response', () => {
    const clientConsumesRuntimeStatus: Equal<ClientStatusResponse, LibrarianStatusResponse> = true

    expect(clientConsumesRuntimeStatus).toBe(true)
  })
})
