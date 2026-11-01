import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { VOICE_MAX_PAYLOAD } from '../../src/shared/voice/types';
import { isAllowedHost } from '../remote/remoteAuth';
import { assertBindableHost } from '../remote/tailnet';
import type { RemoteAuthGate } from '../remote/types';
import type { VoiceGatewayPort, VoiceSocket } from './protocol';

export interface VoiceServerOptions {
  host: string;
  port: number;
  auth: RemoteAuthGate;
  gateway: VoiceGatewayPort;
  maxClients?: number;
  onClients?: (n: number) => void;
  log?: (line: string) => void;
  /** Test seam: clock for the incoming-ping window. Defaults to Date.now. */
  now?: () => number;
}

export interface VoiceServerHandle {
  port: number;
  address: string;
  clients(): number;
  closeClients(reason: 'revoked' | 'disabled'): void;
  recheckAuth(): void;
  stop(): Promise<void>;
}

export const VOICE_PAIR_PATH = '/api/voice/pair';
export const VOICE_WS_PATH = '/voice';
/**
 * Byte cap enforced by the ws library per message (parseClientMessage counts UTF-16 units, not bytes, so
 * this is the real memory bound). 16 KiB comfortably holds the largest legitimate frame: a 4000-unit CJK
 * turn is ~12 KB of UTF-8 plus ~100 bytes of JSON. A 16384-unit CJK frame (~48 KB) never reaches the parser.
 */
export const VOICE_WS_MAX_PAYLOAD_BYTES = VOICE_MAX_PAYLOAD;

const PAIR_BODY_CAP = 1024;
const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
const RECHECK_MS = 30_000;
/** Incoming ping control frames allowed per connection per 1 s window (matches the viewer in remoteServer). */
export const VOICE_PING_MAX_PER_SEC = 20;
const ADDRESS_RE = /^[0-9A-Za-z.:[\]-]+$/;

interface Client {
  ws: WebSocket;
  cookie: string | undefined;
  lastPong: number;
  closed: boolean;
  pingWindowStart: number;
  pingCount: number;
  limited: boolean;
}

export async function startVoiceServer(opts: VoiceServerOptions): Promise<VoiceServerHandle> {
  assertBindableHost(opts.host);
  const maxClients = opts.maxClients ?? 1;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const clients = new Set<Client>();
  let address = '';
  let refCounter = 0;

  const bare = (res: http.ServerResponse, status: number, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { ...extra, 'Content-Length': '0' });
    res.end();
  };

  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!isAllowedHost(req.headers.host, address)) return bare(res, 403);
    // Native client only: a browser always sends Origin, so a browser page can never use this endpoint.
    if (req.headers.origin !== undefined) return bare(res, 403);
    if (req.method === 'POST' && req.url === VOICE_PAIR_PATH) return handlePair(req, res);
    return bare(res, 404);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  function handlePair(req: http.IncomingMessage, res: http.ServerResponse): void {
    const ctype = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') return bare(res, 415);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > PAIR_BODY_CAP) {
      bare(res, 413, { Connection: 'close' });
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > PAIR_BODY_CAP) {
        over = true;
        bare(res, 413, { Connection: 'close' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let code: unknown;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: unknown };
        code = parsed && typeof parsed === 'object' ? parsed.code : undefined;
      } catch {
        return bare(res, 400);
      }
      if (typeof code !== 'string') return bare(res, 400);
      const r = opts.auth.redeem(code);
      if (r.ok) return bare(res, 204, { 'Set-Cookie': r.cookie });
      return bare(res, r.status);
    });
    req.on('error', () => {});
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: VOICE_WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });

  const reject = (socket: Duplex, status: number, text: string): void => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (!isAllowedHost(req.headers.host, address)) return reject(socket, 403, 'Forbidden');
    if (req.headers.origin !== undefined) return reject(socket, 403, 'Forbidden');
    if (req.url !== VOICE_WS_PATH) return reject(socket, 404, 'Not Found');
    const cookie = req.headers.cookie;
    if (!opts.auth.isAuthenticated(cookie, { touch: true })) return reject(socket, 401, 'Unauthorized');
    if (clients.size >= maxClients) return reject(socket, 503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, cookie));
  });

  const notify = (): void => opts.onClients?.(clients.size);

  function closeSoon(ws: WebSocket, code: number): void {
    try {
      ws.close(code);
    } catch {
      ws.terminate();
    }
    // A stuck peer must not keep the socket (and the listener) alive.
    const t = setTimeout(() => ws.terminate(), 1000);
    t.unref();
    ws.once('close', () => clearTimeout(t));
  }

  function attach(ws: WebSocket, cookie: string | undefined): void {
    const c: Client = { ws, cookie, lastPong: Date.now(), closed: false, pingWindowStart: now(), pingCount: 0, limited: false };
    const messageCbs: Array<(text: string) => void> = [];
    const closeCbs: Array<() => void> = [];
    clients.add(c);
    ws.on('pong', () => {
      c.lastPong = Date.now();
    });
    // The ws library auto-answers every incoming ping, so a flooding peer is capped here (fixed 1 s window).
    ws.on('ping', () => {
      if (c.closed || c.limited) return;
      const t = now();
      if (t - c.pingWindowStart >= 1000) {
        c.pingWindowStart = t;
        c.pingCount = 0;
      }
      if (++c.pingCount <= VOICE_PING_MAX_PER_SEC) return;
      c.limited = true;
      log(`voice: ping rate limit exceeded max=${VOICE_PING_MAX_PER_SEC}/s`);
      closeSoon(ws, 1008);
    });
    ws.on('message', (data, isBinary) => {
      if (c.closed || c.limited) return;
      if (isBinary) return closeSoon(ws, 1003);
      const text = String(data);
      try {
        for (const cb of messageCbs) cb(text);
      } catch {
        closeSoon(ws, 1011);
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (c.closed) return;
      c.closed = true;
      clients.delete(c);
      for (const cb of closeCbs) {
        try {
          cb();
        } catch {
          // a throwing close listener must not skip the others
        }
      }
      log(`voice: client disconnected n=${clients.size}`);
      notify();
    });
    log(`voice: client connected n=${clients.size}`);
    notify();
    const socket: VoiceSocket = {
      send(text) {
        if (c.closed || ws.readyState !== 1) return;
        ws.send(text);
      },
      close(code) {
        if (c.closed) return;
        closeSoon(ws, code);
      },
      bufferedBytes: () => ws.bufferedAmount,
      onMessage(cb) {
        messageCbs.push(cb);
      },
      onClose(cb) {
        closeCbs.push(cb);
      },
    };
    try {
      opts.gateway.attach(socket, { ref: `c${++refCounter}` });
    } catch {
      closeSoon(ws, 1011);
    }
  }

  const recheckAuth = (): void => {
    for (const c of [...clients]) {
      if (!opts.auth.isAuthenticated(c.cookie, { touch: true })) closeSoon(c.ws, 4001);
    }
  };

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const c of [...clients]) {
      if (now - c.lastPong > PONG_TIMEOUT_MS) c.ws.terminate();
      else if (c.ws.readyState === 1) c.ws.ping();
    }
  }, PING_MS);
  const recheckTimer = setInterval(recheckAuth, RECHECK_MS);
  pingTimer.unref();
  recheckTimer.unref();

  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(opts.port, opts.host, () => {
      server.off('error', rejectListen);
      resolve();
    });
  }).catch((e) => {
    clearInterval(pingTimer);
    clearInterval(recheckTimer);
    throw e;
  });
  const bound = server.address();
  const boundPort = typeof bound === 'object' && bound ? bound.port : opts.port;
  address = `${opts.host}:${boundPort}`;
  if (!ADDRESS_RE.test(address)) {
    server.close();
    clearInterval(pingTimer);
    clearInterval(recheckTimer);
    throw new Error('voice: refusing a malformed bind address');
  }
  server.on('error', () => log('voice: server error'));

  const closeAll = (reason: 'revoked' | 'disabled'): void => {
    for (const c of [...clients]) closeSoon(c.ws, reason === 'revoked' ? 4001 : 1001);
  };

  return {
    port: boundPort,
    address,
    clients: () => clients.size,
    closeClients: closeAll,
    recheckAuth,
    async stop() {
      clearInterval(pingTimer);
      clearInterval(recheckTimer);
      closeAll('disabled');
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
