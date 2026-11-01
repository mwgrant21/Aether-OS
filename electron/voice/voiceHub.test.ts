// @vitest-environment node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { VoiceStatus } from '../../src/shared/voice/types';
import type { SessionStorePort, StoredSession } from '../remote/types';
import type { SessionEvent } from './voiceSession';
import { createVoiceGateway } from './voiceGateway';
import { createVoiceHub, type VoiceHub } from './voiceHub';
import { createVoiceSession } from './voiceSession';
import { startVoiceServer, type VoiceServerHandle } from './voiceServer';

const TAILNET_IP = '100.64.0.5';
const tailnetIfaces = () => ({
  Tailscale: [{ address: TAILNET_IP, family: 'IPv4', internal: false }],
}) as any;
const PROMPT_MARKER = 'PROMPT-MARKER-48151623';

function fakeStore(initial: StoredSession[] = []) {
  const st = {
    data: initial,
    load: () => st.data.map((s) => ({ ...s })),
    save: async (list: StoredSession[]) => { st.data = list.map((s) => ({ ...s })); },
  };
  return st satisfies SessionStorePort & Record<string, unknown>;
}

// A session double that records start/stop/send counts; the gateway on top of it is the real one.
function fakeSession() {
  const listeners = new Set<(e: SessionEvent) => void>();
  const f = {
    starts: 0,
    stops: 0,
    sent: [] as string[],
    st: 'none' as string,
    start() { f.starts++; f.set('starting'); },
    emit(e: SessionEvent) { for (const l of [...listeners]) l(e); },
    set(s: 'starting' | 'ready' | 'restarting' | 'down') {
      f.st = s;
      for (const l of [...listeners]) l({ k: 'state', state: s });
    },
    send(_id: string, text: string) { f.sent.push(text); return true; },
    interrupt() {},
    answerPermission() {},
    async stop() { f.stops++; f.st = 'none'; },
    on(cb: (e: SessionEvent) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    state: () => f.st as any,
    pid: () => null,
    listenerCount: () => listeners.size,
  };
  return f;
}

interface Rig {
  hub: VoiceHub;
  logs: string[];
  statuses: VoiceStatus[];
  hosts: string[];
  sessions: ReturnType<typeof fakeSession>[];
  timers: Set<unknown>;
  startServer: ReturnType<typeof vi.fn>;
  handles: VoiceServerHandle[];
}

const hubs: VoiceHub[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const h of hubs.splice(0)) await h.stop();
});

// Wraps the real server onto loopback: findTailnetAddress rightly rejects loopback, so the hub still
// picks the (fake) tailnet address and the wrapper records it, then rebinds for the test.
function rig(store: SessionStorePort, over: Partial<Parameters<typeof createVoiceHub>[0]> = {}): Rig {
  const logs: string[] = [];
  const statuses: VoiceStatus[] = [];
  const hosts: string[] = [];
  const sessions: Rig['sessions'] = [];
  const timers = new Set<unknown>();
  const handles: VoiceServerHandle[] = [];
  const startServer = vi.fn((o: Parameters<typeof startVoiceServer>[0]) => {
    hosts.push(o.host);
    return startVoiceServer({ ...o, host: '127.0.0.1', port: 0 }).then((h) => { handles.push(h); return h; });
  });
  const setTimeoutFn = (fn: () => void, ms: number) => {
    const h = setTimeout(() => { timers.delete(h); fn(); }, ms);
    timers.add(h);
    return h;
  };
  const clearTimeoutFn = (h: any) => { timers.delete(h); clearTimeout(h); };
  const hub = createVoiceHub({
    store,
    networkInterfaces: tailnetIfaces,
    startServer: startServer as any,
    createSession: (() => {
      const s = fakeSession();
      sessions.push(s);
      return s;
    }) as any,
    createGateway: ((d: any) => createVoiceGateway({ ...d, setTimeoutFn, clearTimeoutFn })) as any,
    setTimeoutFn,
    clearTimeoutFn,
    log: (l) => logs.push(l),
    onStatus: (s) => statuses.push(s),
    ...over,
  });
  hubs.push(hub);
  return { hub, logs, statuses, hosts, sessions, timers, startServer, handles };
}

const hubClients = (r: Rig): number => r.handles[r.handles.length - 1].clients();

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function hostPort(address: string): { host: string; port: number } {
  const i = address.lastIndexOf(':');
  return { host: address.slice(0, i), port: Number(address.slice(i + 1)) };
}

function redeem(address: string, code: string): Promise<{ status: number; cookie: string | null }> {
  const { host, port } = hostPort(address);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, method: 'POST', path: '/api/voice/pair', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => {
          const sc = res.headers['set-cookie']?.[0];
          resolve({ status: res.statusCode ?? 0, cookie: sc ? sc.split(';')[0] : null });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ code }));
  });
}

interface Conn { ws: WebSocket; frames: string[]; closed: Promise<number> }

function connect(address: string, cookie: string): Promise<Conn> {
  const ws = new WebSocket(`ws://${address}/voice`, { headers: { Cookie: cookie } });
  sockets.push(ws);
  const frames: string[] = [];
  ws.on('message', (d) => frames.push(String(d)));
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, frames, closed }));
    ws.once('error', reject);
    ws.once('unexpected-response', () => reject(new Error('refused')));
  });
}

async function pairAndRedeem(r: Rig): Promise<{ address: string; cookie: string }> {
  await r.hub.setEnabled(true);
  const p = await r.hub.createPairing();
  if (!p.ok) throw new Error('not enabled');
  const res = await redeem(p.address, p.code);
  expect(res.status).toBe(204);
  return { address: p.address, cookie: res.cookie! };
}

function refused(address: string): Promise<boolean> {
  const { host, port } = hostPort(address);
  return new Promise((resolve) => {
    const req = http.request({ host, port, method: 'GET', path: '/' }, (res) => { res.resume(); resolve(false); });
    req.on('error', () => resolve(true));
    req.end();
  });
}

describe('voiceHub', () => {
  it('no tailnet address: unavailable, nothing started, no fallback bind', async () => {
    const r = rig(fakeStore(), { networkInterfaces: () => ({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }) as any });
    const s = await r.hub.setEnabled(true);
    expect(s.state).toBe('unavailable');
    expect(s.reason).toBe('no-tailnet-address');
    expect(s.address).toBeNull();
    expect(r.startServer).not.toHaveBeenCalled();
    expect(r.sessions).toHaveLength(0);
  });

  it('port in use and generic errors map to a reason with full cleanup', async () => {
    const inUse = Object.assign(new Error('x'), { code: 'EADDRINUSE' });
    const r = rig(fakeStore(), { startServer: (async () => { throw inUse; }) as any });
    const s = await r.hub.setEnabled(true);
    expect(s).toMatchObject({ state: 'unavailable', reason: 'port-in-use', address: null });
    expect(r.sessions[0].starts).toBe(0);
    expect(r.sessions[0].stops).toBe(1);
    expect(r.sessions[0].listenerCount()).toBe(0);
    expect(r.timers.size).toBe(0);

    const r2 = rig(fakeStore(), { startServer: (async () => { throw new Error('boom'); }) as any });
    expect((await r2.hub.setEnabled(true)).reason).toBe('error');
  });

  it('createPairing while off is not-enabled', async () => {
    const r = rig(fakeStore());
    expect(await r.hub.createPairing()).toEqual({ ok: false, reason: 'not-enabled' });
  });

  it('second setEnabled(true) is a no-op', async () => {
    const r = rig(fakeStore());
    await r.hub.setEnabled(true);
    await r.hub.setEnabled(true);
    expect(r.startServer).toHaveBeenCalledTimes(1);
    expect(r.sessions).toHaveLength(1);
    expect(r.hosts).toEqual([TAILNET_IP]);
  });

  it('enable -> pair -> redeem -> cookie opens /voice; the child is spawned once, at first attach', async () => {
    const r = rig(fakeStore());
    const { address, cookie } = await pairAndRedeem(r);
    const s = r.sessions[0];
    expect(s.starts).toBe(0); // not at enable
    expect(r.hub.status().session).toBe('none');
    const c1 = await connect(address, cookie);
    await waitFor(() => s.starts === 1);
    c1.ws.close();
    await c1.closed;
    const c2 = await connect(address, cookie);
    await waitFor(() => c2.frames.length > 0);
    expect(s.starts).toBe(1);
    expect(r.hub.status().connected).toBe(true);
  });

  it('the hub passes maxClients: 2 to the server', async () => {
    const r = rig(fakeStore());
    await r.hub.setEnabled(true);
    expect(r.startServer.mock.calls[0][0].maxClients).toBe(2);
  });

  it('a second authenticated socket replaces the first (error{replaced}, close 4000); the child spawns once', async () => {
    const r = rig(fakeStore());
    const { address, cookie } = await pairAndRedeem(r);
    const a = await connect(address, cookie);
    await waitFor(() => r.sessions[0].starts === 1);
    const b = await connect(address, cookie);
    expect(await a.closed).toBe(4000);
    expect(a.frames.some((f) => f.includes('"replaced"'))).toBe(true);
    await waitFor(() => b.frames.some((f) => f.includes('"status"')));
    expect(b.frames.some((f) => f.includes('"replaced"'))).toBe(false);
    await waitFor(() => r.hub.status().connected && hubClients(r) === 1);
    expect(r.sessions[0].starts).toBe(1);
  });

  it('a third socket while the replaced one is still closing is refused 503 (never more than 2 held)', async () => {
    const r = rig(fakeStore());
    const { address, cookie } = await pairAndRedeem(r);
    const a = await connect(address, cookie);
    await waitFor(() => r.sessions[0].starts === 1);
    (a.ws as any)._socket.pause(); // A never answers the close frame, so the server keeps counting it
    const b = await connect(address, cookie);
    await waitFor(() => b.frames.length > 0);
    await expect(connect(address, cookie)).rejects.toThrow('refused');
    expect(hubClients(r)).toBe(2);
    expect(b.ws.readyState).toBe(WebSocket.OPEN); // B stays the one live connection
  });

  it('a client that connects before ready still sees the starting event', async () => {
    const r = rig(fakeStore());
    const { address, cookie } = await pairAndRedeem(r);
    const c = await connect(address, cookie);
    await waitFor(() => r.sessions[0].starts === 1);
    r.sessions[0].set('ready');
    c.ws.send(JSON.stringify({ t: 'resume', lastSeq: 0 })); // live events are held until the first inbound frame
    await waitFor(() => c.frames.some((f) => f.includes('"ready"')));
    expect(c.frames.some((f) => f.includes('"starting"'))).toBe(true);
  });

  it('disable stops child and server, leaves no timer or listener, keeps paired sessions', async () => {
    const r = rig(fakeStore());
    const { address, cookie } = await pairAndRedeem(r);
    const c = await connect(address, cookie);
    const s = r.sessions[0];
    await waitFor(() => s.starts === 1);
    s.set('ready');
    c.ws.send(JSON.stringify({ t: 'turn.start', turnId: 'turn-aaaa1111', text: PROMPT_MARKER, mode: 'voice' }));
    await waitFor(() => s.sent.length === 1);

    const st = await r.hub.setEnabled(false);
    expect(await c.closed).toBe(1001);
    expect(st.state).toBe('off');
    expect(st.address).toBeNull();
    expect(st.connected).toBe(false);
    expect(st.session).toBe('none');
    expect(st.sessions).toHaveLength(1);
    expect(s.stops).toBe(1);
    expect(s.listenerCount()).toBe(0);
    expect(r.timers.size).toBe(0);
    expect(await refused(address)).toBe(true);
    expect(s.sent).toHaveLength(1); // nothing re-sent
    expect(await r.hub.createPairing()).toEqual({ ok: false, reason: 'not-enabled' });
  });

  it('restart round trip: a cookie from hub A opens hub B over the same store', async () => {
    const store = fakeStore();
    const a = rig(store);
    const { cookie } = await pairAndRedeem(a);
    await a.hub.stop();
    expect(store.data).toHaveLength(1);

    const b = rig(store);
    await b.hub.setEnabled(true);
    const addr = b.hub.status().address!;
    const c = await connect(addr, cookie);
    await waitFor(() => b.sessions[0].starts === 1);
    c.ws.close();
  });

  it('revokeOne closes that socket (4001) and drops the session; revokeAll works while off', async () => {
    const r = rig(fakeStore());
    const { address, cookie } = await pairAndRedeem(r);
    const c = await connect(address, cookie);
    await waitFor(() => r.sessions[0].starts === 1);
    const ref = r.hub.status().sessions[0].ref;
    const st = await r.hub.revokeOne(ref);
    expect(await c.closed).toBe(4001);
    expect(st.sessions).toHaveLength(0);

    const r2 = rig(fakeStore());
    await pairAndRedeem(r2);
    await r2.hub.setEnabled(false);
    expect(r2.hub.status().sessions).toHaveLength(1);
    expect((await r2.hub.revokeAll()).sessions).toHaveLength(0);
  });

  it('a failed revoke save raises the notice and schedules at most bounded retries; disable leaves no timer', async () => {
    const store = fakeStore();
    const r = rig(store, { retryMs: 60_000 });
    await pairAndRedeem(r);
    store.save = async () => { throw new Error('disk full'); };
    const st = await r.hub.revokeAll();
    expect(st.notice).toBe('Revoke not saved to disk yet');
    expect(r.logs).toContain('voice: session store save failed');
    expect(r.timers.size).toBe(1);
    await r.hub.setEnabled(false);
    expect(r.timers.size).toBe(0);
  });

  it('onStatus fires on session state changes only, not per delta', async () => {
    const r = rig(fakeStore());
    const { address, cookie } = await pairAndRedeem(r);
    const c = await connect(address, cookie);
    const s = r.sessions[0];
    await waitFor(() => s.starts === 1);
    s.set('ready');
    c.ws.send(JSON.stringify({ t: 'turn.start', turnId: 'turn-cccc3333', text: 'hi', mode: 'voice' }));
    await waitFor(() => s.sent.length === 1);
    const before = r.statuses.length;
    for (let i = 0; i < 20; i++) s.emit({ k: 'delta', turnId: 'turn-cccc3333', text: `word${i} ` });
    s.emit({ k: 'tool', turnId: 'turn-cccc3333', name: 'Bash', agent: false });
    s.emit({ k: 'result', turnId: 'turn-cccc3333', ok: true, interrupted: false });
    expect(r.statuses.length).toBe(before);
    s.set('restarting');
    expect(r.statuses.length).toBe(before + 1);
  });

  it('setEnabled(true) after stop() starts nothing, even when queued before stop()', async () => {
    const r = rig(fakeStore());
    const { address } = await pairAndRedeem(r);
    const racing = r.hub.setEnabled(false).then(() => r.hub.setEnabled(true));
    const stopping = r.hub.stop();
    const late = r.hub.setEnabled(true);
    await Promise.all([racing, stopping, late]);
    expect(r.startServer).toHaveBeenCalledTimes(1);
    expect(r.hub.status().state).toBe('off');
    expect(await refused(address)).toBe(true);
    expect(r.timers.size).toBe(0);
  });

  it('a failing-save revokeAll racing setEnabled(false) leaves no hub timer', async () => {
    const store = fakeStore();
    const r = rig(store, { retryMs: 60_000 });
    await pairAndRedeem(r);
    store.save = async () => { throw new Error('disk full'); };
    await Promise.all([r.hub.setEnabled(false), r.hub.revokeAll()]);
    expect(r.timers.size).toBe(0);
    expect(r.hub.status().state).toBe('off');
  });

  it('status, onStatus payloads and logs never carry a secret over a full cycle', async () => {
    const r = rig(fakeStore());
    await r.hub.setEnabled(true);
    const p = await r.hub.createPairing();
    if (!p.ok) throw new Error('not enabled');
    const redeemed = await redeem(p.address, p.code);
    const cookieValue = redeemed.cookie!.split('=')[1];
    const c = await connect(p.address, redeemed.cookie!);
    await waitFor(() => r.sessions[0].starts === 1);
    r.sessions[0].set('ready');
    c.ws.send(JSON.stringify({ t: 'turn.start', turnId: 'turn-bbbb2222', text: PROMPT_MARKER, mode: 'voice' }));
    await waitFor(() => r.sessions[0].sent.length === 1);
    await r.hub.revokeOne(r.hub.status().sessions[0].ref);
    await c.closed;
    await r.hub.setEnabled(false);
    await r.hub.stop();

    expect(r.statuses.length).toBeGreaterThan(3);
    const blob = JSON.stringify(r.statuses) + '\n' + r.logs.join('\n') + '\n' + JSON.stringify(r.hub.status());
    expect(blob).not.toContain(p.code);
    expect(blob).not.toContain(cookieValue);
    expect(blob).not.toContain(PROMPT_MARKER);
    expect(blob).not.toContain(':\\');
    expect(blob).not.toContain('/Users');
    expect(blob).not.toMatch(/[0-9a-f]{64}/);
    expect(JSON.stringify(r.statuses)).not.toContain('qrSvg');
    expect(r.logs).toContain('voice: disabled');
  });
  it('stop() starts the session stop before a stuck phone releases the server, and the child and grandchild die', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-stop-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    const script = "const {spawn}=require('child_process');"
      + "const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});"
      + "require('fs').writeFileSync(process.argv[1],String(g.pid));process.stdin.resume();setInterval(()=>{},1000)";
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let child: ReturnType<typeof spawn> | null = null;
    // Structural, load-independent evidence: when the session's stop() is first called vs when the server stop resolves.
    let sessionStopAt = 0;
    const order: string[] = [];
    let serverStopDoneAt = 0;
    const r = rig(fakeStore(), {
      createSession: ((d: any) => {
        const s = createVoiceSession({
          ...d,
          killGraceMs: 400,
          spawnFn: (_args: string[], opts: any) => (child = spawn(process.execPath, ['-e', script, pidFile], opts)),
        });
        const realStop = s.stop.bind(s);
        s.stop = () => { if (!sessionStopAt) { sessionStopAt = Date.now(); order.push("session-stop"); } return realStop(); };
        return s;
      }) as any,
    });
    let grandchild = 0;
    try {
      const { address, cookie } = await pairAndRedeem(r);
      const c = await connect(address, cookie);
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', 8000);
      grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      const childPid = child!.pid!;
      expect(alive(childPid) && alive(grandchild)).toBe(true);
      (c.ws as any)._socket.pause(); // the phone is asleep: it never reads, so it never answers the close frame
      const handle = r.handles[r.handles.length - 1];
      const realServerStop = handle.stop.bind(handle);
      handle.stop = async () => { try { await realServerStop(); } finally { serverStopDoneAt = Date.now(); order.push("server-stop-done"); } };
      const t0 = Date.now();
      const stopped = r.hub.stop();
      await stopped;
      expect(serverStopDoneAt).toBeGreaterThan(0);
      // Ordering: the session stop began before the stuck phone let the server stop finish (sequential teardown fails this).
      expect(sessionStopAt).toBeGreaterThan(0);
      expect(order).toEqual(["session-stop", "server-stop-done"]);
      // Old sequential code reached the session stop only after the server's ~1 s terminate fallback.
      expect(sessionStopAt - t0).toBeLessThan(400);
      // Liveness only, with a generous window: the child tree dies.
      await waitFor(() => !alive(childPid) && (process.platform !== 'win32' || !alive(grandchild)), 5000);
    } finally {
      if (grandchild && alive(grandchild)) { try { process.kill(grandchild); } catch { /* gone */ } }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
