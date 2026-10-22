// @vitest-environment node
import http from 'node:http';
import net from 'node:net';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createChatFeed } from './chatFeed';
import { createRemoteHub, REVOKE_UNSAVED_NOTICE, type RemoteHub } from './remoteHub';
import { createReplayBuffer, type ReplayBuffer } from './replayBuffer';
import { startRemoteServer } from './remoteServer';
import type { RemoteStatus } from '../../src/shared/remote/types';
import type { ServerMessage, SessionStorePort, StoredSession } from './types';

const TS = '2026-10-21T10:00:00.000Z';
const MARKER = 'TRANSCRIPT-MARKER-7731';
const u = (text: string): string =>
  JSON.stringify({ type: 'user', timestamp: TS, message: { role: 'user', content: text } }) + '\n';
const TAILNET_IP = '100.64.0.5';
const tailnetIfaces = () => ({
  Tailscale: [{ address: TAILNET_IP, family: 'IPv4', internal: false }],
}) as any;

let dir: string;
let file: string;
let hubs: RemoteHub[];
let sockets: WebSocket[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remotehub-'));
  file = join(dir, 'a.jsonl');
  writeFileSync(file, u(`${MARKER} seeded`));
  hubs = [];
  sockets = [];
});
afterEach(async () => {
  for (const s of sockets) s.terminate();
  for (const h of hubs) await h.stop();
  rmSync(dir, { recursive: true, force: true });
});

function fakeStore(initial: StoredSession[] = []) {
  const st = {
    data: initial,
    failSaves: false,
    saves: 0,
    load: () => st.data.map((s) => ({ ...s })),
    save: async (list: StoredSession[]) => {
      st.saves++;
      if (st.failSaves) throw new Error('disk full');
      st.data = list.map((s) => ({ ...s }));
    },
  };
  return st satisfies SessionStorePort & Record<string, unknown>;
}

interface Rig {
  hub: RemoteHub;
  logs: string[];
  statuses: RemoteStatus[];
  hosts: string[];
  feeds: { buffer: ReplayBuffer; stopped: number; running: number }[];
  startServer: ReturnType<typeof vi.fn>;
}

// Wraps the real server onto loopback: findTailnetAddress rightly rejects loopback, so the hub
// still picks the (fake) tailnet address and the wrapper records it, then rebinds for the test.
function rig(store: SessionStorePort, over: Partial<Parameters<typeof createRemoteHub>[0]> = {}): Rig {
  const logs: string[] = [];
  const statuses: RemoteStatus[] = [];
  const hosts: string[] = [];
  const feeds: Rig['feeds'] = [];
  const startServer = vi.fn((o: Parameters<typeof startRemoteServer>[0]) => {
    hosts.push(o.host);
    return startRemoteServer({ ...o, host: '127.0.0.1', port: 0 });
  });
  const hub = createRemoteHub({
    resolveSession: () => ({ sessionId: 's1', file }),
    store,
    networkInterfaces: tailnetIfaces,
    startServer: startServer as any,
    createFeed: (d) => {
      const buffer = createReplayBuffer();
      const rec = { buffer, stopped: 0, running: 0 };
      feeds.push(rec);
      const feed = createChatFeed({
        ...d,
        buffer,
        pollMs: 25,
        readTitle: async () => 'T',
        setIntervalFn: (fn, ms) => { rec.running++; return setInterval(fn, ms); },
        clearIntervalFn: (h) => { rec.running--; clearInterval(h); },
      });
      const stop = feed.stop.bind(feed);
      feed.stop = () => { rec.stopped++; stop(); };
      return feed;
    },
    log: (l) => logs.push(l),
    onStatus: (s) => statuses.push(s),
    ...over,
  });
  hubs.push(hub);
  return { hub, logs, statuses, hosts, feeds, startServer };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function redeem(address: string, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const [host, port] = address.split(':');
    const body = JSON.stringify({ code });
    const req = http.request(
      { host, port: Number(port), path: '/api/pair', method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://${address}`, 'content-length': Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        const c = res.headers['set-cookie']?.[0];
        if (res.statusCode === 204 && c) resolve(c.split(';')[0]);
        else reject(new Error(`pair status ${res.statusCode}`));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function pairPhone(hub: RemoteHub): Promise<{ cookie: string; address: string }> {
  const p = await hub.createPairing();
  if (!p.ok) throw new Error('not enabled');
  const address = new URL(p.url).host;
  return { cookie: await redeem(address, p.code), address };
}

interface Phone { ws: WebSocket; msgs: ServerMessage[]; closed: Promise<number> }
function connect(address: string, cookie: string): Promise<Phone> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${address}/ws`, { headers: { Cookie: cookie, Origin: `http://${address}` } });
    sockets.push(ws);
    const msgs: ServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    ws.on('open', () => resolve({ ws, msgs, closed }));
    ws.on('error', reject);
  });
}

function refused(address: string): Promise<boolean> {
  const [host, port] = address.split(':');
  return new Promise((resolve) => {
    const s = net.connect(Number(port), host);
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
  });
}

describe('remoteHub', () => {
  it('binds only the tailnet address and refuses with a reason when there is none', async () => {
    const r = rig(fakeStore(), { networkInterfaces: () => ({ Ethernet: [{ address: '100.64.0.9', family: 'IPv4', internal: false }] }) as any });
    const s = await r.hub.setEnabled(true);
    expect(s).toMatchObject({ state: 'unavailable', reason: 'no-tailnet-address', address: null });
    expect(r.startServer).not.toHaveBeenCalled();
    expect(r.feeds).toHaveLength(0);

    const ok = rig(fakeStore());
    await ok.hub.setEnabled(true);
    expect(ok.hosts).toEqual([TAILNET_IP]);
  });

  it('cleans up the feed when the port is in use', async () => {
    const r = rig(fakeStore(), {
      startServer: (async () => { throw Object.assign(new Error('x'), { code: 'EADDRINUSE' }); }) as any,
    });
    const s = await r.hub.setEnabled(true);
    expect(s).toMatchObject({ state: 'unavailable', reason: 'port-in-use' });
    expect(r.feeds[0].stopped).toBe(1);
    expect(r.feeds[0].running).toBe(0);
  });

  it('enable, pair, redeem: the phone gets session, history, then a live line', async () => {
    const r = rig(fakeStore());
    const s = await r.hub.setEnabled(true);
    expect(s.state).toBe('on');
    const { cookie, address } = await pairPhone(r.hub);
    await waitFor(() => r.feeds[0].buffer.snapshot().length === 1);
    const phone = await connect(address, cookie);
    await waitFor(() => phone.msgs.length >= 2);
    expect(phone.msgs[0].t).toBe('session');
    expect(phone.msgs[1]).toMatchObject({ t: 'history' });
    expect(JSON.stringify(phone.msgs[1])).toContain(MARKER);
    appendFileSync(file, u('live line'));
    await waitFor(() => phone.msgs.some((m) => m.t === 'event'));
    expect(r.hub.status().clients).toBe(1);
  });

  it('a cookie from hub A still opens the socket on hub B over the same store', async () => {
    const store = fakeStore();
    const a = rig(store);
    await a.hub.setEnabled(true);
    const { cookie } = await pairPhone(a.hub);
    await a.hub.setEnabled(false);
    expect(store.data).toHaveLength(1);

    const b = rig(store);
    await b.hub.setEnabled(true);
    const addr = b.hub.status().address!;
    const phone = await connect(addr, cookie);
    await waitFor(() => phone.msgs.length >= 2);
    expect(phone.msgs[0].t).toBe('session');
  });

  it('disable keeps sessions, says bye disabled, empties the buffer and stops listening', async () => {
    const store = fakeStore();
    const r = rig(store);
    await r.hub.setEnabled(true);
    const { cookie, address } = await pairPhone(r.hub);
    await waitFor(() => r.feeds[0].buffer.snapshot().length === 1);
    const phone = await connect(address, cookie);
    await waitFor(() => phone.msgs.length >= 2);

    const s = await r.hub.setEnabled(false);
    await phone.closed;
    expect(phone.msgs.some((m) => m.t === 'bye' && m.reason === 'disabled')).toBe(true);
    expect(s.state).toBe('off');
    expect(s.sessions).toHaveLength(1);
    expect(store.data).toHaveLength(1);
    expect(r.feeds[0].buffer.snapshot()).toHaveLength(0);
    expect(r.feeds[0].stopped).toBe(1);
    expect(r.feeds[0].running).toBe(0);
    expect(await refused(address)).toBe(true);
    expect(await r.hub.createPairing()).toEqual({ ok: false, reason: 'not-enabled' });
  });

  it('revokeOne closes only that phone with bye revoked', async () => {
    const r = rig(fakeStore());
    await r.hub.setEnabled(true);
    const one = await pairPhone(r.hub);
    const two = await pairPhone(r.hub);
    const p1 = await connect(one.address, one.cookie);
    const p2 = await connect(two.address, two.cookie);
    await waitFor(() => p1.msgs.length >= 2 && p2.msgs.length >= 2);
    const refs = r.hub.status().sessions.map((x) => x.ref);
    expect(refs).toHaveLength(2);
    // sessions list newest first: the second phone's session is refs[0].
    const s = await r.hub.revokeOne(refs[1]);
    await p1.closed;
    expect(p1.msgs.some((m) => m.t === 'bye' && m.reason === 'revoked')).toBe(true);
    expect(p2.ws.readyState).toBe(WebSocket.OPEN);
    expect(s.sessions).toHaveLength(1);
  });

  it('revokeAll while off empties status and the store', async () => {
    const store = fakeStore();
    const r = rig(store);
    await r.hub.setEnabled(true);
    await pairPhone(r.hub);
    await r.hub.setEnabled(false);
    expect(r.hub.status().sessions).toHaveLength(1);
    const s = await r.hub.revokeAll();
    expect(s.sessions).toHaveLength(0);
    expect(store.data).toHaveLength(0);
  });

  it('a failed revoke save shows the notice, retries, and clears it when saved', async () => {
    const store = fakeStore();
    const timers: (() => void)[] = [];
    const r = rig(store, { setTimeoutFn: (fn) => { timers.push(fn); return timers.length; }, clearTimeoutFn: () => {} });
    await r.hub.setEnabled(true);
    await pairPhone(r.hub);
    await waitFor(() => store.data.length === 1);
    store.failSaves = true;
    const s = await r.hub.revokeAll();
    expect(s.notice).toBe(REVOKE_UNSAVED_NOTICE);
    expect(timers).toHaveLength(1);
    store.failSaves = false;
    timers.shift()!();
    await waitFor(() => r.hub.status().notice === null);
    expect(store.data).toHaveLength(0);
  });

  it('never puts the code, cookie, hash, marker or a path in logs or status payloads', async () => {
    const store = fakeStore();
    const r = rig(store);
    await r.hub.setEnabled(true);
    const p = await r.hub.createPairing();
    if (!p.ok) throw new Error('not enabled');
    const address = new URL(p.url).host;
    const cookie = await redeem(address, p.code);
    await waitFor(() => r.feeds[0].buffer.snapshot().length === 1);
    const phone = await connect(address, cookie);
    await waitFor(() => phone.msgs.length >= 2);
    await r.hub.revokeAll();
    await r.hub.setEnabled(false);
    const token = cookie.split('=')[1];
    const blob = JSON.stringify([r.logs, r.statuses, r.hub.status()]);
    expect(r.statuses.length).toBeGreaterThan(0);
    for (const secret of [p.code, p.code.replace('-', ''), token, MARKER, dir]) {
      expect(blob).not.toContain(secret);
    }
    expect(blob).not.toMatch(/[0-9a-f]{64}/);
    expect(blob).not.toContain(':\\');
    expect(blob).not.toContain('/Users');
  });

  it('createPairing returns code, url and qr only when on', async () => {
    const r = rig(fakeStore());
    expect(await r.hub.createPairing()).toEqual({ ok: false, reason: 'not-enabled' });
    await r.hub.setEnabled(true);
    const p = await r.hub.createPairing();
    if (!p.ok) throw new Error('not enabled');
    expect(p.url).toBe(`http://${r.hub.status().address}/pair#c=${p.code}`);
    expect(p.qrSvg.startsWith('<svg')).toBe(true);
    expect(JSON.stringify(r.hub.status())).not.toContain(p.code);
    expect(r.hub.status().pairingActive).toBe(true);
  });

  it('an unused pairing code dies on disable: not redeemable after re-enable, not active while off', async () => {
    const r = rig(fakeStore());
    await r.hub.setEnabled(true);
    const p = await r.hub.createPairing();
    if (!p.ok) throw new Error('not enabled');
    expect(r.hub.status().pairingActive).toBe(true);
    await r.hub.setEnabled(false);
    expect(r.hub.status().pairingActive).toBe(false);
    await r.hub.setEnabled(true);
    expect(r.hub.status().pairingActive).toBe(false);
    await expect(redeem(r.hub.status().address!, p.code)).rejects.toThrow('pair status 401');
  });

  it('stop() during a slow failing save leaves no retry timer', async () => {
    const store = fakeStore();
    const timers: (() => void)[] = [];
    const r = rig(store, { setTimeoutFn: (fn) => { timers.push(fn); return timers.length; }, clearTimeoutFn: () => {} });
    await r.hub.setEnabled(true);
    await pairPhone(r.hub);
    await waitFor(() => store.data.length === 1);
    store.save = async () => { await new Promise((res) => setTimeout(res, 60)); throw new Error('disk full'); };
    const pending = r.hub.revokeAll();
    await r.hub.stop();
    await pending;
    expect(timers).toHaveLength(0);
  });

  it('retrySave and the next enable retry a pending unsaved revoke', async () => {
    const store = fakeStore();
    const r = rig(store, { setTimeoutFn: () => 1, clearTimeoutFn: () => {} });
    await r.hub.setEnabled(true);
    await pairPhone(r.hub);
    await waitFor(() => store.data.length === 1);
    store.failSaves = true;
    expect((await r.hub.revokeAll()).notice).toBe(REVOKE_UNSAVED_NOTICE);
    store.failSaves = false;
    expect((await r.hub.retrySave()).notice).toBeNull();
    expect(store.data).toHaveLength(0);

    await pairPhone(r.hub);
    await waitFor(() => store.data.length === 1);
    store.failSaves = true;
    await r.hub.revokeAll();
    await r.hub.setEnabled(false);
    expect(r.hub.status().notice).toBe(REVOKE_UNSAVED_NOTICE);
    store.failSaves = false;
    expect((await r.hub.setEnabled(true)).notice).toBeNull();
  });

  it('a throwing networkInterfaces becomes an error state, not a rejection', async () => {
    const r = rig(fakeStore(), { networkInterfaces: () => { throw new Error('boom'); } });
    const s = await r.hub.setEnabled(true);
    expect(s).toMatchObject({ state: 'unavailable', reason: 'error' });
    expect(r.startServer).not.toHaveBeenCalled();
  });
});
