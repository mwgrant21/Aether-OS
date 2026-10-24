import http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CONTROL_PAIR_BODY_CAP,
  CONTROL_PAIR_PATH,
  CONTROL_PATH,
  CONTROL_RECHECK_MS,
  REMOTE_MAX_CLIENTS,
  type ControlIdentity,
  type ControlPort,
  type ControlSocket,
} from '../../src/shared/remote/types'
import type { ChatFeed, RemoteAssets, RemoteAuthGate, ServerMessage } from './types'
import { isAllowedHost, isAllowedOrigin } from './remoteAuth'
import { contentSecurityPolicy } from './remotePages'
import { assertBindableHost } from './tailnet'

export interface RemoteServerOptions {
  host: string
  port: number
  auth: RemoteAuthGate
  feed: ChatFeed
  assets: RemoteAssets
  maxClients?: number
  onClients?: (n: number) => void
  /** Phone-control logic, injected; the server only transports and gates. Absent = no control routes. */
  control?: ControlPort
  /** False = every viewer route (pages, assets, POST /api/pair, /ws) answers 404. Default: open. */
  viewerOpen?: () => boolean
  /** False = /ctl and POST /api/device/pair answer 404. Default: open when `control` is given. */
  controlOpen?: () => boolean
  onControlClients?: (n: number) => void
  log?: (line: string) => void
}

export interface RemoteServerHandle {
  port: number
  address: string
  clients(): number
  closeClients(reason: 'revoked' | 'disabled'): void
  recheckAuth(): void
  closeControlClients(reason: 'revoked' | 'disabled'): void
  recheckControl(): void
  controlClients(): number
  stop(): Promise<void>
}

const PAIR_BODY_CAP = CONTROL_PAIR_BODY_CAP // viewer and device pairing share the 1 KiB cap
const PING_MS = 25_000
const PONG_TIMEOUT_MS = 60_000
const RECHECK_MS = 30_000
const SLOW_CONSUMER_BYTES = 1024 * 1024
const PING_WINDOW_MS = 1000
const MAX_PINGS_PER_WINDOW = 20
const ADDRESS_RE = /^[0-9A-Za-z.:[\]-]+$/

interface Client {
  ws: WebSocket
  cookie: string | undefined
  lastPong: number
  pingWindowStart: number
  pingCount: number
  leave: () => void
  closed: boolean
}

interface CtlClient {
  ws: WebSocket
  authorization: string | undefined
  peer: string | undefined
  lastPong: number
  pingWindowStart: number
  pingCount: number
  closed: boolean
  messageCbs: Array<(text: string) => void>
  closeCbs: Array<() => void>
}

export async function startRemoteServer(opts: RemoteServerOptions): Promise<RemoteServerHandle> {
  assertBindableHost(opts.host)
  const maxClients = opts.maxClients ?? REMOTE_MAX_CLIENTS
  const log = opts.log ?? (() => {})
  const clients = new Set<Client>()
  const ctlClients = new Set<CtlClient>()
  const control = opts.control
  const viewerOpen = opts.viewerOpen ?? (() => true)
  const controlOpen = opts.controlOpen ?? (() => control !== undefined)
  // Filled in after listen(); the only Host/Origin/CSP source. Never req.headers.host.
  let address = ''
  let csp = ''

  const bare = (res: http.ServerResponse, status: number, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { ...extra, 'Content-Length': '0' })
    res.end()
  }
  const body = (res: http.ServerResponse, type: string, text: string): void => {
    const buf = Buffer.from(text, 'utf8')
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(buf.length) })
    res.end(buf)
  }
  const securityHeaders = (res: http.ServerResponse): void => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', csp)
  }

  const server = http.createServer((req, res) => {
    securityHeaders(res)
    if (!isAllowedHost(req.headers.host, address)) return bare(res, 403)
    const method = req.method
    if (method !== 'GET' && method !== 'POST') return bare(res, 405)
    const path = (req.url ?? '').split('?')[0]

    if (method === 'POST') {
      if (path === CONTROL_PAIR_PATH) {
        if (!control || !controlOpen()) return bare(res, 404)
        return handleDevicePair(control, req, res)
      }
      if (path !== '/api/pair' || !viewerOpen()) return bare(res, 404)
      return handlePair(req, res)
    }
    if (!viewerOpen()) return bare(res, 404)
    switch (path) {
      case '/pair':
        return body(res, 'text/html; charset=utf-8', opts.assets.pairHtml)
      case '/assets/pair.js':
        return body(res, 'application/javascript; charset=utf-8', opts.assets.pairJs)
      case '/assets/app.css':
        return body(res, 'text/css; charset=utf-8', opts.assets.appCss)
      case '/':
        if (!opts.auth.isAuthenticated(req.headers.cookie)) return bare(res, 302, { Location: '/pair' })
        return body(res, 'text/html; charset=utf-8', opts.assets.viewerHtml)
      case '/assets/viewer.js':
        if (!opts.auth.isAuthenticated(req.headers.cookie)) return bare(res, 401)
        return body(res, 'application/javascript; charset=utf-8', opts.assets.viewerJs)
      default:
        return bare(res, 404)
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000

  function handlePair(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!isAllowedOrigin(req.headers.origin, address)) return bare(res, 403)
    readCode(req, res, (code) => {
      const r = opts.auth.redeem(code)
      if (r.ok) return bare(res, 204, { 'Set-Cookie': r.cookie })
      return bare(res, r.status)
    })
  }

  // The phone is a native client and sends no Origin: any Origin header means a browser page is calling.
  function handleDevicePair(ctl: ControlPort, req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers.origin !== undefined) return bare(res, 403)
    // The answer can legitimately wait on a native confirm dialog; nothing here times the response side.
    readCode(req, res, (code) => {
      ctl.pair(code, req.socket.remoteAddress).then(
        (r) => {
          if (r.status !== 200) return bare(res, r.status)
          const buf = Buffer.from(JSON.stringify({ token: r.token, expiresAtMs: r.expiresAtMs }), 'utf8')
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(buf.length) })
          res.end(buf)
        },
        () => bare(res, 500),
      )
    })
  }

  // Shared by both pairing routes: JSON content type, 1 KiB cap, a string `code` field.
  function readCode(req: http.IncomingMessage, res: http.ServerResponse, onCode: (code: string) => void): void {
    const ctype = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (ctype !== 'application/json') return bare(res, 415)
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > PAIR_BODY_CAP) {
      bare(res, 413, { Connection: 'close' })
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      size += c.length
      if (size > PAIR_BODY_CAP) {
        over = true
        bare(res, 413, { Connection: 'close' })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (over) return
      let code: unknown
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: unknown }
        code = parsed && typeof parsed === 'object' ? parsed.code : undefined
      } catch {
        return bare(res, 400)
      }
      if (typeof code !== 'string') return bare(res, 400)
      onCode(code)
    })
    req.on('error', () => {})
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
    clientTracking: false,
  })
  // /ctl frames carry JSON control messages (hello today), so the cap is 64 KiB, not the viewer's 1 KiB.
  const ctlWss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
    clientTracking: false,
  })

  const reject = (socket: Duplex, status: number, text: string): void => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    if (!isAllowedHost(req.headers.host, address)) return reject(socket, 403, 'Forbidden')
    const path = (req.url ?? '').split('?')[0]
    if (path === CONTROL_PATH) return upgradeControl(req, socket, head)
    if (path !== '/ws' || !viewerOpen()) return reject(socket, 404, 'Not Found')
    if (!isAllowedOrigin(req.headers.origin, address)) return reject(socket, 403, 'Forbidden')
    const cookie = req.headers.cookie
    if (!opts.auth.isAuthenticated(cookie, { touch: true })) return reject(socket, 401, 'Unauthorized')
    if (clients.size >= maxClients) return reject(socket, 503, 'Service Unavailable')
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, cookie))
  })

  // Node keeps only the first of duplicate Authorization headers; a second one is an attack shape, so refuse it.
  const authorizationOf = (req: http.IncomingMessage): string | undefined =>
    req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'authorization').length > 1
      ? undefined
      : req.headers.authorization

  function upgradeControl(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!control || !controlOpen()) return reject(socket, 404, 'Not Found')
    if (req.headers.origin !== undefined) return reject(socket, 403, 'Forbidden')
    const authorization = authorizationOf(req)
    const peer = req.socket.remoteAddress
    let identity: ControlIdentity | null = null
    try {
      identity = control.authenticate(authorization, peer, {
        touch: true,
        onReject: (r) => log(`remote: control reject reason=${r}`),
      })
    } catch {
      identity = null
    }
    if (!identity) return reject(socket, 401, 'Unauthorized')
    if (ctlClients.size >= control.maxSockets) return reject(socket, 503, 'Service Unavailable')
    const who = identity
    ctlWss.handleUpgrade(req, socket, head, (ws) => attachControl(control, ws, authorization, peer, who))
  }

  function notify(): void {
    opts.onClients?.(clients.size)
  }

  function notifyControl(): void {
    opts.onControlClients?.(ctlClients.size)
  }

  function sendMsg(c: Client, m: ServerMessage): void {
    if (c.closed || c.ws.readyState !== 1) return
    c.ws.send(JSON.stringify(m))
    if (c.ws.bufferedAmount > SLOW_CONSUMER_BYTES) bye(c, 'slow-consumer')
  }

  function bye(c: Client, reason: 'revoked' | 'disabled' | 'slow-consumer'): void {
    if (c.closed) return
    try {
      if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'bye', reason } satisfies ServerMessage))
      c.ws.close(reason === 'slow-consumer' ? 1008 : 1000)
    } catch {
      c.ws.terminate()
    }
    // A stuck peer must not keep the socket (and the listener) alive.
    const t = setTimeout(() => c.ws.terminate(), 1000)
    t.unref()
    c.ws.once('close', () => clearTimeout(t))
  }

  function attach(ws: WebSocket, cookie: string | undefined): void {
    const c: Client = { ws, cookie, lastPong: Date.now(), pingWindowStart: 0, pingCount: 0, leave: () => {}, closed: false }
    clients.add(c)
    ws.on('pong', () => {
      c.lastPong = Date.now()
    })
    // ws auto-pongs every ping into its send queue; a client that floods pings without reading
    // would grow server memory, so cap the rate and the queued bytes here.
    ws.on('ping', () => {
      if (c.closed || ws.readyState !== 1) return
      const now = Date.now()
      if (now - c.pingWindowStart >= PING_WINDOW_MS) {
        c.pingWindowStart = now
        c.pingCount = 0
      }
      if (++c.pingCount > MAX_PINGS_PER_WINDOW) {
        ws.close(1008)
        const t = setTimeout(() => ws.terminate(), 1000)
        t.unref()
        ws.once('close', () => clearTimeout(t))
        return
      }
      if (ws.bufferedAmount > SLOW_CONSUMER_BYTES) bye(c, 'slow-consumer')
    })
    // The protocol has no client-to-server message: any frame closes the socket.
    ws.on('message', () => {
      ws.close(1008)
    })
    ws.on('error', () => {})
    ws.on('close', () => {
      if (c.closed) return
      c.closed = true
      c.leave()
      clients.delete(c)
      log(`remote: client disconnected n=${clients.size}`)
      notify()
    })
    log(`remote: client connected n=${clients.size}`)
    notify()
    const h = opts.feed.join((m) => sendMsg(c, m))
    c.leave = () => h.leave()
    if (c.closed) h.leave()
  }

  function byeControl(c: CtlClient, reason: 'revoked' | 'disabled' | 'slow-consumer'): void {
    if (c.closed) return
    try {
      if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'bye', reason }))
      c.ws.close(reason === 'slow-consumer' ? 1008 : 1000)
    } catch {
      c.ws.terminate()
    }
    const t = setTimeout(() => c.ws.terminate(), 1000)
    t.unref()
    c.ws.once('close', () => clearTimeout(t))
  }

  function attachControl(
    ctl: ControlPort,
    ws: WebSocket,
    authorization: string | undefined,
    peer: string | undefined,
    identity: ControlIdentity,
  ): void {
    const c: CtlClient = {
      ws,
      authorization,
      peer,
      lastPong: Date.now(),
      pingWindowStart: 0,
      pingCount: 0,
      closed: false,
      messageCbs: [],
      closeCbs: [],
    }
    ctlClients.add(c)
    const closeSoon = (code: number): void => {
      try {
        ws.close(code)
      } catch {
        ws.terminate()
      }
      const t = setTimeout(() => ws.terminate(), 1000)
      t.unref()
      ws.once('close', () => clearTimeout(t))
    }
    ws.on('pong', () => {
      c.lastPong = Date.now()
    })
    ws.on('ping', () => {
      if (c.closed || ws.readyState !== 1) return
      const now = Date.now()
      if (now - c.pingWindowStart >= PING_WINDOW_MS) {
        c.pingWindowStart = now
        c.pingCount = 0
      }
      if (++c.pingCount > MAX_PINGS_PER_WINDOW) return closeSoon(1008)
      if (ws.bufferedAmount > SLOW_CONSUMER_BYTES) byeControl(c, 'slow-consumer')
    })
    ws.on('message', (data, isBinary) => {
      if (c.closed) return
      if (isBinary) return closeSoon(1003)
      const text = String(data) // default binaryType: a Buffer holding validated UTF-8
      try {
        for (const cb of c.messageCbs) cb(text)
      } catch {
        closeSoon(1011)
      }
    })
    ws.on('error', () => {})
    ws.on('close', () => {
      if (c.closed) return
      c.closed = true
      ctlClients.delete(c)
      for (const cb of c.closeCbs) {
        try {
          cb()
        } catch {
          // a throwing close listener must not skip the others
        }
      }
      log(`remote: control client disconnected n=${ctlClients.size}`)
      notifyControl()
    })
    log(`remote: control client connected n=${ctlClients.size}`)
    notifyControl()
    const socket: ControlSocket = {
      send(text) {
        if (c.closed || ws.readyState !== 1) return
        ws.send(text)
        if (ws.bufferedAmount > SLOW_CONSUMER_BYTES) byeControl(c, 'slow-consumer')
      },
      close(code) {
        if (c.closed) return
        closeSoon(code)
      },
      bufferedBytes: () => ws.bufferedAmount,
      onMessage(cb) {
        c.messageCbs.push(cb)
      },
      onClose(cb) {
        c.closeCbs.push(cb)
      },
    }
    try {
      ctl.open(socket, identity)
    } catch {
      closeSoon(1011)
    }
  }

  const recheckControl = (): void => {
    if (!control) return
    for (const c of [...ctlClients]) {
      let still = false
      try {
        still =
          control.authenticate(c.authorization, c.peer, {
            touch: true,
            onReject: (r) => log(`remote: control recheck reject reason=${r}`),
          }) !== null
      } catch {
        still = false
      }
      if (!still) byeControl(c, 'revoked')
    }
  }

  const recheckAuth = (): void => {
    for (const c of [...clients]) {
      if (!opts.auth.isAuthenticated(c.cookie, { touch: true })) bye(c, 'revoked')
    }
  }

  const pingTimer = setInterval(() => {
    const now = Date.now()
    for (const c of [...clients]) {
      if (now - c.lastPong > PONG_TIMEOUT_MS) c.ws.terminate()
      else if (c.ws.bufferedAmount > SLOW_CONSUMER_BYTES) bye(c, 'slow-consumer')
      else if (c.ws.readyState === 1) c.ws.ping()
    }
    for (const c of [...ctlClients]) {
      if (now - c.lastPong > PONG_TIMEOUT_MS) c.ws.terminate()
      else if (c.ws.bufferedAmount > SLOW_CONSUMER_BYTES) byeControl(c, 'slow-consumer')
      else if (c.ws.readyState === 1) c.ws.ping()
    }
  }, PING_MS)
  const recheckTimer = setInterval(recheckAuth, RECHECK_MS)
  pingTimer.unref()
  recheckTimer.unref()
  const ctlRecheckTimer = control ? setInterval(recheckControl, CONTROL_RECHECK_MS) : undefined
  ctlRecheckTimer?.unref()

  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(opts.port, opts.host, () => {
      server.off('error', rejectListen)
      resolve()
    })
  }).catch((e) => {
    clearInterval(pingTimer)
    clearInterval(recheckTimer)
    clearInterval(ctlRecheckTimer)
    throw e
  })
  const bound = server.address()
  const boundPort = typeof bound === 'object' && bound ? bound.port : opts.port
  address = `${opts.host}:${boundPort}`
  if (!ADDRESS_RE.test(address)) {
    server.close()
    throw new Error('remote: refusing a malformed bind address')
  }
  csp = contentSecurityPolicy(address)
  server.on('error', () => log('remote: server error'))

  return {
    port: boundPort,
    address,
    clients: () => clients.size,
    closeClients(reason) {
      for (const c of [...clients]) bye(c, reason)
    },
    recheckAuth,
    closeControlClients(reason) {
      for (const c of [...ctlClients]) byeControl(c, reason)
    },
    recheckControl,
    controlClients: () => ctlClients.size,
    async stop() {
      clearInterval(pingTimer)
      clearInterval(recheckTimer)
      clearInterval(ctlRecheckTimer)
      for (const c of [...clients]) bye(c, 'disabled')
      for (const c of [...ctlClients]) byeControl(c, 'disabled')
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
