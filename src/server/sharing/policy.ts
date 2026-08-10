/**
 * What the sharing proxy refuses to forward.
 *
 * The rule is that credential administration is local-only: once sharing is on,
 * everything the app exposes is reachable from the LAN or a tunnel behind one
 * password, and the endpoints that store, change, or spend credentials should
 * not be. Reads still pass — they are masked at the route layer, and the
 * settings UI needs them to render.
 */

/**
 * Dot segments are resolved twice: `URL` handles `..` but leaves `%2e%2e`
 * encoded, and the upstream decodes before routing — so a single pass would let
 * `/api/x/%2e%2e/config/test-connection` reach a blocked route unblocked.
 */
function normalizePathname(rawUrl: string): string {
  let pathname = '/'
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
    pathname = new URL(decodeURIComponent(pathname), 'http://localhost').pathname
  } catch {
    // Unparseable target or a malformed escape: match on whatever resolved.
  }
  return pathname.replace(/\/+$/, '') || '/'
}

function isRead(method: string): boolean {
  const m = method.toUpperCase()
  return m === 'GET' || m === 'HEAD'
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

const LOCAL_ONLY = 'This can only be changed from the computer running Errata.'

/**
 * The reason this request is refused over the proxy, or null to forward it.
 * A reason rather than a boolean keeps the 403 body honest about why a remote
 * settings page stopped working.
 */
export function proxyBlockReason(method: string, rawUrl: string | undefined): string | null {
  const path = normalizePathname(rawUrl ?? '/')

  // Provider CRUD, the default-provider patch, test-connection, test-models,
  // and the OpenRouter OAuth exchange.
  if (isUnder(path, '/api/config') && !isRead(method)) return LOCAL_ONLY

  // Rotating the proxy's own password, or disabling the auth that gates it.
  if (isUnder(path, '/api/sharing') && !isRead(method)) return LOCAL_ONLY

  // Writing the hub token, or exchanging a password for a fresh one.
  if (isUnder(path, '/api/erratanet/config') && !isRead(method)) return LOCAL_ONLY
  if (isUnder(path, '/api/erratanet/login')) return LOCAL_ONLY

  return null
}
