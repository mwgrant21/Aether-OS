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
import { createTerminalHub } from './terminalHub';
import type { PtyLike } from './ptyLifecycle';
import type { TerminalReadPort, TerminalSlotId } from '../src/shared/remote/types';

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
let terminalHub: ReturnType<typeof createTerminalHub>;
// Counts what control does to the real read port: outstanding retains and attachments that were never detached.
let spy: { retained: number; attached: number; detached: number };

beforeEach(() => {
  deviceStore = memStore();
  flag = false;
  terminalHub = createTerminalHub();
  spy = { retained: 0, attached: 0, detached: 0 };
  const real = terminalHub.readPort();
  const terminals: TerminalReadPort = {
    list: () => real.list(),
    onState: cb => real.onState(cb),
    attach: (s, q, tap) => {
      spy.attached += 1;
      const h = real.attach(s, q, tap);
      return { detach: () => { spy.detached += 1; h.detach(); } };
    },
    retain: () => {
      spy.retained += 1;
      const release = real.retain();
      let done = false;
      return () => { if (!done) { done = true; spy.retained -= 1; } release(); };
    },
  };
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
    terminals,
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
    expect(welcome).toMatchObject({ t: 'welcome', v: 1, sessions: [
      { s: 'claude', label: 'Terminal', state: 'not-started', cols: 0, rows: 0, q: 0 },
      { s: 'terminal2', label: 'Terminal 2', state: 'not-started', cols: 0, rows: 0, q: 0 },
      { s: 'codex', label: 'Codex', state: 'not-started', cols: 0, rows: 0, q: 0 },
    ], applied: {}, prompts: [] });
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

// ---- terminals: the real terminalHub read port behind the real gateway, over a real ws client ----

const of = (c: Ctl, t: string, s?: string): Array<Record<string, unknown>> => c.msgs.filter(m => m.t === t && (s === undefined || m.s === s));
const settle = (ms = 60) => new Promise<void>(r => setTimeout(r, ms));
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function fakePty(): PtyLike & { sizes: Array<[number, number]>; data(d: string): void; exit(): void } {
  let onData: (d: string) => void = () => {};
  let onExit: () => void = () => {};
  const p = {
    sizes: [] as Array<[number, number]>,
    onData: (cb: (d: string) => void) => { onData = cb; },
    onExit: (cb: () => void) => { onExit = cb; },
    kill: () => {}, write: () => {},
    resize: (c: number, r: number) => { p.sizes.push([c, r]); },
    data: (d: string) => onData(d),
    exit: () => onExit(),
  };
  return p;
}

/** Starts a slot on the real hub and records what the PC-side (renderer) handler receives. */
function startSlot(id: TerminalSlotId, size = { cols: 100, rows: 30 }) {
  const pty = fakePty();
  const pc: string[] = [];
  terminalHub.slot(id).start(() => pty, { onData: d => { pc.push(d); }, onAlive: () => {}, onExit: () => {} }, size);
  return { pty, pc };
}

async function connectAndHello(address: string, token: string): Promise<Ctl> {
  const ctl = await connectCtl(address, token);
  ctl.ws.send(HELLO);
  await waitFor(() => ctl.msgs.length >= 1);
  return ctl;
}
const attach = (c: Ctl, s: string, q?: number) => c.ws.send(JSON.stringify(q === undefined ? { t: 'attach', s } : { t: 'attach', s, q }));

describe('phone control end to end: terminals', () => {
  it('welcome lists the three slots; attach gives a snap then live out; size, state, detach, resume and restart behave', async () => {
    const { address, token } = await pairDevice();
    expect(spy.retained).toBe(1);
    const claude = startSlot('claude');
    claude.pty.data('hello world');
    const ctl = await connectAndHello(address, token);
    const w = ctl.msgs[0] as { t: string; sessions: Array<{ s: string; state: string; cols: number; rows: number; q: number }> };
    expect(w.t).toBe('welcome');
    expect(w.sessions.map(x => [x.s, x.state])).toEqual([['claude', 'running'], ['terminal2', 'not-started'], ['codex', 'not-started']]);
    expect(w.sessions[0]).toMatchObject({ cols: 100, rows: 30 });

    attach(ctl, 'claude');
    await waitFor(() => of(ctl, 'snap').length === 1);
    const snap = of(ctl, 'snap')[0] as { q: number; cols: number; rows: number; d: string };
    expect(snap).toMatchObject({ s: 'claude', cols: 100, rows: 30 });
    expect(snap.d).toContain('hello world');
    expect(snap.q).toBe(w.sessions[0].q);

    claude.pty.data('more');
    await waitFor(() => of(ctl, 'out', 'claude').length === 1);
    expect(of(ctl, 'out')[0]).toMatchObject({ q: snap.q + 1, d: 'more' });

    terminalHub.slot('claude').resize(120, 40);
    await waitFor(() => of(ctl, 'size', 'claude').length === 1);
    expect(of(ctl, 'size')[0]).toMatchObject({ cols: 120, rows: 40 });
    expect(claude.pty.sizes).toEqual([[120, 40]]);

    claude.pty.data('after-resize');
    await waitFor(() => of(ctl, 'out', 'claude').length === 2);
    const lastQ = of(ctl, 'out', 'claude')[1].q as number;
    expect(lastQ).toBe(snap.q + 2);

    // state reaches a ready socket for every slot, whether or not it is attached
    const t2 = startSlot('terminal2');
    await waitFor(() => of(ctl, 'state', 'terminal2').length === 1);
    expect(of(ctl, 'state')[0]).toEqual({ t: 'state', s: 'terminal2', state: 'running' });
    t2.pty.exit();
    await waitFor(() => of(ctl, 'state', 'terminal2').length === 2);
    expect(of(ctl, 'state', 'terminal2')[1]).toMatchObject({ state: 'exited' });
    expect(of(ctl, 'out', 'terminal2')).toEqual([]); // never attached: no terminal frames for it

    // detach -> silence; re-attach with q -> exact resume of what was missed, no snap
    ctl.ws.send(JSON.stringify({ t: 'detach', s: 'claude' }));
    await settle();
    const before = ctl.msgs.length;
    claude.pty.data('while-away');
    await settle();
    expect(ctl.msgs.length).toBe(before);
    attach(ctl, 'claude', lastQ);
    await waitFor(() => of(ctl, 'out', 'claude').length === 3);
    expect(of(ctl, 'out', 'claude')[2]).toEqual({ t: 'out', s: 'claude', q: lastQ + 1, d: 'while-away' });
    expect(of(ctl, 'snap')).toHaveLength(1);

    // restart of an attached slot -> snap with empty d at a fresh q
    const second = startSlot('claude');
    await waitFor(() => of(ctl, 'snap', 'claude').length === 2);
    expect(of(ctl, 'snap', 'claude')[1]).toMatchObject({ s: 'claude', d: '', q: lastQ + 2 });
    second.pty.data('fresh');
    await waitFor(() => of(ctl, 'out', 'claude').length === 4);
    expect(of(ctl, 'out', 'claude')[3]).toMatchObject({ q: lastQ + 3, d: 'fresh' });

    // the PC-side handler saw every chunk of the first pty regardless of the phone
    expect(claude.pc).toEqual(['hello world', 'more', 'after-resize', 'while-away']);
    expect(second.pc).toEqual(['fresh']);
  });

  it('revoke closes the socket and detaches its attachments; the retain stays until control is disabled, then returns to 0', async () => {
    const { address, token } = await pairDevice();
    startSlot('claude').pty.data('x');
    const ctl = await connectAndHello(address, token);
    attach(ctl, 'claude');
    await waitFor(() => of(ctl, 'snap').length === 1);
    expect(spy).toEqual({ retained: 1, attached: 1, detached: 0 });
    await controlHub.revokeOne(controlHub.status().devices[0].ref);
    expect(await ctl.closed).toBe(1000);
    expect(spy).toEqual({ retained: 1, attached: 1, detached: 1 });
    await controlHub.setEnabled(false);
    expect(spy.retained).toBe(0);
  });

  it('disabling control drops the mirror: nothing more is sent, and a later attach starts from an empty mirror', async () => {
    const { address, token } = await pairDevice();
    const claude = startSlot('claude');
    claude.pty.data('secret-ish history');
    const first = await connectAndHello(address, token);
    attach(first, 'claude');
    await waitFor(() => of(first, 'snap').length === 1);
    expect((of(first, 'snap')[0] as { d: string }).d).toContain('secret-ish history');

    await controlHub.setEnabled(false);
    expect(await first.closed).toBe(1000);
    expect(spy.retained).toBe(0);
    const seen = first.msgs.length;
    claude.pty.data('output while off');
    await settle();
    expect(first.msgs.length).toBe(seen);

    const on = await controlHub.setEnabled(true); // disabling does not revoke the device
    expect(spy.retained).toBe(1);
    const second = await connectAndHello(on.address!, token);
    attach(second, 'claude');
    await waitFor(() => of(second, 'snap').length === 1);
    const resnap = of(second, 'snap')[0] as { d: string };
    expect(resnap.d).not.toContain('secret-ish history');
    expect(resnap.d).not.toContain('output while off');
    expect(claude.pc).toEqual(['secret-ish history', 'output while off']);
  });

  it('a 5 MB escape-dense flood while attached is delivered whole, with no slow-consumer bye, and the PC handler sees every chunk', async () => {
    const { address, token } = await pairDevice();
    const claude = startSlot('claude');
    const ctl = await connectAndHello(address, token);
    attach(ctl, 'claude');
    await waitFor(() => of(ctl, 'snap').length === 1);
    const baseQ = (of(ctl, 'snap')[0] as { q: number }).q;

    // every character is an escape byte, so the JSON-escaped wire form is 6x the raw size (D5)
    const chunk = '\u001b[0m'.repeat(8192).slice(0, 16 * 1024);
    const total = Math.ceil((5 * 1024 * 1024) / chunk.length);
    for (let i = 0; i < total; i++) {
      claude.pty.data(chunk);
      await tick();
    }
    await waitFor(() => of(ctl, 'out', 'claude').length === total, 20000);
    expect(of(ctl, 'out', 'claude').map(m => m.q)).toEqual(Array.from({ length: total }, (_, i) => baseQ + 1 + i));
    expect(ctl.msgs.some(m => m.t === 'bye')).toBe(false);
    expect(claude.pc.join('')).toBe(chunk.repeat(total));
  }, 60000);
});
