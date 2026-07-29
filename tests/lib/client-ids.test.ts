import { describe, expect, it, vi, afterEach } from 'vitest'
import { generateRunId, randomToken } from '@/lib/client-ids'

/**
 * These ids are minted in the browser, and remote access serves the app over
 * plain HTTP on a LAN address — not a secure context. `crypto.randomUUID` is
 * secure-context only and simply absent there, so building a run id with it threw
 * before the generation request was ever made: the UI sat in "generating" for
 * ever, nothing reached the server, and stop did nothing because the run id had
 * never been assigned. `getRandomValues` has no such restriction.
 */
describe('client ids', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A non-secure context: getRandomValues present, randomUUID and subtle absent. */
  function stubInsecureCrypto() {
    vi.stubGlobal('crypto', {
      getRandomValues: (buffer: Uint8Array) => {
        for (let i = 0; i < buffer.length; i++) buffer[i] = i * 7 % 256
        return buffer
      },
    })
  }

  it('mints a run id where randomUUID does not exist', () => {
    stubInsecureCrypto()
    expect(() => generateRunId()).not.toThrow()
    expect(generateRunId()).toMatch(/^gen-[a-z0-9]+-[0-9a-f]{32}$/)
  })

  it('mints a token where randomUUID does not exist', () => {
    stubInsecureCrypto()
    expect(randomToken()).toMatch(/^[0-9a-f]{16}$/)
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('does not reach for randomUUID even when it is available', () => {
    const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000000')
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })

    generateRunId()
    randomToken()

    expect(randomUUID).not.toHaveBeenCalled()
  })

  it('gives every run a distinct id', () => {
    const ids = new Set(Array.from({ length: 500 }, generateRunId))
    expect(ids.size).toBe(500)
  })
})
