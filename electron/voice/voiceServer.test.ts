// @vitest-environment node
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { RemoteAuthGate } from '../remote/types';
import type { VoiceGatewayPort, VoiceSocket } from './protocol';
import { startVoiceServer, type VoiceServerHandle } from './voiceServer';

const GOOD_COOKIE = 'aether_remote=good';

function fakeAuth() {
  const state = { valid: true };
  const gate: RemoteAuthGate = {
    isAuthenticated: (cookie) => state.valid && cookie === GOOD_COOKIE,
    redeem: (code) => {
      if (code === 'AAAA-BBBB') return { ok: true, cookie: GOOD_COOKIE + '; HttpOnly' };
      return { ok: false, status: code === 'LOCKED' ? 429 : 401 };
    },
  };
  return { state, gate };
}

function fakeGateway() {
  const attached: Array<{ socket: VoiceSocket; ref: string }> = [];
  const received: string[] = [];
  const port: VoiceGatewayPort = {
    attach(socket, identity) {
      attached.push({ socket, ref: identity.ref });
      socket.onMessage((t) => received.push(t));
      return { close: () => {} };
    },
  };
  return { port, attached, received };
}

let running: VoiceServerHandle | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

async function boot(maxClients?: number) {
  const auth = fakeAuth();
  const gw = fakeGateway();
  running = await startVoiceServer({ host: '127.0.0.1', port: 0, auth: auth.gate, gateway: gw.port, maxClients });
  return { srv: running, auth, gw };
}

function request(
  srv: VoiceServerHandle,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_HDR = { 'Content-Type': 'application/json' };

/** Resolves with the open socket, or the HTTP status of a refused upgrade. */
function connect(
  srv: VoiceServerHandle,
  opts: { path?: string; cookie?: string | null; origin?: string; host?: string } = {},
): Promise<{ ws: WebSocket } | { status: number }> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== null) headers.Cookie = opts.cookie ?? GOOD_COOKIE;
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  if (opts.host !== undefined) headers.Host = opts.host;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}${opts.path ?? '/voice'}`, { headers });
    ws.on('open', () => resolve({ ws }));
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.destroy();
    });
    ws.on('error', () => resolve({ status: 0 }));
  });
}

const closeCode = (ws: WebSocket): Promise<number> => new Promise((r) => ws.on('close', (c) => r(c)));
const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('startVoiceServer bind guard', () => {
  it.each(['0.0.0.0', '::', '192.168.1.3', 'localhost'])('rejects host %s and listens nowhere', async (host) => {
    const { gate } = fakeAuth();
    await expect(startVoiceServer({ host, port: 0, auth: gate, gateway: fakeGateway().port })).rejects.toThrow();
  });

  it('binds exactly opts.host', async () => {
    const { srv } = await boot();
    expect(srv.address).toBe(`127.0.0.1:${srv.port}`);
  });
});

describe('HTTP surface', () => {
  it('403 on a wrong Host, even with a good cookie', async () => {
    const { srv } = await boot();
    const r = await request(srv, 'POST', '/api/voice/pair', { ...JSON_HDR, Host: 'evil.example', Cookie: GOOD_COOKIE }, '{"code":"AAAA-BBBB"}');
    expect(r.status).toBe(403);
  });

  it('403 on any Origin header for POST, even a matching one', async () => {
    const { srv } = await boot();
    for (const origin of ['http://evil.example', `http://127.0.0.1:${srv.port}`]) {
      const r = await request(srv, 'POST', '/api/voice/pair', { ...JSON_HDR, Origin: origin }, '{"code":"AAAA-BBBB"}');
      expect(r.status).toBe(403);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });

  it('every non-pair route is a bare 404 with security headers', async () => {
    const { srv } = await boot();
    for (const p of ['/', '/pair', '/voice', '/assets/app.css', '/api/voice/pair', '/api/pair']) {
      const r = await request(srv, 'GET', p, { Cookie: GOOD_COOKIE });
      expect(r.status).toBe(404);
      expect(r.body).toBe('');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    }
    expect((await request(srv, 'POST', '/other', JSON_HDR, '{}')).status).toBe(404);
  });

  it('pair: 204 + Set-Cookie on success; 401/429 pass through; 415; 413', async () => {
    const { srv } = await boot();
    const ok = await request(srv, 'POST', '/api/voice/pair', JSON_HDR, '{"code":"AAAA-BBBB"}');
    expect(ok.status).toBe(204);
    expect(String(ok.headers['set-cookie'])).toContain('aether_remote=good');
    expect((await request(srv, 'POST', '/api/voice/pair', JSON_HDR, '{"code":"nope"}')).status).toBe(401);
    expect((await request(srv, 'POST', '/api/voice/pair', JSON_HDR, '{"code":"LOCKED"}')).status).toBe(429);
    expect((await request(srv, 'POST', '/api/voice/pair', { 'Content-Type': 'text/plain' }, 'x')).status).toBe(415);
    const big = JSON.stringify({ code: 'x'.repeat(2000) });
    expect((await request(srv, 'POST', '/api/voice/pair', JSON_HDR, big)).status).toBe(413);
  });
});

describe('WebSocket upgrade', () => {
  it('attaches an authenticated client with a per-connection ref', async () => {
    const { srv, gw } = await boot();
    const r = await connect(srv);
    expect('ws' in r).toBe(true);
    await tick();
    expect(gw.attached.map((a) => a.ref)).toEqual(['c1']);
    expect(srv.clients()).toBe(1);
    if ('ws' in r) r.ws.close();
  });

  it('401 and no socket without a valid cookie', async () => {
    const { srv, gw } = await boot();
    expect(await connect(srv, { cookie: null })).toEqual({ status: 401 });
    expect(await connect(srv, { cookie: 'aether_remote=bad' })).toEqual({ status: 401 });
    expect(gw.attached).toHaveLength(0);
  });

  it('403 on any Origin header, even a matching one, and a good cookie', async () => {
    const { srv, gw } = await boot();
    expect(await connect(srv, { origin: 'http://evil.example' })).toEqual({ status: 403 });
    expect(await connect(srv, { origin: `http://127.0.0.1:${srv.port}` })).toEqual({ status: 403 });
    expect(gw.attached).toHaveLength(0);
  });

  it('403 on a wrong Host', async () => {
    const { srv } = await boot();
    expect(await connect(srv, { host: 'evil.example' })).toEqual({ status: 403 });
  });

  it.each(['/voice/', '/VOICE', '//voice', '/voice?x=1', '/%76oice', '/ws'])('path %s never upgrades', async (p) => {
    const { srv, gw } = await boot();
    const r = await connect(srv, { path: p });
    expect('ws' in r).toBe(false);
    expect(gw.attached).toHaveLength(0);
  });

  it('503 for a second client at maxClients 1', async () => {
    const { srv } = await boot(1);
    const a = await connect(srv);
    expect('ws' in a).toBe(true);
    expect(await connect(srv)).toEqual({ status: 503 });
    if ('ws' in a) a.ws.close();
  });

  it('a binary frame closes the socket with 1003', async () => {
    const { srv, gw } = await boot();
    const r = await connect(srv);
    if (!('ws' in r)) throw new Error('no ws');
    const code = closeCode(r.ws);
    r.ws.send(Buffer.from([1, 2, 3]));
    expect(await code).toBe(1003);
    expect(gw.received).toHaveLength(0);
  });

  it('text frames reach the gateway socket', async () => {
    const { srv, gw } = await boot();
    const r = await connect(srv);
    if (!('ws' in r)) throw new Error('no ws');
    r.ws.send('{"t":"resume","lastSeq":0}');
    await tick();
    expect(gw.received).toEqual(['{"t":"resume","lastSeq":0}']);
    r.ws.close();
  });

  it('a 17 KiB frame is rejected by the library (1009) and never reaches the gateway', async () => {
    const { srv, gw } = await boot();
    const r = await connect(srv);
    if (!('ws' in r)) throw new Error('no ws');
    const code = closeCode(r.ws);
    r.ws.send('a'.repeat(17 * 1024));
    expect(await code).toBe(1009);
    expect(gw.received).toHaveLength(0);
  });

  it('an oversize multi-byte frame (6000 CJK units, ~18 KB, under the 16384-unit parser cap) is rejected by the byte cap', async () => {
    const { srv, gw } = await boot();
    const r = await connect(srv);
    if (!('ws' in r)) throw new Error('no ws');
    const text = '漢'.repeat(6000);
    expect(text.length).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(text)).toBeGreaterThan(16 * 1024);
    const code = closeCode(r.ws);
    r.ws.send(text);
    expect(await code).toBe(1009);
    expect(gw.received).toHaveLength(0);
  });

  it('a 4000-unit CJK frame (legitimate maximum, ~12 KB) is delivered', async () => {
    const { srv, gw } = await boot();
    const r = await connect(srv);
    if (!('ws' in r)) throw new Error('no ws');
    const text = '漢'.repeat(4000);
    r.ws.send(text);
    await tick();
    expect(gw.received).toEqual([text]);
    r.ws.close();
  });

  it('recheckAuth closes a client whose cookie went invalid with 4001', async () => {
    const { srv, auth } = await boot();
    const r = await connect(srv);
    if (!('ws' in r)) throw new Error('no ws');
    const code = closeCode(r.ws);
    auth.state.valid = false;
    srv.recheckAuth();
    expect(await code).toBe(4001);
  });

  it('closeClients uses 1001 for disabled and 4001 for revoked', async () => {
    const { srv } = await boot(2);
    const a = await connect(srv);
    const b = await connect(srv);
    if (!('ws' in a) || !('ws' in b)) throw new Error('no ws');
    const ca = closeCode(a.ws);
    srv.closeClients('disabled');
    expect(await ca).toBe(1001);
    const c = await connect(srv);
    if (!('ws' in c)) throw new Error('no ws');
    const cc = closeCode(c.ws);
    srv.closeClients('revoked');
    expect(await cc).toBe(4001);
  });

  it('stop() closes sockets and the port refuses afterwards', async () => {
    const { srv } = await boot();
    const r = await connect(srv);
    if (!('ws' in r)) throw new Error('no ws');
    const code = closeCode(r.ws);
    const port = srv.port;
    await srv.stop();
    running = null;
    expect(await code).toBe(1001);
    await expect(
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, resolve);
        req.on('error', reject);
        req.end();
      }),
    ).rejects.toThrow();
  });
});
