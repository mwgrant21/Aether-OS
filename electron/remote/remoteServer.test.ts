// @vitest-environment node
import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ChatFeed, RemoteAssets, RemoteAuthGate, ServerMessage } from './types'
import { startRemoteServer, type RemoteServerHandle } from './remoteServer'
import type { ControlIdentity, ControlPairResult, ControlPort, ControlSocket } from '../../src/shared/remote/types'

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
    await until(() => h.clients() === 0) // the server drops the client in its own close handler, which can run after the client's
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


// ---------------------------------------------------------------------------------------------
// Phone control: /ctl, POST /api/device/pair, viewer gating. The ControlPort is a fake; the server
// only transports and gates, so these tests pin the gate order and the wire behaviour.
// ---------------------------------------------------------------------------------------------
const BEARER = 'Bearer good'

interface FakeControl extends ControlPort {
  valid: boolean
  pairResult: ControlPairResult
  auths: Array<{ authorization: string | undefined; peer: string | undefined; touch: boolean | undefined }>
  pairs: Array<{ code: unknown; peer: string | undefined }>
  opened: Array<{ socket: ControlSocket; identity: ControlIdentity }>
  texts: string[]
  closes: number
}

function fakeControl(maxSockets = 2): FakeControl {
  const identity: ControlIdentity = { ref: 'abcdef012345', expiresAtMs: 1, proofFor: () => 'proof' }
  const c: FakeControl = {
    maxSockets,
    valid: true,
    pairResult: { status: 200, token: 'T'.repeat(43), expiresAtMs: 123 },
    auths: [],
    pairs: [],
    opened: [],
    texts: [],
    closes: 0,
    authenticate(authorization, peer, o) {
      c.auths.push({ authorization, peer, touch: o?.touch })
      if (c.valid && authorization === BEARER) return identity
      ;(o as { onReject?: (r: string) => void } | undefined)?.onReject?.(authorization ? 'unknown' : 'no-bearer')
      return null
    },
    async pair(code, peer) {
      c.pairs.push({ code, peer })
      return c.pairResult
    },
    open(socket, id) {
      c.opened.push({ socket, identity: id })
      socket.onMessage((t) => c.texts.push(t))
      socket.onClose(() => c.closes++)
    },
  }
  return c
}

async function bootCtl(over: Partial<Parameters<typeof startRemoteServer>[0]> = {}, ctl = fakeControl()) {
  const r = await boot({ control: ctl, ...over })
  return { ...r, ctl }
}

function ctlOpen(h: RemoteServerHandle, headers: Record<string, string> = { Authorization: BEARER }) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ctl`, { headers })
  const msgs: unknown[] = []
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))))
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  const opened = new Promise<void>((res, rej) => {
    ws.on('open', () => res())
    ws.on('error', rej)
  })
  return { ws, msgs, closed, opened }
}

function upgradeStatus(h: RemoteServerHandle, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${path}`, { headers })
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('open', () => {
      resolve(101)
      ws.close()
    })
    ws.on('error', () => {})
  })
}

const postPair = (h: RemoteServerHandle, o: { headers?: Record<string, string>; body?: string } = {}) =>
  request(h.port, {
    method: 'POST',
    path: '/api/device/pair',
    headers: { 'Content-Type': 'application/json', ...o.headers },
    body: o.body ?? JSON.stringify({ code: 'ABCD2345' }),
  })

describe('POST /api/device/pair', () => {
  it('rejects any Origin header with 403 before the control port is asked', async () => {
    const { h, ctl } = await bootCtl()
    const r = await postPair(h, { headers: { Origin: 'http://evil.example' } })
    expect(r.status).toBe(403)
    expect(ctl.pairs).toEqual([])
  })

  it('returns the token as JSON and passes the code and the peer address through', async () => {
    const { h, ctl } = await bootCtl()
    const r = await postPair(h)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/json')
    expect(JSON.parse(r.body)).toEqual({ token: 'T'.repeat(43), expiresAtMs: 123 })
    expect(ctl.pairs).toEqual([{ code: 'ABCD2345', peer: '127.0.0.1' }])
  })

  it('maps a refusal to a bare status and never echoes a token', async () => {
    const { h, ctl } = await bootCtl()
    for (const status of [401, 403, 429] as const) {
      ctl.pairResult = { status }
      const r = await postPair(h)
      expect(r.status).toBe(status)
      expect(r.body).toBe('')
    }
  })

  it('answers 415 for a non-JSON body, 400 for a missing or non-string code, 413 past 1 KiB', async () => {
    const { h, ctl } = await bootCtl()
    expect((await postPair(h, { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415)
    expect((await postPair(h, { body: '{"code":5}' })).status).toBe(400)
    expect((await postPair(h, { body: 'nope' })).status).toBe(400)
    expect((await postPair(h, { body: JSON.stringify({ code: 'x'.repeat(2000) }) })).status).toBe(413)
    expect(ctl.pairs).toEqual([])
  })

  it('is 404 when control is closed, when no control port exists, and for GET', async () => {
    const closed = await bootCtl({ controlOpen: () => false })
    expect((await postPair(closed.h)).status).toBe(404)
    const none = await boot()
    expect((await postPair(none.h)).status).toBe(404)
    const open = await bootCtl()
    expect((await request(open.h.port, { path: '/api/device/pair' })).status).toBe(404)
  })

  it('still checks the Host header first', async () => {
    const { h } = await bootCtl()
    expect((await request(h.port, { method: 'POST', path: '/api/device/pair', host: 'evil.example', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403)
  })
})

describe('/ctl upgrade', () => {
  it('rejects an Origin header with 403 even with a valid bearer', async () => {
    const { h, ctl } = await bootCtl()
    expect(await upgradeStatus(h, '/ctl', { Authorization: BEARER, Origin: `http://${h.address}` })).toBe(403)
    expect(ctl.auths).toEqual([])
  })

  it('answers 401 for a missing or invalid bearer and for a viewer cookie', async () => {
    const { h, ctl } = await bootCtl()
    expect(await upgradeStatus(h, '/ctl', {})).toBe(401)
    expect(await upgradeStatus(h, '/ctl', { Authorization: 'Bearer nope' })).toBe(401)
    expect(await upgradeStatus(h, '/ctl', { Cookie: GOOD })).toBe(401)
    expect(ctl.opened).toEqual([])
  })

  it('treats two Authorization headers as no credential', async () => {
    const { h, ctl } = await bootCtl()
    const status = await new Promise<string>((resolve) => {
      const s = net.connect(h.port, '127.0.0.1', () => {
        s.write(
          `GET /ctl HTTP/1.1\r\nHost: ${h.address}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: ${BEARER}\r\nAuthorization: ${BEARER}\r\n\r\n`,
        )
      })
      s.once('data', (d) => {
        resolve(String(d).split('\r\n')[0])
        s.destroy()
      })
    })
    expect(status).toContain('401')
    expect(ctl.auths[0]?.authorization).toBeUndefined()
  })

  it('opens with a valid bearer, touches, and hands the socket, identity and peer to control.open once', async () => {
    const { h, ctl } = await bootCtl()
    const c = ctlOpen(h)
    await c.opened
    await until(() => ctl.opened.length === 1)
    expect(ctl.auths).toEqual([{ authorization: BEARER, peer: '127.0.0.1', touch: true }])
    expect(ctl.opened[0].identity.ref).toBe('abcdef012345')
    expect(h.controlClients()).toBe(1)
    c.ws.send('hello')
    await until(() => ctl.texts.length === 1)
    expect(ctl.texts).toEqual(['hello'])
    ctl.opened[0].socket.send('{"t":"welcome"}')
    await until(() => c.msgs.length === 1)
    expect(c.msgs).toEqual([{ t: 'welcome' }])
    expect(ctl.opened[0].socket.bufferedBytes()).toBeGreaterThanOrEqual(0)
    c.ws.close()
    await c.closed
    await until(() => ctl.closes === 1)
    expect(h.controlClients()).toBe(0)
    ctl.opened[0].socket.send('late') // no-op after close
  })

  it('answers 503 for a socket past control.maxSockets and keeps the first two', async () => {
    const { h } = await bootCtl({}, fakeControl(2))
    const a = ctlOpen(h)
    const b = ctlOpen(h)
    await Promise.all([a.opened, b.opened])
    expect(await upgradeStatus(h, '/ctl', { Authorization: BEARER })).toBe(503)
    expect(h.controlClients()).toBe(2)
  })

  it('does not count control sockets against the viewer cap, nor viewers against the control cap', async () => {
    const { h } = await bootCtl({ maxClients: 1 }, fakeControl(1))
    const a = ctlOpen(h)
    await a.opened
    const v = wsOpen(h, goodHeaders(h))
    await v.opened
    expect(h.clients()).toBe(1)
    expect(h.controlClients()).toBe(1)
  })

  it('is 404 when control is closed or absent', async () => {
    const closed = await bootCtl({ controlOpen: () => false })
    expect(await upgradeStatus(closed.h, '/ctl', { Authorization: BEARER })).toBe(404)
    const none = await boot()
    expect(await upgradeStatus(none.h, '/ctl', { Authorization: BEARER })).toBe(404)
  })

  it('logs exactly one fixed reason line for a rejected control upgrade and still answers 401', async () => {
    const lines: string[] = []
    const { h } = await bootCtl({ log: (l) => lines.push(l) })
    expect(await upgradeStatus(h, '/ctl', { Authorization: 'Bearer bad' })).toBe(401)
    expect(lines).toEqual(['remote: control reject reason=unknown'])
  })

  it('logs the recheck reject reason before the revoked bye', async () => {
    const lines: string[] = []
    const { h, ctl } = await bootCtl({ log: (l) => lines.push(l) })
    const c = ctlOpen(h)
    await c.opened
    ctl.valid = false
    h.recheckControl()
    expect(await c.closed).toBe(1000)
    expect(c.msgs).toEqual([{ t: 'bye', reason: 'revoked' }])
    expect(lines).toContain('remote: control recheck reject reason=unknown')
  })

  it('refuses a bearer on /ws: the viewer gate only knows its cookie', async () => {
    const { h } = await bootCtl()
    expect(await upgradeStatus(h, '/ws', { Authorization: BEARER, Origin: `http://${h.address}` })).toBe(401)
  })

  it('closes 1003 on a binary frame', async () => {
    const { h } = await bootCtl()
    const c = ctlOpen(h)
    await c.opened
    c.ws.send(Buffer.from([1, 2, 3]))
    expect(await c.closed).toBe(1003)
  })

  it('allows a text frame between 1 KiB and 64 KiB and closes 1009 past 64 KiB', async () => {
    const { h, ctl } = await bootCtl()
    const a = ctlOpen(h)
    await a.opened
    a.ws.send('x'.repeat(5000))
    await until(() => ctl.texts.length === 1)
    expect(ctl.texts[0]).toHaveLength(5000)
    a.ws.close()
    await a.closed
    const b = ctlOpen(h)
    await b.opened
    b.ws.send('x'.repeat(65537))
    expect(await b.closed).toBe(1009)
  })

  it('sends bye revoked and closes 1000 within one recheckControl() once authenticate returns null', async () => {
    const { h, ctl } = await bootCtl()
    const c = ctlOpen(h)
    await c.opened
    ctl.auths.length = 0
    h.recheckControl()
    expect(ctl.auths).toEqual([{ authorization: BEARER, peer: '127.0.0.1', touch: true }])
    await new Promise((r) => setTimeout(r, 30))
    expect(c.msgs).toEqual([])
    ctl.valid = false
    h.recheckControl()
    expect(await c.closed).toBe(1000)
    expect(c.msgs).toEqual([{ t: 'bye', reason: 'revoked' }])
  })

  it('closeControlClients sends the given reason and leaves viewer sockets alone', async () => {
    const { h } = await bootCtl()
    const c = ctlOpen(h)
    const v = wsOpen(h, goodHeaders(h))
    await Promise.all([c.opened, v.opened])
    h.closeControlClients('disabled')
    expect(await c.closed).toBe(1000)
    expect(c.msgs).toEqual([{ t: 'bye', reason: 'disabled' }])
    expect(v.ws.readyState).toBe(1)
  })

  it('reports the control client count through onControlClients and logs fixed strings only', async () => {
    const counts: number[] = []
    const lines: string[] = []
    const { h } = await bootCtl({ onControlClients: (n) => counts.push(n), log: (l) => lines.push(l) })
    const c = ctlOpen(h)
    await c.opened
    c.ws.close()
    await c.closed
    await until(() => counts.length >= 2)
    expect(counts).toEqual([1, 0])
    expect(lines).toEqual(['remote: control client connected n=1', 'remote: control client disconnected n=0'])
    expect(lines.join(' ')).not.toContain('good')
  })

  it('stop() sends bye disabled to control clients', async () => {
    const { h } = await bootCtl()
    const c = ctlOpen(h)
    await c.opened
    handles = handles.filter((x) => x !== h)
    await h.stop()
    expect(await c.closed).toBe(1000)
    expect(c.msgs).toEqual([{ t: 'bye', reason: 'disabled' }])
  })

  it('uses a 64 KiB frame cap for control and keeps the viewer at 1 KiB', async () => {
    const { h } = await bootCtl()
    const v = wsOpen(h, goodHeaders(h))
    await v.opened
    v.ws.send('x'.repeat(1025))
    expect(await v.closed).toBe(1009)
  })
})

describe('viewer gating', () => {
  it('answers 404 on every viewer route while viewerOpen() is false, and keeps the control routes up', async () => {
    const { h, ctl } = await bootCtl({ viewerOpen: () => false })
    for (const path of ['/pair', '/assets/pair.js', '/assets/app.css', '/', '/assets/viewer.js']) {
      expect((await request(h.port, { path, headers: { Cookie: GOOD } })).status).toBe(404)
    }
    const pair = await request(h.port, { method: 'POST', path: '/api/pair', headers: { 'Content-Type': 'application/json', Origin: `http://${h.address}` }, body: '{"code":"X"}' })
    expect(pair.status).toBe(404)
    expect(await upgradeStatus(h, '/ws', { Origin: `http://${h.address}`, Cookie: GOOD })).toBe(404)
    expect((await postPair(h)).status).toBe(200)
    const c = ctlOpen(h)
    await c.opened
    expect(ctl.opened).toHaveLength(1)
  })

  it('still checks the Host header before the 404', async () => {
    const { h } = await bootCtl({ viewerOpen: () => false })
    expect((await request(h.port, { path: '/pair', host: 'evil.example' })).status).toBe(403)
  })

  it('reads viewerOpen() on every request, so the viewer opens and closes without a restart', async () => {
    let open = false
    const { h } = await bootCtl({ viewerOpen: () => open })
    expect((await request(h.port, { path: '/pair' })).status).toBe(404)
    open = true
    expect((await request(h.port, { path: '/pair' })).status).toBe(200)
    open = false
    expect((await request(h.port, { path: '/pair' })).status).toBe(404)
  })

  it('serves the viewer exactly as before when control is absent', async () => {
    const { h } = await boot()
    expect((await request(h.port, { path: '/pair' })).status).toBe(200)
    expect(h.controlClients()).toBe(0)
  })
})
