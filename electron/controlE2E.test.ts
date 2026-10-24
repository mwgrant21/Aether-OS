// @vitest-environment node
// End to end for phone control V1: the real remote hub, control hub, device auth and listener, driven by a real ws client
// and real HTTP against 127.0.0.1. The "Tailscale" interface is injected (a 100.64.x address on an interface named
// Tailscale) and the server is rebound to loopback on a random port, exactly like electron/remote/remoteHub.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { createRemoteHub, type RemoteHub } from './remote/remoteHub';
import { startRemoteServer } from './remote/remoteServer';
import { createControlHub, type ControlHub } from './control/controlHub';
import type { StoredSession } from './remote/types';

const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../protocol/mobile-protocol.json'), 'utf8'));
const HELLO: string = spec.frames.hello;
const NONCE: string = JSON.parse(HELLO).nonce;

const tailnetIfaces = () =>
  ({ Tailscale: [{ address: '100.64.0.9', family: 'IPv4', internal: false }] }) as unknown as ReturnType<typeof import('node:os').networkInterfaces>;

// Independent recomputation of the proof from the JSON's algorithm text (not from remoteAuth.serverProof).
function expectedProof(token: string, nonce: string): string {
  const key = createHash('sha256').update(token, 'utf8').digest();
  return createHmac('sha256', key).update(`server\n${nonce}\n/ctl`, 'utf8').digest('hex');
}

function memStore() {
  const st = {
    data: [] as StoredSession[],
    load: () => st.data.map(s => ({ ...s })),
    save: async (list: StoredSession[]) => { st.data = list.map(s => ({ ...s })); },
  };
  return st;
}

interface Reply { status: number; body: string }
function request(address: string, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const [host, port] = address.split(':');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host, port: Number(port), path: urlPath, method,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

interface Ctl { ws: WebSocket; msgs: Array<Record<string, unknown>>; closed: Promise<number> }
type CtlResult = { open: Ctl } | { status: number };
const sockets: WebSocket[] = [];

function openWs(address: string, urlPath: string, headers: Record<string, string>): Promise<CtlResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${address}${urlPath}`, { headers });
    sockets.push(ws);
    const msgs: Array<Record<string, unknown>> = [];
    ws.on('message', d => { msgs.push(JSON.parse(String(d))); });
    const closed = new Promise<number>(r => ws.on('close', c => r(c)));
    ws.on('open', () => resolve({ open: { ws, msgs, closed } }));
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
    ws.on('error', e => { if (!/Unexpected server response/.test(String(e))) reject(e); });
  });
}

async function connectCtl(address: string, token: string): Promise<Ctl> {
  const r = await openWs(address, '/ctl', { Authorization: `Bearer ${token}` });
  if (!('open' in r)) throw new Error(`ctl refused ${r.status}`);
  return r.open;
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

let remoteHub: RemoteHub;
let controlHub: ControlHub;
let deviceStore: ReturnType<typeof memStore>;
let confirmPair: ReturnType<typeof vi.fn>;
let flag: boolean;

beforeEach(() => {
  deviceStore = memStore();
  flag = false;
  confirmPair = vi.fn(async () => true);
  remoteHub = createRemoteHub({
    resolveSession: () => null,
    store: memStore(),
    networkInterfaces: tailnetIfaces,
    startServer: (o => startRemoteServer({ ...o, host: '127.0.0.1', port: 0 })) as typeof startRemoteServer,
  });
  controlHub = createControlHub({
    listener: remoteHub.listenerPort(),
    store: deviceStore,
    settings: { read: () => flag, persist: on => { flag = on; return flag; } },
    confirmPair: (peer, replaces) => confirmPair(peer, replaces),
    renderQr: () => '<svg/>',
  });
  remoteHub.attachControl(controlHub.port);
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await controlHub.stop();
  await remoteHub.stop();
});

/** Enables control, pairs one device through the real HTTP route and returns its token. */
async function pairDevice(): Promise<{ address: string; token: string; expiresAtMs: number }> {
  const on = await controlHub.setEnabled(true);
  if (on.state !== 'on' || !on.address) throw new Error(`not on: ${on.state}`);
  const made = await controlHub.createPairing();
  if (!made.ok) throw new Error('no pairing');
  const r = await request(on.address, 'POST', '/api/device/pair', { code: made.code });
  if (r.status !== 200) throw new Error(`pair ${r.status}`);
  const j = JSON.parse(r.body) as { token: string; expiresAtMs: number };
  return { address: on.address, token: j.token, expiresAtMs: j.expiresAtMs };
}

describe('phone control end to end (real ws)', () => {
  it('pair, then hello gets a welcome whose proof is the independently computed HMAC', async () => {
    const on = await controlHub.setEnabled(true);
    const address = on.address!;
    const made = await controlHub.createPairing();
    if (!made.ok) throw new Error('no pairing');

    const pair = await request(address, 'POST', '/api/device/pair', { code: made.code });
    expect(pair.status).toBe(200);
    const { token, expiresAtMs } = JSON.parse(pair.body) as { token: string; expiresAtMs: number };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAtMs).toBeGreaterThan(Date.now());
    expect(confirmPair).toHaveBeenCalledWith('127.0.0.1', false);

    const ctl = await connectCtl(address, token);
    ctl.ws.send(HELLO);
    await waitFor(() => ctl.msgs.length === 1);
    const welcome = ctl.msgs[0];
    expect(welcome).toMatchObject({ t: 'welcome', v: 1, sessions: [], applied: {}, prompts: [] });
    expect(welcome.proof).toBe(expectedProof(token, NONCE));
    expect(welcome.expiresAtMs as number).toBeGreaterThan(Date.now());
    expect(controlHub.status().connected).toBe(1);

    // the pairing code is single use
    expect((await request(address, 'POST', '/api/device/pair', { code: made.code })).status).toBe(401);
    // status never carries the code or the token
    expect(JSON.stringify(controlHub.status())).not.toContain(made.code);
    expect(JSON.stringify(controlHub.status())).not.toContain(token);
  });

  it('a wrong code is 401, and five wrong guesses burn the pairing (429)', async () => {
    const on = await controlHub.setEnabled(true);
    const made = await controlHub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    for (let i = 0; i < 5; i++) expect((await request(on.address!, 'POST', '/api/device/pair', { code: 'AAAAAAAA' })).status).toBe(401);
    expect((await request(on.address!, 'POST', '/api/device/pair', { code: made.code })).status).toBe(429);
  });

  it('a declined confirm is 403 and pairs nothing', async () => {
    confirmPair.mockResolvedValue(false);
    const on = await controlHub.setEnabled(true);
    const made = await controlHub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    expect((await request(on.address!, 'POST', '/api/device/pair', { code: made.code })).status).toBe(403);
    expect(controlHub.status().devices).toHaveLength(0);
    expect(deviceStore.data).toHaveLength(0);
  });

  it('a pair request carrying an Origin is refused (403)', async () => {
    const on = await controlHub.setEnabled(true);
    const made = await controlHub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const r = await request(on.address!, 'POST', '/api/device/pair', { code: made.code }, { Origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(confirmPair).not.toHaveBeenCalled();
  });

  it('/ctl refuses no token, a viewer-shaped cookie and any Origin; a revoked token', async () => {
    const { address, token } = await pairDevice();
    expect(await openWs(address, '/ctl', {})).toEqual({ status: 401 });
    expect(await openWs(address, '/ctl', { Cookie: `aether_remote=${token}` })).toEqual({ status: 401 });
    expect(await openWs(address, '/ctl', { Authorization: `Bearer ${token}`, Origin: `http://${address}` })).toEqual({ status: 403 });
    expect(await openWs(address, '/ctl', { Authorization: `Bearer ${'A'.repeat(43)}` })).toEqual({ status: 401 });

    await controlHub.revokeAll();
    expect(await openWs(address, '/ctl', { Authorization: `Bearer ${token}` })).toEqual({ status: 401 });
  });

  it('revoking while connected sends bye revoked and closes promptly', async () => {
    const { address, token } = await pairDevice();
    const ctl = await connectCtl(address, token);
    ctl.ws.send(HELLO);
    await waitFor(() => ctl.msgs.length === 1);
    const ref = controlHub.status().devices[0].ref;
    const started = Date.now();
    await controlHub.revokeOne(ref);
    expect(await ctl.closed).toBe(1000);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ctl.msgs.at(-1)).toEqual({ t: 'bye', reason: 'revoked' });
  });

  it('disabling control sends bye disabled to a live socket', async () => {
    const { address, token } = await pairDevice();
    const ctl = await connectCtl(address, token);
    ctl.ws.send(HELLO);
    await waitFor(() => ctl.msgs.length === 1);
    await controlHub.setEnabled(false);
    expect(await ctl.closed).toBe(1000);
    expect(ctl.msgs.some(m => m.t === 'bye' && m.reason === 'disabled')).toBe(true);
    expect(controlHub.status().devices).toHaveLength(1); // disabling does not revoke
  });

  it('a second socket with the same token supersedes the first', async () => {
    const { address, token } = await pairDevice();
    const first = await connectCtl(address, token);
    first.ws.send(HELLO);
    await waitFor(() => first.msgs.length === 1);
    const second = await connectCtl(address, token);
    second.ws.send(HELLO);
    await waitFor(() => second.msgs.length === 1);
    expect(await first.closed).toBe(1000);
    expect(first.msgs.at(-1)).toEqual({ t: 'bye', reason: 'superseded' });
    expect(second.msgs[0]).toMatchObject({ t: 'welcome' });
  });

  it('viewer routes are 404 while only control is enabled; enabling the viewer opens /pair without touching control', async () => {
    const { address, token } = await pairDevice();
    for (const p of ['/pair', '/', '/assets/x.js']) expect((await request(address, 'GET', p)).status).toBe(404);
    expect((await request(address, 'POST', '/api/pair', { code: 'AAAA-AAAA' }, { 'Content-Type': 'application/json', Origin: `http://${address}` })).status).toBe(404);
    expect(await openWs(address, '/ws', { Origin: `http://${address}` })).toEqual({ status: 404 });

    const viewer = await remoteHub.setEnabled(true);
    expect(viewer.state).toBe('on');
    expect((await request(address, 'GET', '/pair')).status).toBe(200);
    expect(controlHub.status().state).toBe('on');
    const ctl = await connectCtl(address, token);
    ctl.ws.send(HELLO);
    await waitFor(() => ctl.msgs.length === 1);
    expect(ctl.msgs[0]).toMatchObject({ t: 'welcome' });

    // a control token is not a viewer cookie
    expect(await openWs(address, '/ws', { Cookie: `aether_remote=${token}`, Origin: `http://${address}` })).toEqual({ status: 401 });
  });
});
