import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createTempDir } from '../setup'
import { createApp } from '@/server/api'
import { shutdownSharing, getSharingStatus } from '@/server/sharing/manager'
import { getSharingConfig } from '@/server/config/storage'
import { checkBasicAuth } from '@/server/sharing/auth'

/**
 * The sharing proxy forwards protocol upgrades, not only plain HTTP.
 *
 * It used to register a request handler and nothing else, so a WebSocket
 * upgrade was answered as an ordinary request and the socket died. A built app
 * opens no sockets, so production never noticed; the dev server's HMR socket is
 * one, which is why remote access looked broken only in dev. The auth gate must
 * cover this path too — a socket that skipped Basic auth would be an
 * unauthenticated way into the app.
 */
describe('sharing proxy upgrades', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  let upstream: Server
  let upstreamPort: number
  let previousPort: string | undefined
  let previousSharePort: string | undefined

  /** Stands in for the local app: accepts any upgrade and says so. */
  function startUpstream(): Promise<number> {
    return new Promise((resolve) => {
      upstream = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
      upstream.on('upgrade', (_req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      })
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port))
    })
  }

  /** Send a raw upgrade request and return the status line. */
  function upgrade(port: number, authorization?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: '127.0.0.1', port }, () => {
        sock.write(
          'GET / HTTP/1.1\r\n'
          + `Host: 127.0.0.1:${port}\r\n`
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + 'Sec-WebSocket-Version: 13\r\n'
          + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`
          + (authorization ? `Authorization: ${authorization}\r\n` : '')
          + '\r\n',
        )
      })
      let buf = ''
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1')
        if (!buf.includes('\r\n')) return
        sock.destroy()
        resolve(buf.split('\r\n')[0])
      })
      sock.on('error', reject)
      setTimeout(() => { sock.destroy(); reject(new Error('upgrade timed out')) }, 5000)
    })
  }

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    app = createApp(dataDir)
    upstreamPort = await startUpstream()
    previousPort = process.env.PORT
    process.env.PORT = String(upstreamPort)
    // Keep off the default share port: a live app on this machine holds it, and
    // landing on its fallback would authenticate against its config, not ours.
    previousSharePort = process.env.ERRATA_SHARE_PORT
    process.env.ERRATA_SHARE_PORT = String(21000 + Math.floor(Math.random() * 2000))
  })

  afterEach(async () => {
    shutdownSharing()
    // Restore the environment first: these are process-wide, and a slow socket
    // teardown must not leak PORT into whatever test runs next.
    if (previousPort === undefined) delete process.env.PORT
    else process.env.PORT = previousPort
    if (previousSharePort === undefined) delete process.env.ERRATA_SHARE_PORT
    else process.env.ERRATA_SHARE_PORT = previousSharePort
    // An upgraded socket is detached from the server, so neither close() nor
    // closeAllConnections() is guaranteed to settle once a tunnel is open.
    // Ask nicely, then stop waiting.
    upstream.closeAllConnections()
    upstream.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await cleanup()
  })

  async function enableLanSharing(password: string): Promise<number> {
    const post = (path: string, body: unknown) => app.fetch(new Request(`http://localhost/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }))
    await post('/sharing/auth', { enabled: true, username: 'me', password })
    await post('/sharing/lan', { enabled: true })
    const status = await getSharingStatus(dataDir)
    const url = status.lan.url
    expect(url, 'LAN sharing should be running').toBeTruthy()
    return Number(new URL(url!).port)
  }

  it('refuses an upgrade that carries no credentials', async () => {
    const port = await enableLanSharing('pw')
    expect(await upgrade(port)).toContain('401')
  })

  it('refuses an upgrade whose credentials are wrong', async () => {
    const port = await enableLanSharing('pw')
    const wrong = `Basic ${Buffer.from('me:nope').toString('base64')}`
    expect(await upgrade(port, wrong)).toContain('401')
  })

  it('forwards an authorized upgrade to the app', async () => {
    const port = await enableLanSharing('pw')
    const good = `Basic ${Buffer.from('me:pw').toString('base64')}`
    // The same credentials on the ordinary path, so a failure here is a
    // credentials problem rather than an upgrade-forwarding one.
    const stored = await getSharingConfig(dataDir)
    expect({ user: stored.username, ok: checkBasicAuth(good, stored.username, stored.passwordHash) })
      .toEqual({ user: 'me', ok: true })
    const plain = await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: good } })
    expect(plain.status, `plain HTTP on port ${port} should accept these credentials`).toBe(200)
    expect(await upgrade(port, good)).toContain('101')
  })
})
