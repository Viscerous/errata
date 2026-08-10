import { createServer, request, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { getSharingConfig } from '../config/storage'
import type { SharingConfig } from '../config/schema'
import { checkBasicAuth } from './auth'
import { appPort, getLanUrl } from './network'
import { ensureCloudflared, parseTunnelUrl } from './cloudflared'
import { proxyBlockReason } from './policy'
import { createLogger } from '../logging'

const logger = createLogger('sharing')

/**
 * Preferred port for the LAN/auth proxy; falls back upward if taken. The override
 * keeps a second instance (or a test beside a live app) off the neighbour's
 * fallback port, where it would authenticate against the wrong config.
 */
function sharePort(): number {
  return Number(process.env.ERRATA_SHARE_PORT) || 7740
}

export type TunnelStatus = 'stopped' | 'downloading' | 'starting' | 'running' | 'error'

interface State {
  dataDir: string | null
  current: SharingConfig | null
  proxy: Server | null
  proxyPort: number | null
  /** localhost family the app actually listens on (probed at proxy start). */
  upstreamHost: string
  tunnelProc: ChildProcess | null
  tunnelUrl: string | null
  tunnelStatus: TunnelStatus
  tunnelError: string | null
  /** Bumped on every stop so an in-flight startTunnel can detect it was cancelled. */
  tunnelEpoch: number
}

const state: State = {
  dataDir: null,
  current: null,
  proxy: null,
  proxyPort: null,
  upstreamHost: '127.0.0.1',
  tunnelProc: null,
  tunnelUrl: null,
  tunnelStatus: 'stopped',
  tunnelError: null,
  tunnelEpoch: 0,
}

function authReady(s: SharingConfig | null): boolean {
  return !!s && s.authEnabled && !!s.passwordHash
}

function requestIsAuthorized(req: IncomingMessage): boolean {
  const s = state.current
  return authReady(s) && checkBasicAuth(req.headers.authorization, s!.username, s!.passwordHash)
}

/** Vite dev rejects unknown Hosts (allowedHosts); harmless in production. */
function upstreamHeaders(req: IncomingMessage, port: number) {
  return { ...req.headers, host: `localhost:${port}` }
}

/**
 * Rejections are logged: a remote client that silently gets 401s looks exactly
 * like one whose requests never arrive, and only this side can tell them apart.
 */
function logRejected(req: IncomingMessage, kind: 'request' | 'upgrade'): void {
  logger.warn('Proxy rejected an unauthenticated request', {
    kind,
    method: req.method,
    url: req.url,
    hasAuthorization: !!req.headers.authorization,
    configured: authReady(state.current),
  })
}

function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
  if (!requestIsAuthorized(req)) {
    logRejected(req, 'request')
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Errata", charset="UTF-8"',
      'Content-Type': 'text/plain',
    })
    res.end('Authentication required.')
    return
  }
  // Checked after auth: an authenticated remote client still does not get the
  // credential endpoints, and an unauthenticated one learns nothing about them.
  const blocked = proxyBlockReason(req.method ?? 'GET', req.url)
  if (blocked) {
    logger.warn('Proxy refused a local-only request', { method: req.method, url: req.url })
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(blocked)
    return
  }
  const port = appPort()
  const headers = upstreamHeaders(req, port)
  const proxyReq = request(
    { hostname: state.upstreamHost, port, path: req.url, method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      // writeHead only stores the head; a stream slow to its first token would
      // otherwise leave the client's fetch() unresolved and looking broken.
      res.flushHeaders()
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', (err) => {
    // Logged for the same reason as a rejection: a remote client only sees a
    // failed request, and the upstream hop is visible from nowhere else.
    logger.error('Proxy could not reach the app', {
      method: req.method, url: req.url, host: state.upstreamHost, port, error: String(err),
    })
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Bad gateway: the app is not reachable.')
  })
  req.pipe(proxyReq)
}

/**
 * Forward protocol upgrades through the same door as everything else. Answered as
 * an ordinary request, an upgrade dies; a built app opens no sockets, so only dev
 * (HMR) noticed.
 */
function handleProxyUpgrade(req: IncomingMessage, clientSocket: Duplex, head: Buffer) {
  if (!requestIsAuthorized(req)) {
    // No ServerResponse on this path, so the 401 is spoken as raw HTTP.
    clientSocket.end(
      'HTTP/1.1 401 Unauthorized\r\n'
      + 'WWW-Authenticate: Basic realm="Errata", charset="UTF-8"\r\n'
      + 'Connection: close\r\n\r\n',
    )
    return
  }

  if (proxyBlockReason(req.method ?? 'GET', req.url)) {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }

  const port = appPort()
  const proxyReq = request({
    hostname: state.upstreamHost,
    port,
    path: req.url,
    method: req.method,
    headers: upstreamHeaders(req, port),
  })

  proxyReq.on('upgrade', (proxyRes, upstreamSocket, upstreamHead) => {
    // Replay the upstream's handshake verbatim; the client validates it.
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`]
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one !== undefined) lines.push(`${key}: ${one}`)
      }
    }
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`)

    // Bytes each side had already sent past its handshake belong to the tunnel.
    if (upstreamHead?.length) clientSocket.write(upstreamHead)
    if (head?.length) upstreamSocket.write(head)

    const drop = () => { upstreamSocket.destroy(); clientSocket.destroy() }
    upstreamSocket.on('error', drop)
    clientSocket.on('error', drop)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  })

  proxyReq.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => proxyReq.destroy())
  proxyReq.end()
}

/**
 * Bind the first free port at or above `port`, resolving with the port actually
 * bound — read off the socket, so the advertised port cannot disagree with it.
 *
 * Both listeners must be removed symmetrically: `server.listen(port, cb)` makes
 * `cb` a one-shot 'listening' listener, so dropping only the 'error' one left it
 * to fire on the retry and resolve with the port that had just failed.
 */
function listen(server: Server, port: number, maxPort = port + 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    }
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening)
      if (err.code === 'EADDRINUSE' && port < maxPort) {
        listen(server, port + 1, maxPort).then(resolve, reject)
      } else {
        reject(err)
      }
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(port, '0.0.0.0')
  })
}

/** Find which localhost family the app listens on (dev vite is IPv6-only). */
function probeUpstreamHost(port: number): Promise<string> {
  const tryHost = (host: string) => new Promise<boolean>((resolve) => {
    const sock = netConnect({ host, port })
    const finish = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(600)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.once('timeout', () => finish(false))
  })
  return (async () => {
    for (const host of ['127.0.0.1', '::1']) {
      if (await tryHost(host)) return host
    }
    return '127.0.0.1'
  })()
}

async function startProxy(): Promise<void> {
  if (state.proxy) return
  state.upstreamHost = await probeUpstreamHost(appPort())
  logger.info('Upstream host probed', { host: state.upstreamHost, port: appPort() })
  const server = createServer(handleProxyRequest)
  server.on('upgrade', handleProxyUpgrade)
  // Don't let a proxy connection error crash the process.
  server.on('error', (err) => logger.error('Proxy server error', { error: String(err) }))
  const port = await listen(server, sharePort())
  state.proxy = server
  state.proxyPort = port
  logger.info('Auth proxy listening', { port })
}

function stopProxy(): void {
  if (state.proxy) {
    state.proxy.close()
    state.proxy = null
    state.proxyPort = null
    logger.info('Auth proxy stopped')
  }
}

function stopTunnel(): void {
  // Invalidate any startTunnel that's mid-download so it won't spawn after this.
  state.tunnelEpoch++
  if (state.tunnelProc) {
    try { state.tunnelProc.kill() } catch { /* ignore */ }
    state.tunnelProc = null
  }
  state.tunnelUrl = null
  state.tunnelStatus = 'stopped'
  state.tunnelError = null
}

async function startTunnel(dataDir: string): Promise<void> {
  if (state.tunnelProc) return
  if (!state.proxyPort) throw new Error('Proxy must be running before the tunnel')
  const epoch = state.tunnelEpoch
  state.tunnelStatus = 'downloading'
  state.tunnelError = null
  let bin: string
  try {
    bin = await ensureCloudflared(dataDir)
  } catch (err) {
    // Only record the error if we're still the active start.
    if (epoch === state.tunnelEpoch) {
      state.tunnelStatus = 'error'
      state.tunnelError = err instanceof Error ? err.message : String(err)
      logger.error('cloudflared download failed', { error: state.tunnelError })
    }
    return
  }

  // The download can take a while; if the tunnel was disabled (or the proxy
  // torn down) in the meantime, abort before spawning so we don't leave a
  // public tunnel running after the user turned it off.
  if (epoch !== state.tunnelEpoch || !state.proxyPort) {
    logger.info('Tunnel start cancelled during download', { epoch, current: state.tunnelEpoch })
    return
  }

  state.tunnelStatus = 'starting'
  const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${state.proxyPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  state.tunnelProc = proc

  const onChunk = (chunk: Buffer) => {
    const url = parseTunnelUrl(chunk.toString('utf-8'))
    if (url && state.tunnelUrl !== url) {
      state.tunnelUrl = url
      state.tunnelStatus = 'running'
      logger.info('Tunnel ready', { url })
    }
  }
  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)
  proc.on('error', (err) => {
    state.tunnelStatus = 'error'
    state.tunnelError = err instanceof Error ? err.message : String(err)
  })
  proc.on('exit', (code) => {
    // Only treat as error if we didn't ask it to stop.
    if (state.tunnelProc === proc) {
      state.tunnelProc = null
      state.tunnelUrl = null
      state.tunnelStatus = code === 0 ? 'stopped' : 'error'
      if (code !== 0) state.tunnelError = `cloudflared exited (${code})`
    }
  })
}

/**
 * Reconcile running services with the persisted config. Idempotent — call after
 * any config change and on server start.
 */
export async function reconcileSharing(dataDir: string): Promise<void> {
  state.dataDir = dataDir
  const sharing = await getSharingConfig(dataDir)
  state.current = sharing

  const wantProxy = authReady(sharing) && (sharing.lanEnabled || sharing.tunnelEnabled)
  const wantTunnel = authReady(sharing) && sharing.tunnelEnabled

  if (wantProxy) await startProxy()
  else { stopTunnel(); stopProxy() }

  if (wantProxy && wantTunnel) {
    if (!state.tunnelProc && state.tunnelStatus !== 'downloading' && state.tunnelStatus !== 'starting') {
      void startTunnel(dataDir)
    }
  } else {
    stopTunnel()
  }
}

export interface SharingStatus {
  authEnabled: boolean
  hasPassword: boolean
  username: string
  lan: { enabled: boolean; running: boolean; url: string | null }
  tunnel: { enabled: boolean; status: TunnelStatus; url: string | null; error: string | null }
}

export async function getSharingStatus(dataDir: string): Promise<SharingStatus> {
  const sharing = await getSharingConfig(dataDir)
  const lanUrl = state.proxyPort && sharing.lanEnabled ? getLanUrl(state.proxyPort) : null
  return {
    authEnabled: sharing.authEnabled,
    hasPassword: !!sharing.passwordHash,
    username: sharing.username,
    lan: { enabled: sharing.lanEnabled, running: !!state.proxy, url: lanUrl },
    tunnel: { enabled: sharing.tunnelEnabled, status: state.tunnelStatus, url: state.tunnelUrl, error: state.tunnelError },
  }
}

/** Stop everything (used on shutdown / tests). */
export function shutdownSharing(): void {
  stopTunnel()
  stopProxy()
}
