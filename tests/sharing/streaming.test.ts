import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createTempDir } from '../setup'
import { createApp } from '@/server/api'
import { shutdownSharing, getSharingStatus } from '@/server/sharing/manager'

/**
 * Generation is an NDJSON stream over a POST, read incrementally by the client.
 * The proxy has to forward it as it arrives: if it holds the body until the
 * upstream finishes, a remote client sees a request that never produces anything
 * while the generation runs fine on the server — the "it seems to fire but
 * nothing happens" shape.
 */
describe('sharing proxy response streaming', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  let upstream: Server
  let previousPort: string | undefined
  let previousSharePort: string | undefined
  /** The live upstream response, once a request has reached the stub. */
  let live: Promise<ServerResponse>
  /** Written by the stub before anything else, so headers cannot deadlock. */
  let preamble = ''

  function startUpstream(): Promise<number> {
    return new Promise((resolve) => {
      let arrive: (res: ServerResponse) => void
      live = new Promise((r) => { arrive = r })
      upstream = createServer((req, res) => {
        req.resume() // drain the request body like the real endpoint would
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.flushHeaders()
        if (preamble) res.write(preamble)
        arrive(res)
      })
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port))
    })
  }

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    app = createApp(dataDir)
    preamble = ''
    const upstreamPort = await startUpstream()
    previousPort = process.env.PORT
    process.env.PORT = String(upstreamPort)
    previousSharePort = process.env.ERRATA_SHARE_PORT
    process.env.ERRATA_SHARE_PORT = String(24000 + Math.floor(Math.random() * 2000))
  })

  afterEach(async () => {
    shutdownSharing()
    if (previousPort === undefined) delete process.env.PORT
    else process.env.PORT = previousPort
    if (previousSharePort === undefined) delete process.env.ERRATA_SHARE_PORT
    else process.env.ERRATA_SHARE_PORT = previousSharePort
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
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
    expect(status.lan.url, 'LAN sharing should be running').toBeTruthy()
    return Number(new URL(status.lan.url!).port)
  }

  function generate(port: number) {
    return fetch(`http://127.0.0.1:${port}/api/stories/s1/generate`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('me:pw').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: 'go' }),
    })
  }

  it('delivers each line as it is written, not at the end', async () => {
    // A first line lands with the headers, mirroring a server that announces the
    // run before the model produces anything.
    preamble = `${JSON.stringify({ type: 'run-started', runId: 'gen-1' })}\n`
    const port = await enableLanSharing('pw')

    const res = await generate(port)
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const next = async () => {
      const { value, done } = await reader.read()
      return done ? null : decoder.decode(value)
    }

    expect(await next()).toContain('run-started')

    // These resolve only if the proxy flushed mid-response. A proxy that buffered
    // would leave the read pending until the upstream ended.
    const upstreamRes = await live
    upstreamRes.write(`${JSON.stringify({ type: 'text', text: 'the room was' })}\n`)
    expect(await next()).toContain('the room was')

    upstreamRes.write(`${JSON.stringify({ type: 'text', text: ' still warm' })}\n`)
    expect(await next()).toContain('still warm')

    upstreamRes.end()
    expect(await next()).toBeNull()
  })

  it('passes the response head through before any body arrives', async () => {
    // A generation can take a long time to produce its first token. The status
    // and headers should not wait on it: a client that has not even had its
    // response head answered cannot tell "working" from "broken".
    const port = await enableLanSharing('pw')

    const res = await Promise.race([
      generate(port),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
    ])

    expect(res, 'response head should arrive without waiting for body bytes').not.toBe('timeout')
    expect((res as Response).status).toBe(200)
    ;(await live).end()
  })
})
