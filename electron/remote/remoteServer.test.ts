// @vitest-environment node
import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ChatFeed, RemoteAssets, RemoteAuthGate, ServerMessage } from './types'
import { startRemoteServer, type RemoteServerHandle } from './remoteServer'

const ASSETS: RemoteAssets = {
  pairHtml: '<p>PAIR_HTML</p>',
  pairJs: 'PAIR_JS',
  viewerHtml: '<p>VIEWER_HTML</p>',
  viewerJs: 'VIEWER_JS_BYTES',
  appCss: 'APP_CSS',
}
const GOOD = 'aether_remote=good'

function fakeAuth(): RemoteAuthGate & { valid: boolean; redeemResult: ReturnType<RemoteAuthGate['redeem']>; touches: number } {
  const a = {
    valid: true,
    touches: 0,
    redeemResult: { ok: true, cookie: 'aether_remote=issued; HttpOnly' } as ReturnType<RemoteAuthGate['redeem']>,
    isAuthenticated(cookie: string | undefined, opts?: { touch?: boolean }) {
      if (opts?.touch) a.touches++
      return a.valid && cookie === GOOD
    },
    redeem() {
      return a.redeemResult
    },
  }
  return a
}

function fakeFeed(): ChatFeed & { calls: string[]; push(m: ServerMessage): void; leaves: number } {
  const listeners = new Set<(m: ServerMessage) => void>()
  const f = {
    calls: [] as string[],
    leaves: 0,
    join(l: (m: ServerMessage) => void) {
      f.calls.push('join')
      l({ t: 'session', attached: true, title: 'T' })
      l({ t: 'history', events: [] })
      listeners.add(l)
      return {
        leave() {
          f.leaves++
          listeners.delete(l)
        },
      }
    },
    push(m: ServerMessage) {
      for (const l of listeners) l(m)
    },
  }
  return f
}

let handles: RemoteServerHandle[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const h of handles) await h.stop()
  handles = []
})

async function boot(over: Partial<Parameters<typeof startRemoteServer>[0]> = {}) {
  const auth = fakeAuth()
  const feed = fakeFeed()
  const h = await startRemoteServer({ host: '127.0.0.1', port: 0, auth, feed, assets: ASSETS, ...over })
  handles.push(h)
  return { h, auth, feed }
}

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}
function request(
  port: number,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: string; host?: string },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: o.method ?? 'GET',
        path: o.path,
        headers: { Host: o.host ?? `127.0.0.1:${port}`, ...o.headers },
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end(o.body)
  })
}

function wsOpen(h: RemoteServerHandle, headers: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers })
  const msgs: ServerMessage[] = []
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))))
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  const opened = new Promise<void>((res, rej) => {
    ws.on('open', () => res())
    ws.on('error', rej)
  })
  return { ws, msgs, closed, opened }
}
const goodHeaders = (h: RemoteServerHandle) => ({ Origin: `http://${h.address}`, Cookie: GOOD })

function wsStatus(h: RemoteServerHandle, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers })
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('open', () => resolve(101))
    ws.on('error', () => {})
  })
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(cond()).toBe(true)
}

describe('bind', () => {
  it.each(['0.0.0.0', '::', '192.168.1.3'])('refuses %s and listens on nothing', async (host) => {
    const listen = vi.spyOn(http.Server.prototype, 'listen')
    await expect(startRemoteServer({ host, port: 0, auth: fakeAuth(), feed: fakeFeed(), assets: ASSETS })).rejects.toThrow(
      /non-tailnet/,
    )
    expect(listen).not.toHaveBeenCalled()
    listen.mockRestore()
  })

  it('listens on exactly the host it was given', async () => {
    const listen = vi.spyOn(http.Server.prototype, 'listen')
    const { h } = await boot()
    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen.mock.calls[0][1]).toBe('127.0.0.1')
    listen.mockRestore()
    expect(h.address).toBe(`127.0.0.1:${h.port}`)
  })

  it('stop() leaves no listener', async () => {
    const { h } = await boot()
    const port = h.port
    const { ws, opened } = wsOpen(h, goodHeaders(h))
    await opened
    await h.stop()
    expect(ws.readyState).toBeGreaterThanOrEqual(2)
    await expect(request(port, { path: '/pair' })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await new Promise<void>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.on('error', () => resolve())
      s.on('connect', () => {
        s.destroy()
        throw new Error('still listening')
      })
    })
  })
})

describe('http', () => {
  it('rejects a wrong or missing Host with 403 and an empty body, even with a valid cookie', async () => {
    const { h } = await boot()
    for (const host of ['evil.test', `127.0.0.1:${h.port + 1}`]) {
      for (const path of ['/pair', '/', '/nope']) {
        const r = await request(h.port, { path, host, headers: { Cookie: GOOD } })
        expect(r.status).toBe(403)
        expect(r.body).toBe('')
      }
    }
  })

  it('serves the public routes unauthenticated with the CSP built from the bind address', async () => {
    const { h } = await boot()
    const pair = await request(h.port, { path: '/pair' })
    expect(pair.status).toBe(200)
    expect(pair.body).toBe(ASSETS.pairHtml)
    expect((await request(h.port, { path: '/assets/pair.js' })).body).toBe('PAIR_JS')
    expect((await request(h.port, { path: '/assets/app.css' })).body).toBe('APP_CSS')
    expect(pair.headers['content-security-policy']).toContain(`ws://${h.address}`)
    expect(pair.headers['cache-control']).toBe('no-store')
    expect(pair.headers['x-content-type-options']).toBe('nosniff')
    expect(pair.headers['x-frame-options']).toBe('DENY')
    expect(pair.headers['referrer-policy']).toBe('no-referrer')
  })

  it('never puts the request Host in the CSP (an injected Host is a 403, the CSP stays on the bind address)', async () => {
    const { h } = await boot()
    const bad = await request(h.port, { path: '/pair', host: "evil.test; script-src *" })
    expect(bad.status).toBe(403)
    expect(bad.headers['content-security-policy']).not.toContain('evil')
    // Same address, different case: allowed, but the CSP is still the configured one.
    const ok = await request(h.port, { path: '/pair', host: `127.0.0.1:${h.port}`.toUpperCase() })
    expect(ok.headers['content-security-policy']).toContain(`ws://127.0.0.1:${h.port}`)
  })

  it('redirects / to /pair and refuses viewer.js without a cookie, serves both with one', async () => {
    const { h } = await boot()
    const root = await request(h.port, { path: '/' })
    expect(root.status).toBe(302)
    expect(root.headers.location).toBe('/pair')
    expect(root.body).toBe('')
    expect((await request(h.port, { path: '/assets/viewer.js' })).status).toBe(401)
    const js = await request(h.port, { path: '/assets/viewer.js', headers: { Cookie: GOOD } })
    expect(js.status).toBe(200)
    expect(js.body).toBe('VIEWER_JS_BYTES')
    expect((await request(h.port, { path: '/', headers: { Cookie: GOOD } })).body).toBe(ASSETS.viewerHtml)
  })

  it('never returns viewer bytes to an unauthenticated path trick', async () => {
    const { h } = await boot()
    for (const path of [
      '//assets/viewer.js',
      '/assets/../assets/viewer.js',
      '/assets/%2e%2e/assets/viewer.js',
      '/assets/viewer.js/',
      '/Assets/viewer.js',
      '/ws/',
      '/WS',
      '/%2e%2e/',
      '/?x=/pair',
    ]) {
      const r = await request(h.port, { path })
      expect(r.body, path).not.toContain('VIEWER')
      expect([302, 401, 404], path).toContain(r.status)
    }
  })

  it('answers HEAD and OPTIONS with 405', async () => {
    const { h } = await boot()
    expect((await request(h.port, { method: 'HEAD', path: '/pair' })).status).toBe(405)
    expect((await request(h.port, { method: 'OPTIONS', path: '/api/pair' })).status).toBe(405)
  })
})

describe('POST /api/pair', () => {
  const post = (h: RemoteServerHandle, o: { origin?: string; type?: string; body?: string }) =>
    request(h.port, {
      method: 'POST',
      path: '/api/pair',
      headers: {
        ...(o.origin === undefined ? {} : { Origin: o.origin }),
        'Content-Type': o.type ?? 'application/json',
      },
      body: o.body ?? '{"code":"ABCD-EFGH"}',
    })

  it('rejects a missing or foreign Origin with 403', async () => {
    const { h } = await boot()
    expect((await post(h, {})).status).toBe(403)
    expect((await post(h, { origin: 'http://evil.test' })).status).toBe(403)
    expect((await post(h, { origin: `http://${h.address}.evil.test` })).status).toBe(403)
  })

  it('rejects a wrong content type with 415', async () => {
    const { h } = await boot()
    expect((await post(h, { origin: `http://${h.address}`, type: 'text/plain' })).status).toBe(415)
  })

  it('caps the body: 413 for an oversize body, and the code never reaches auth', async () => {
    const { h, auth } = await boot()
    const redeem = vi.spyOn(auth, 'redeem')
    const r = await post(h, { origin: `http://${h.address}`, body: JSON.stringify({ code: 'x'.repeat(4000) }) }).catch(
      () => ({ status: 413 }),
    )
    expect(r.status).toBe(413)
    expect(redeem).not.toHaveBeenCalled()
  })

  it('issues Set-Cookie with 204 on success and passes 401 and 429 through', async () => {
    const { h, auth } = await boot()
    const origin = `http://${h.address}`
    const ok = await post(h, { origin })
    expect(ok.status).toBe(204)
    expect(ok.headers['set-cookie']).toEqual(['aether_remote=issued; HttpOnly'])
    auth.redeemResult = { ok: false, status: 429 }
    expect((await post(h, { origin })).status).toBe(429)
    auth.redeemResult = { ok: false, status: 401 }
    const bad = await post(h, { origin })
    expect(bad.status).toBe(401)
    expect(bad.body).toBe('')
    expect((await post(h, { origin, body: '{"code":5}' })).status).toBe(400)
  })
})

describe('websocket', () => {
  it('completes no upgrade without a cookie, with a bad Origin, a bad path or a bad Host', async () => {
    const { h, feed } = await boot()
    const origin = `http://${h.address}`
    expect(await wsStatus(h, { Origin: origin })).toBe(401)
    expect(await wsStatus(h, { Origin: origin, Cookie: 'aether_remote=nope' })).toBe(401)
    expect(await wsStatus(h, { Origin: 'http://evil.test', Cookie: GOOD })).toBe(403)
    expect(await wsStatus(h, { Cookie: GOOD })).toBe(403)
    expect(await wsStatus(h, { Origin: origin, Cookie: GOOD, Host: 'evil.test' })).toBe(403)
    expect(feed.calls).toEqual([])
    expect(h.clients()).toBe(0)
  })

  it('sends session then history first to an authenticated client, and live events after', async () => {
    const { h, feed } = await boot()
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    await until(() => c.msgs.length >= 2)
    expect(c.msgs.map((m) => m.t)).toEqual(['session', 'history'])
    feed.push({ t: 'bye', reason: 'policy' })
    await until(() => c.msgs.length === 3)
    c.ws.close()
  })

  it('closes 1008 on any inbound frame and forwards nothing', async () => {
    const { h, feed } = await boot()
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    c.ws.send('{"t":"input","data":"rm -rf"}')
    expect(await c.closed).toBe(1008)
    expect(feed.calls).toEqual(['join'])
    await until(() => h.clients() === 0)
    expect(feed.leaves).toBe(1)
  })

  it('answers the 4th client with 503', async () => {
    const { h } = await boot()
    const open = [1, 2, 3].map(() => wsOpen(h, goodHeaders(h)))
    await Promise.all(open.map((c) => c.opened))
    expect(await wsStatus(h, goodHeaders(h))).toBe(503)
    expect(h.clients()).toBe(3)
    open.forEach((c) => c.ws.close())
  })

  it('reports the live client count through onClients', async () => {
    const counts: number[] = []
    const { h } = await boot({ onClients: (n) => counts.push(n) })
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    c.ws.close()
    await until(() => counts.length >= 2)
    expect(counts).toEqual([1, 0])
  })

  it('recheckAuth() closes an open socket immediately after a revoke, with bye revoked', async () => {
    const { h, auth } = await boot()
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    await until(() => c.msgs.length >= 2)
    auth.valid = false
    h.recheckAuth()
    await c.closed
    expect(c.msgs.at(-1)).toEqual({ t: 'bye', reason: 'revoked' })
    expect(h.clients()).toBe(0)
  })

  it('re-validates every 30 s so a mid-connection expiry closes the socket', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { h, auth } = await boot()
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    auth.valid = false
    vi.advanceTimersByTime(30_000)
    await c.closed
    expect(c.msgs.at(-1)).toEqual({ t: 'bye', reason: 'revoked' })
    expect(auth.touches).toBeGreaterThanOrEqual(2)
  })

  it('closeClients sends bye with the given reason', async () => {
    const { h } = await boot()
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    await until(() => c.msgs.length >= 2)
    h.closeClients('disabled')
    await c.closed
    expect(c.msgs.at(-1)).toEqual({ t: 'bye', reason: 'disabled' })
  })

  it('delivers a history frame larger than 65536 bytes intact', async () => {
    const big = 'x'.repeat(100_000)
    const feed = fakeFeed()
    feed.join = (l) => {
      l({ t: 'session', attached: true, title: null })
      l({
        t: 'history',
        events: [{ k: 'msg', id: '0:0', atMs: 1, role: 'you', text: big, truncated: false, tools: [] }],
      })
      return { leave() {} }
    }
    const { h } = await boot({ feed })
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    await until(() => c.msgs.length >= 2)
    expect(JSON.stringify(c.msgs[1]).length).toBeGreaterThan(65536)
    c.ws.close()
  })

  it('cuts off a slow consumer past 1 MiB buffered', async () => {
    const feed = fakeFeed()
    let push: (m: ServerMessage) => void = () => {}
    feed.join = (l) => {
      push = l
      return { leave() {} }
    }
    const { h } = await boot({ feed })
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    c.ws.pause()
    ;(c.ws as unknown as { _socket: net.Socket })._socket.pause()
    const text = 'y'.repeat(900_000)
    for (let i = 0; i < 40 && h.clients() > 0; i++) {
      push({ t: 'event', event: { k: 'msg', id: `${i}:0`, atMs: 1, role: 'claude', text, truncated: false, tools: [] } })
      await new Promise((r) => setTimeout(r, 5))
    }
    await until(() => h.clients() === 0)
  })

  it('closes 1008 promptly on a ping flood from a client that never reads', async () => {
    const { h } = await boot()
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    ;(c.ws as unknown as { _socket: net.Socket })._socket.pause()
    const rss0 = process.memoryUsage().rss
    const t0 = Date.now()
    for (let i = 0; i < 200 && h.clients() > 0; i++) {
      for (let j = 0; j < 500; j++) c.ws.ping()
      await new Promise((r) => setTimeout(r, 5))
    }
    await until(() => h.clients() === 0)
    const ms = Date.now() - t0
    const rssMb = Math.round((process.memoryUsage().rss - rss0) / 1048576)
    console.info(`ping flood closed in ${ms} ms, rss delta ${rssMb} MB (client and server share this process)`)
    expect(ms).toBeLessThan(2000)
  })

  it('allows a normal ping rate', async () => {
    const { h } = await boot()
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    for (let i = 0; i < 15; i++) c.ws.ping()
    await new Promise((r) => setTimeout(r, 100))
    expect(h.clients()).toBe(1)
    c.ws.close()
  })

  it('logs fixed strings only', async () => {
    const lines: string[] = []
    const { h } = await boot({ log: (l) => lines.push(l) })
    const c = wsOpen(h, goodHeaders(h))
    await c.opened
    c.ws.close()
    await until(() => lines.length >= 2)
    expect(lines).toEqual(['remote: client connected n=1', 'remote: client disconnected n=0'])
  })
})
