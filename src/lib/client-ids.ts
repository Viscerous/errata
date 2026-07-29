/**
 * Random identifiers minted in the browser.
 *
 * Deliberately not randomUUID: that API is secure-context only, so it is absent
 * over plain HTTP on a LAN address — which is how remote access serves the app —
 * and throws on first use. getRandomValues carries no such restriction.
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Identifies one generation run to the cancel route. */
export function generateRunId(): string {
  return `gen-${Date.now().toString(36)}-${randomHex(16)}`
}

/** An opaque token for anything needing a unique client-side key. */
export function randomToken(byteLength = 8): string {
  return randomHex(byteLength)
}
