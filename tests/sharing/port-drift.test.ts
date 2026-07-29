import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createTempDir } from '../setup'
import { createApp } from '@/server/api'
import { shutdownSharing, getSharingStatus } from '@/server/sharing/manager'

/**
 * When the preferred share port is taken the proxy drifts upward, and the port it
 * advertises has to be the one it landed on.
 *
 * It used to advertise the port it had just failed to bind: `server.listen(port,
 * cb)` registers `cb` as a one-shot 'listening' listener, and the failed attempt
 * removed only its 'error' listener, so the successful retry fired the stale
 * callback first and resolved with the old port. The QR code and LAN URL then
 * pointed at whatever else held that port — on a dev machine also running a
 * release build, that is a second Errata with a different data directory, which
 * looks like "my phone connects but there are no stories". `startTunnel` feeds
 * the same number to `cloudflared --url`.
 */
describe('sharing proxy port drift', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  let squatter: Server
  let squattedPort: number
  let previousSharePort: string | undefined

  /** Holds the preferred port and answers unmistakably if anyone reaches it. */
  function startSquatter(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      squatter = createServer((_req, res) => { res.writeHead(200); res.end('SQUATTER') })
      squatter.once('error', reject)
      squatter.listen(port, '0.0.0.0', () => resolve())
    })
  }

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    app = createApp(dataDir)
    // Away from 7740, which a live app on this machine may hold.
    squattedPort = 22000 + Math.floor(Math.random() * 2000)
    previousSharePort = process.env.ERRATA_SHARE_PORT
    process.env.ERRATA_SHARE_PORT = String(squattedPort)
    await startSquatter(squattedPort)
  })

  afterEach(async () => {
    shutdownSharing()
    if (previousSharePort === undefined) delete process.env.ERRATA_SHARE_PORT
    else process.env.ERRATA_SHARE_PORT = previousSharePort
    squatter.closeAllConnections()
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
    await cleanup()
  })

  it('advertises the port it bound, not the one it failed on', async () => {
    const post = (path: string, body: unknown) => app.fetch(new Request(`http://localhost/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }))
    await post('/sharing/auth', { enabled: true, username: 'me', password: 'pw' })
    await post('/sharing/lan', { enabled: true })

    const status = await getSharingStatus(dataDir)
    expect(status.lan.url, 'LAN sharing should be running').toBeTruthy()
    const advertised = Number(new URL(status.lan.url!).port)

    expect(advertised, 'must not advertise the occupied port').not.toBe(squattedPort)

    // The advertised port has to answer as our proxy. Without credentials that
    // is a 401 — reaching the squatter's 200 instead means we sent users to a
    // stranger's server.
    const res = await fetch(`http://127.0.0.1:${advertised}/`)
    expect({ status: res.status, body: await res.text() })
      .toEqual({ status: 401, body: 'Authentication required.' })
  })
})
