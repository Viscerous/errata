/**
 * What the sharing proxy forwards.
 *
 * Default-deny under /api: a route is unreachable over the proxy until it is
 * listed here. The previous deny-list had the opposite failure mode — a new
 * credential-bearing route was exposed the moment someone added it, and the
 * list only caught what its author had thought of.
 *
 * Paths outside /api are the app shell and its assets, which carry nothing to
 * protect and are served to anyone who already got past the proxy's password.
 */

type Access =
  /** Reachable in full. */
  | 'shared'
  /** GET/HEAD only — the settings panels need to render, not to be operable. */
  | 'read-only'
  /** Refused whatever the method. */
  | 'local-only'

/**
 * First match wins, so a narrower path must precede the area containing it.
 * Anything under /api that matches nothing is refused.
 */
const RULES: Array<readonly [prefix: string, access: Access]> = [
  // Exchanges a username + password for a hub token.
  ['/api/erratanet/login', 'local-only'],
  // Writing this moves the hub token; reading it returns a redacted view.
  ['/api/erratanet/config', 'read-only'],
  // Provider CRUD, test-connection, test-models, the OpenRouter OAuth exchange.
  ['/api/config', 'read-only'],
  // Rotating the very password that gates this proxy, or tearing down the auth.
  ['/api/sharing', 'read-only'],

  ['/api/health', 'shared'],
  ['/api/plugins', 'shared'],
  ['/api/stories', 'shared'],
  ['/api/agent-blocks', 'shared'],
  ['/api/model-roles', 'shared'],
  // Browsing and installing packs; the two credential paths are ruled on above.
  ['/api/erratanet', 'shared'],
]

const LOCAL_ONLY = 'This can only be changed from the computer running Errata.'
const NOT_SHARED = 'This part of Errata is not available over a shared connection.'

/**
 * Dot segments are resolved twice: `URL` handles `..` but leaves `%2e%2e`
 * encoded, and the upstream decodes before routing — so a single pass would let
 * `/api/x/%2e%2e/config/test-connection` reach a ruled-on route unruled.
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

/**
 * The reason this request is refused over the proxy, or null to forward it.
 * A reason rather than a boolean keeps the 403 body honest about why a remote
 * page stopped working — including when the cause is a route nobody listed.
 */
export function proxyBlockReason(method: string, rawUrl: string | undefined): string | null {
  const path = normalizePathname(rawUrl ?? '/')
  if (!isUnder(path, '/api')) return null

  const rule = RULES.find(([prefix]) => isUnder(path, prefix))
  if (!rule) return NOT_SHARED

  const [, access] = rule
  if (access === 'shared') return null
  if (access === 'read-only' && isRead(method)) return null
  return LOCAL_ONLY
}
