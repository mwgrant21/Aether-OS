import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnerClient, type OwnerClient, type OwnerClientOptions, type SetTimer } from './ownerClient';
import { createOwner, type Owner, type OwnerPty } from './ownerCore';
import {
  PROTO, createFrameReader, encodeDiscovery, encodeFrame, newNonce, newSecret, parseClientFrame, signProof,
  type ClientFrame, type LaunchSpec,
} from './protocol';
import type { RemotePty } from './remotePty';

const HOME = os.homedir();

class FakePty implements OwnerPty {
  dataCb: ((d: string) => void) | null = null;
  exitCb: (() => void) | null = null;
  onData(cb: (d: string) => void): void { this.dataCb = cb; }
  onExit(cb: () => void): void { this.exitCb = cb; }
  write(): void {}
  resize(): void {}
  kill(): void { this.exitCb?.(); }
  emit(d: string): void { this.dataCb?.(d); }
}
const spec = (): LaunchSpec =>
  ({ file: 'powershell.exe', args: [], cwd: HOME, env: { A: 'b' }, cols: 80, rows: 24, writes: [] });

const live: { owners: Owner[]; clients: OwnerClient[]; dirs: string[]; closers: Array<() => void> } =
  { owners: [], clients: [], dirs: [], closers: [] };
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyclient-')); live.dirs.push(d); return d; };
const pipeName = (): string => `\\\\.\\pipe\\aether-ownerclient-test-${newNonce()}`;

interface Rig { owner: Owner; ptys: FakePty[]; discovery: string; pipe: string; secret: string }
async function rig(spawn?: (s: LaunchSpec) => OwnerPty): Promise<Rig> {
  const discovery = path.join(tmp(), 'd.json');
  const ptys: FakePty[] = [];
  const owner = createOwner({
    spawn: spawn ?? (() => { const p = new FakePty(); ptys.push(p); return p; }),
    homedir: HOME, discoveryPath: discovery, pipePath: pipeName(), graceMs: 60_000,
  });
  live.owners.push(owner);
  const { pipe, secret } = await owner.listening;
  return { owner, ptys, discovery, pipe, secret };
}
function client(over: OwnerClientOptions = {}): OwnerClient {
  const c = createOwnerClient({ claimBackoffMs: 10, ...over });
  live.clients.push(c);
  return c;
}
async function connected(r: Rig, over: OwnerClientOptions = {}): Promise<OwnerClient> {
  const c = client(over);
  await c.connect(r.discovery);
  return c;
}
/** Collects what a RemotePty delivers; callbacks registered like PtyLifecycle.start does. */
function collect(p: RemotePty): { data: string[]; exits: number } {
  const out = { data: [] as string[], exits: 0 };
  p.onData((d) => out.data.push(d));
  p.onExit(() => { out.exits++; });
  return out;
}
/** A list round trip: every frame the helper sent before it has been processed by the client. */
const sync = (c: OwnerClient): Promise<unknown> => c.list();

/** Forwards a pipe to the real owner so a test can cut the connection without touching the owner. */
async function proxy(target: string): Promise<{ pipe: string; drop(): void }> {
  const socks = new Set<net.Socket>();
  const pipe = pipeName();
  const server = net.createServer((s) => {
    const up = net.connect(target);
    socks.add(s); socks.add(up);
    s.on('error', () => up.destroy()); up.on('error', () => s.destroy());
    s.on('close', () => up.destroy()); up.on('close', () => s.destroy());
    s.pipe(up); up.pipe(s);
  });
  await new Promise<void>((res) => server.listen(pipe, res));
  live.closers.push(() => { for (const s of socks) s.destroy(); server.close(); });
  return { pipe, drop: () => { for (const s of socks) s.destroy(); socks.clear(); } };
}
function discoveryFor(pipe: string, secret: string): string {
  const f = path.join(tmp(), 'proxy.json');
  fs.writeFileSync(f, encodeDiscovery({ v: 1, pipe, pid: process.pid, startedAt: 1, secret }));
  return f;
}

/** A pipe server that is not the helper. `onFrame` sees every client frame, parsed. */
async function fakeServer(onFrame: (f: ClientFrame, reply: (o: unknown) => void) => void, secret = newSecret()):
  Promise<{ discovery: string; secret: string; seen: ClientFrame[]; sockets: net.Socket[] }> {
  const seen: ClientFrame[] = [];
  const sockets: net.Socket[] = [];
  const pipe = pipeName();
  const server = net.createServer((s) => {
    sockets.push(s);
    const reader = createFrameReader((raw) => {
      const f = parseClientFrame(raw, HOME);
      if (!f) return;
      seen.push(f);
      onFrame(f, (o) => s.write(encodeFrame(o)));
    }, () => s.destroy());
    s.on('data', (c) => reader.push(c));
    s.on('error', () => {});
  });
  await new Promise<void>((res) => server.listen(pipe, res));
  live.closers.push(() => { for (const s of sockets) s.destroy(); server.close(); });
  return { discovery: discoveryFor(pipe, secret), secret, seen, sockets };
}

afterEach(async () => {
  for (const c of live.clients.splice(0)) c.release();
  for (const f of live.closers.splice(0)) f();
  for (const o of live.owners.splice(0)) { o.close(); await o.closed; }
  for (const d of live.dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('ownerClient (real createOwner over a named pipe; win32 only)', () => {
  it('spawn returns synchronously and its data arrives only after resume', async () => {
    const r = await rig();
    const c = await connected(r);
    const pty = c.spawn('claude', spec(), { k: 1 });
    expect(pty).toBeDefined(); // returned before any round trip
    const got = collect(pty);
    await sync(c);
    r.ptys[0].emit('hello');
    await sync(c);
    expect(got.data).toEqual([]);
    pty.resume();
    expect(got.data).toEqual(['hello']);
    r.ptys[0].emit('more');
    await vi.waitFor(() => expect(got.data).toEqual(['hello', 'more']));
  });

  it('output produced before onData is registered is neither lost nor reordered', async () => {
    const r = await rig();
    const c = await connected(r);
    const pty = c.spawn('claude', spec(), {});
    await sync(c);
    for (const d of ['a', 'b', 'c']) r.ptys[0].emit(d); // no consumer registered yet
    await sync(c);
    const got = collect(pty); // PtyLifecycle.start registers, then calls onAlive, then resume
    expect(got.data).toEqual([]);
    pty.resume();
    r.ptys[0].emit('d');
    await vi.waitFor(() => expect(got.data).toEqual(['a', 'b', 'c', 'd']));
  });

  it('attach replays the ring before frames that arrived while buffering', async () => {
    const r = await rig();
    const first = await connected(r);
    first.spawn('claude', spec(), { sessionId: 's1' });
    await sync(first);
    r.ptys[0].emit('r1'); r.ptys[0].emit('r2');
    await sync(first);
    first.release();
    await vi.waitFor(() => expect(r.owner.hasOwner()).toBe(false));

    const second = await connected(r);
    const slots = await second.list();
    expect(slots.map((s) => [s.slot, s.state])).toEqual([['claude', 'running']]);
    const a = await second.attach('claude');
    expect(a.meta).toEqual({ sessionId: 's1' });
    expect(a.ring.map((x) => x.d)).toEqual(['r1', 'r2']);
    r.ptys[0].emit('live1');
    await sync(second);
    const got = collect(a.pty);
    a.pty.resume();
    r.ptys[0].emit('live2');
    await vi.waitFor(() => expect(got.data).toEqual(['r1', 'r2', 'live1', 'live2']));
  });

  it('reconnect after socket loss replays what was missed, without duplicates', async () => {
    const r = await rig();
    const px = await proxy(r.pipe);
    const c = client();
    await c.connect(discoveryFor(px.pipe, r.secret));
    const pty = c.spawn('claude', spec(), {});
    const got = collect(pty);
    pty.resume();
    await sync(c);
    r.ptys[0].emit('one'); r.ptys[0].emit('two');
    await vi.waitFor(() => expect(got.data).toEqual(['one', 'two']));

    px.drop();
    r.ptys[0].emit('three'); // the helper has not noticed the loss yet: sent into the dead socket, kept in the ring
    await vi.waitFor(() => expect(got.data).toEqual(['one', 'two', 'three'])); // replayed by attach after re-auth
    await vi.waitFor(() => expect(c.ready).toBe(true));
    await sync(c);
    r.ptys[0].emit('four');
    await vi.waitFor(() => expect(got.data).toEqual(['one', 'two', 'three', 'four']));
    expect(got.exits).toBe(0);
  });

  it('a failed reconnect fires exit on every shell and onLost once', async () => {
    const r = await rig();
    const px = await proxy(r.pipe);
    const c = client({ reconnectMs: 300 });
    const lost = vi.fn();
    c.onLost(lost);
    await c.connect(discoveryFor(px.pipe, r.secret));
    const pty = c.spawn('claude', spec(), {});
    const got = collect(pty);
    pty.resume();
    await sync(c);
    r.owner.close(); await r.owner.closed; // helper gone: nothing to reconnect to
    px.drop();
    await vi.waitFor(() => expect(got.exits).toBe(1));
    expect(lost).toHaveBeenCalledTimes(1);
    expect(c.ready).toBe(false);
  });

  it('seq restarting after forget + spawn is not mistaken for duplicates', async () => {
    const r = await rig();
    const c = await connected(r);
    const first = c.spawn('claude', spec(), {});
    const g1 = collect(first); first.resume();
    await sync(c);
    r.ptys[0].emit('old');
    await vi.waitFor(() => expect(g1.data).toEqual(['old']));
    r.ptys[0].exitCb?.();
    await vi.waitFor(() => expect(g1.exits).toBe(1));
    c.forget('claude');
    await sync(c);
    const second = c.spawn('claude', spec(), {});
    const g2 = collect(second); second.resume();
    await sync(c);
    r.ptys[1].emit('new'); // helper seq is 1 again
    await vi.waitFor(() => expect(g2.data).toEqual(['new']));
  });

  it('an impostor with the wrong proof is rejected before any spawn or write frame is sent', async () => {
    const impostor = await fakeServer((f, reply) => {
      if (f.t === 'hello') reply({ t: 'challenge', nonceS: newNonce(), proofS: signProof(newSecret(), 'server', f.nonceC) });
    });
    const c = client();
    await expect(c.connect(impostor.discovery)).rejects.toThrow(/bad proof/);
    expect(c.ready).toBe(false);
    const pty = c.spawn('claude', spec(), {}); // not ready: must not reach the socket either
    const got = collect(pty); pty.resume();
    pty.write('secret keystrokes');
    await new Promise((res) => setTimeout(res, 100));
    expect(impostor.seen.map((f) => f.t)).toEqual(['hello']);
    expect(got.exits).toBe(1);
  });

  it('a helper speaking another protocol leaves ready false', async () => {
    const old = await fakeServer((f, reply) => {
      if (f.t === 'hello') { reply({ t: 'error', code: 'proto' }); }
    });
    const c = client();
    await expect(c.connect(old.discovery)).rejects.toThrow(/proto/);
    expect(c.ready).toBe(false);
    expect(PROTO).toBe(1);
  });

  it('a helper that stays busy leaves ready false after bounded retries', async () => {
    const r = await rig();
    const holder = await connected(r); // a live owner that never lets go
    const c = client({ claimRetries: 3, claimBackoffMs: 5 });
    await expect(c.connect(r.discovery)).rejects.toThrow(/busy/);
    expect(c.ready).toBe(false);
    expect(holder.ready).toBe(true);
  });

  it('a claim that sees busy while the old owner socket is dying retries and wins', async () => {
    const r = await rig();
    const holder = await connected(r);
    const c = client({ claimRetries: 6, claimBackoffMs: 20 });
    const winning = c.connect(r.discovery);
    setTimeout(() => holder.release(), 50); // the old owner goes away after the first busy
    await winning;
    expect(c.ready).toBe(true);
  });

  it('a connect that gets no answer times out', async () => {
    const mute = await fakeServer(() => {});
    let fire: (() => void) | null = null;
    const setTimer: SetTimer = (fn, ms) => { if (ms === 5000) fire = fn; return () => {}; };
    const c = client({ setTimer });
    const p = c.connect(mute.discovery);
    const settled = p.catch((e: Error) => e.message);
    await vi.waitFor(() => expect(fire).not.toBeNull());
    fire!();
    expect(await settled).toBe('timeout');
    expect(c.ready).toBe(false);
  });

  it('write, resize and kill on a never-connected or released client do not throw and mark exit', async () => {
    const c = client();
    const pty = c.spawn('codex', spec(), {});
    const got = collect(pty);
    expect(() => { pty.write('x'); pty.resize(10, 10); pty.kill(); }).not.toThrow();
    pty.resume();
    expect(got.exits).toBe(1);

    const r = await rig();
    const c2 = await connected(r);
    const live2 = c2.spawn('claude', spec(), {});
    const g2 = collect(live2); live2.resume();
    await sync(c2);
    c2.release();
    expect(() => { live2.write('x'); live2.resize(5, 5); live2.kill(); }).not.toThrow();
    expect(g2.exits).toBe(1);
  });

  it('a spawn the helper cannot perform fires exit for that slot only', async () => {
    let n = 0;
    const ptys: FakePty[] = [];
    const r = await rig(() => { if (++n === 2) throw new Error('no conpty'); const p = new FakePty(); ptys.push(p); return p; });
    const c = await connected(r);
    const ok = c.spawn('claude', spec(), {});
    const bad = c.spawn('terminal2', spec(), {});
    const gok = collect(ok), gbad = collect(bad);
    ok.resume(); bad.resume();
    await vi.waitFor(() => expect(gbad.exits).toBe(1));
    ptys[0].emit('still alive');
    await vi.waitFor(() => expect(gok.data).toEqual(['still alive']));
    expect(gok.exits).toBe(0);
  });
});
