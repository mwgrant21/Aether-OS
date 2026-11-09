import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_DEADLINE_MS, IDLE_EXIT_MS, MAX_UNAUTH_SOCKETS, OWNER_STALE_MS, createOwner,
  type Owner, type OwnerPty, type SetTimer,
} from './ownerCore';
import {
  PROTO, RING_MAX, createFrameReader, encodeFrame, newNonce, newSecret, parseHelperFrame, signProof, verifyProof,
  type HelperFrame, type LaunchSpec,
} from './protocol';

const GRACE = 60_000;
const HOME = os.homedir();

class FakeClock {
  t = 1_000_000;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private n = 0;
  now = (): number => this.t;
  setTimer: SetTimer = (fn, ms) => {
    const id = ++this.n;
    this.timers.push({ at: this.t + ms, fn, id });
    return () => { this.timers = this.timers.filter((x) => x.id !== id); };
  };
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = target;
  }
}

class FakePty implements OwnerPty {
  dataCb: ((d: string) => void) | null = null;
  exitCb: (() => void) | null = null;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = 0;
  onData(cb: (d: string) => void): void { this.dataCb = cb; }
  onExit(cb: () => void): void { this.exitCb = cb; }
  write(d: string): void { this.writes.push(d); }
  resize(c: number, r: number): void { this.resizes.push([c, r]); }
  kill(): void { this.killed++; this.exitCb?.(); }
  emit(d: string): void { this.dataCb?.(d); }
  exitNow(): void { this.exitCb?.(); }
}

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec =>
  ({ file: 'powershell.exe', args: [], cwd: HOME, env: { FOO: 'bar', Path: 'C:\\x' }, cols: 80, rows: 24, writes: [], ...over });

class Client {
  socket: net.Socket;
  frames: HelperFrame[] = [];
  closed = false;
  private waiters: Array<() => void> = [];
  constructor(socket: net.Socket) {
    this.socket = socket;
    const reader = createFrameReader((raw) => {
      const f = parseHelperFrame(raw);
      if (f) { this.frames.push(f); this.wake(); }
    }, () => socket.destroy());
    socket.on('data', (c) => reader.push(c));
    socket.on('error', () => {});
    socket.on('close', () => { this.closed = true; this.wake(); });
  }
  private wake(): void { for (const w of this.waiters.splice(0)) w(); }
  send(o: unknown): void { this.socket.write(encodeFrame(o)); }
  async until(cond: () => boolean, ms = 4000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout waiting; frames=' + JSON.stringify(this.frames.map((f) => f.t)));
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 25); });
    }
  }
  async next<T extends HelperFrame['t']>(t: T): Promise<Extract<HelperFrame, { t: T }>> {
    await this.until(() => this.frames.some((f) => f.t === t));
    const i = this.frames.findIndex((f) => f.t === t);
    return this.frames.splice(i, 1)[0] as Extract<HelperFrame, { t: T }>;
  }
  async whenClosed(): Promise<void> { await this.until(() => this.closed); }
  destroy(): void { this.socket.destroy(); }
}

const running: { owners: Owner[]; clients: Client[]; dirs: string[] } = { owners: [], clients: [], dirs: [] };

function connect(pipe: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipe);
    s.once('error', reject);
    s.once('connect', () => { s.removeListener('error', reject); const c = new Client(s); running.clients.push(c); resolve(c); });
  });
}
async function handshake(pipe: string, secret: string): Promise<Client> {
  const c = await connect(pipe);
  const nonceC = newNonce();
  c.send({ t: 'hello', proto: PROTO, nonceC });
  const ch = await c.next('challenge');
  expect(verifyProof(secret, 'server', nonceC, ch.proofS)).toBe(true);
  c.send({ t: 'auth', proofC: signProof(secret, 'client', ch.nonceS) });
  await c.next('ready');
  return c;
}
async function owned(pipe: string, secret: string): Promise<Client> {
  const c = await handshake(pipe, secret);
  c.send({ t: 'claim' });
  await c.next('slots');
  return c;
}

interface Rig { owner: Owner; clock: FakeClock; ptys: FakePty[]; specs: LaunchSpec[]; pipe: string; secret: string; discovery: string }
async function rig(over: { graceMs?: number; discoveryPath?: string; spawn?: (s: LaunchSpec) => OwnerPty } = {}): Promise<Rig> {
  const clock = new FakeClock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyowner-'));
  running.dirs.push(dir);
  const discovery = over.discoveryPath ?? path.join(dir, 'd.json');
  const ptys: FakePty[] = [];
  const specs: LaunchSpec[] = [];
  const owner = createOwner({
    spawn: over.spawn ?? ((s) => { specs.push(s); const p = new FakePty(); ptys.push(p); return p; }),
    homedir: HOME, discoveryPath: discovery, pipePath: `\\\\.\\pipe\\aether-ownercore-test-${newNonce()}`,
    now: clock.now, setTimer: clock.setTimer, graceMs: over.graceMs ?? GRACE,
  });
  running.owners.push(owner);
  const { pipe, secret } = await owner.listening;
  return { owner, clock, ptys, specs, pipe, secret, discovery };
}

afterEach(async () => {
  for (const c of running.clients.splice(0)) c.destroy();
  for (const o of running.owners.splice(0)) { o.close(); await o.closed; }
  for (const d of running.dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('ownerCore (named pipe; win32 only because the pipe path is a Windows named pipe)', () => {
  describe('auth and gating', () => {
    it('completes the mutual handshake and writes a discovery file naming the pipe and secret', async () => {
      const r = await rig();
      const c = await handshake(r.pipe, r.secret); // asserts the helper proof inside
      expect(c.closed).toBe(false);
      const d = JSON.parse(fs.readFileSync(r.discovery, 'utf8'));
      expect(d).toMatchObject({ v: 1, pipe: r.pipe, secret: r.secret });
    });

    it('destroys a socket that answers the challenge with the wrong secret', async () => {
      const r = await rig();
      const c = await connect(r.pipe);
      c.send({ t: 'hello', proto: PROTO, nonceC: newNonce() });
      const ch = await c.next('challenge');
      c.send({ t: 'auth', proofC: signProof(newSecret(), 'client', ch.nonceS) });
      await c.whenClosed();
      expect(c.frames.some((f) => f.t === 'ready')).toBe(false);
    });

    it('rejects a protocol mismatch with an error frame', async () => {
      const r = await rig();
      const c = await connect(r.pipe);
      c.send({ t: 'hello', proto: PROTO + 1, nonceC: newNonce() });
      expect((await c.next('error')).code).toBe('proto');
    });

    const verbs: Array<[string, () => unknown]> = [
      ['claim', () => ({ t: 'claim' })], ['list', () => ({ t: 'list' })], ['ping', () => ({ t: 'ping' })],
      ['spawn', () => ({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} })],
      ['attach', () => ({ t: 'attach', slot: 'claude' })], ['write', () => ({ t: 'write', slot: 'claude', d: 'x' })],
      ['resize', () => ({ t: 'resize', slot: 'claude', cols: 10, rows: 10 })], ['kill', () => ({ t: 'kill', slot: 'claude' })],
      ['forget', () => ({ t: 'forget', slot: 'claude' })], ['release', () => ({ t: 'release' })], ['shutdown', () => ({ t: 'shutdown' })],
    ];
    it.each(verbs)('destroys an unauthenticated socket that sends %s, before and after hello', async (_name, frame) => {
      const r = await rig();
      const a = await connect(r.pipe);
      a.send(frame());
      await a.whenClosed();
      const b = await connect(r.pipe);
      b.send({ t: 'hello', proto: PROTO, nonceC: newNonce() });
      await b.next('challenge');
      b.send(frame());
      await b.whenClosed();
      expect(r.ptys).toHaveLength(0);
      expect(r.owner.hasOwner()).toBe(false);
    });

    it('closes an unauthenticated socket at the 5 s deadline', async () => {
      const r = await rig();
      const c = await connect(r.pipe);
      c.send({ t: 'hello', proto: PROTO, nonceC: newNonce() }); // round trip: the server has registered the socket
      await c.next('challenge');
      r.clock.advance(AUTH_DEADLINE_MS - 1);
      await new Promise((res) => setTimeout(res, 60));
      expect(c.closed).toBe(false);
      r.clock.advance(1);
      await c.whenClosed();
    });

    it('allows at most 4 unauthenticated sockets at once', async () => {
      const r = await rig();
      const held: Client[] = [];
      for (let i = 0; i < MAX_UNAUTH_SOCKETS; i++) held.push(await connect(r.pipe));
      const fifth = await connect(r.pipe);
      await fifth.whenClosed();
      expect(held.every((h) => !h.closed)).toBe(true);
    });

    it('refuses shell verbs from an authenticated socket that has not claimed, but serves list and ping', async () => {
      const r = await rig();
      const c = await handshake(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      expect((await c.next('error')).code).toBe('not-owner');
      c.send({ t: 'shutdown' });
      expect((await c.next('error')).code).toBe('not-owner');
      c.send({ t: 'list' });
      expect((await c.next('slots')).slots).toEqual([]);
      c.send({ t: 'ping' });
      await c.next('pong');
      expect(r.ptys).toHaveLength(0);
    });

    it('destroys the socket on an invalid spec and spawns nothing', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec({ file: 'cmd.exe' }), meta: {} });
      await c.whenClosed();
      expect(r.ptys).toHaveLength(0);
    });
  });

  describe('single owner', () => {
    it('answers busy to a second claim while the owner is alive', async () => {
      const r = await rig();
      const a = await owned(r.pipe, r.secret);
      const b = await handshake(r.pipe, r.secret);
      b.send({ t: 'claim' });
      await b.next('busy');
      expect(a.closed).toBe(false);
      b.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      expect((await b.next('error')).code).toBe('not-owner');
    });

    it('accepts a second claim after the owner socket closed', async () => {
      const r = await rig();
      const a = await owned(r.pipe, r.secret);
      a.destroy();
      await vi.waitFor(() => expect(r.owner.hasOwner()).toBe(false));
      await owned(r.pipe, r.secret);
      expect(r.owner.hasOwner()).toBe(true);
    });

    it('displaces an owner that missed pings, and a ping keeps the owner alive', async () => {
      const r = await rig();
      const a = await owned(r.pipe, r.secret);
      r.clock.advance(OWNER_STALE_MS - 500);
      a.send({ t: 'ping' });
      await a.next('pong');
      r.clock.advance(OWNER_STALE_MS - 500);
      const b = await handshake(r.pipe, r.secret);
      b.send({ t: 'claim' });
      await b.next('busy');
      r.clock.advance(1000);
      b.send({ t: 'claim' });
      await b.next('slots');
      await a.next('displaced');
      await a.whenClosed();
    });
  });

  describe('sessions', () => {
    it('hands the factory exactly spec.env, runs spec.writes in order, and never merges the helper env', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      const s = spec({ env: { ONLY: '1' }, writes: ['one\r', 'two\r'] });
      c.send({ t: 'spawn', slot: 'claude', spec: s, meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      expect(r.specs[0].env).toEqual({ ONLY: '1' });
      expect(Object.keys(r.specs[0].env)).not.toContain('ELECTRON_RUN_AS_NODE');
      expect(r.ptys[0].writes).toEqual(['one\r', 'two\r']);
    });

    it('reports spawn-failed when the factory throws', async () => {
      const r = await rig({ spawn: () => { throw new Error('nope'); } });
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      expect((await c.next('error')).code).toBe('spawn-failed');
    });

    it('streams data frames with increasing seq and forwards write, resize and kill', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'codex', spec: spec(), meta: { k: 1 } });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      const p = r.ptys[0];
      p.emit('a'); p.emit('b'); p.emit('c');
      const got = [await c.next('data'), await c.next('data'), await c.next('data')];
      expect(got.map((g) => [g.slot, g.seq, g.d])).toEqual([['codex', 1, 'a'], ['codex', 2, 'b'], ['codex', 3, 'c']]);
      c.send({ t: 'write', slot: 'codex', d: 'ls\r' });
      c.send({ t: 'resize', slot: 'codex', cols: 100, rows: 30 });
      await vi.waitFor(() => expect(p.writes).toEqual(['ls\r']));
      await vi.waitFor(() => expect(p.resizes).toEqual([[100, 30]]));
      c.send({ t: 'kill', slot: 'codex' });
      await c.next('exit');
      expect(p.killed).toBe(1);
    });

    it('trims the ring at the cap while seq stays monotonic', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      const chunk = 'x'.repeat(100_000);
      for (let i = 0; i < 6; i++) r.ptys[0].emit(chunk);
      c.send({ t: 'attach', slot: 'claude' });
      const at = await c.next('attached');
      expect(at.seq).toBe(6);
      expect(at.ring.length).toBeGreaterThan(0);
      expect(at.ring.length).toBeLessThan(6);
      expect(at.ring.reduce((n, x) => n + JSON.stringify(x.d).length, 0)).toBeLessThanOrEqual(RING_MAX);
      const seqs = at.ring.map((x) => x.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(seqs[seqs.length - 1]).toBe(6);
      expect(seqs[0]).toBeGreaterThan(1);
    });

    it('keeps an exited record while nobody owns the helper until it is forgotten', async () => {
      const r = await rig();
      const a = await owned(r.pipe, r.secret);
      a.send({ t: 'spawn', slot: 'terminal2', spec: spec(), meta: { m: 1 } });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      a.destroy();
      await vi.waitFor(() => expect(r.owner.hasOwner()).toBe(false));
      r.ptys[0].emit('bye');
      r.ptys[0].exitNow();
      const b = await handshake(r.pipe, r.secret);
      b.send({ t: 'claim' });
      const sl = await b.next('slots');
      expect(sl.slots).toMatchObject([{ slot: 'terminal2', state: 'exited', meta: { m: 1 } }]);
      b.send({ t: 'attach', slot: 'terminal2' });
      const at = await b.next('attached');
      expect(at.state).toBe('exited');
      expect(at.ring.map((x) => x.d)).toEqual(['bye']);
      b.send({ t: 'forget', slot: 'terminal2' });
      b.send({ t: 'list' });
      expect((await b.next('slots')).slots).toEqual([]);
    });

    it('refuses to forget a running slot', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      c.send({ t: 'forget', slot: 'claude' });
      expect((await c.next('error')).code).toBe('slot-running');
    });
  });

  describe('reconnect', () => {
    it('replays by seq gaplessly and without duplicates while the pty keeps producing output', async () => {
      const r = await rig();
      const a = await owned(r.pipe, r.secret);
      a.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      const p = r.ptys[0];
      let n = 0;
      const emit = (): void => p.emit(`<${n++}>`);
      for (let i = 0; i < 3; i++) emit();
      await vi.waitFor(() => expect(a.frames.filter((f) => f.t === 'data')).toHaveLength(3));
      const live1 = a.frames.filter((f): f is Extract<HelperFrame, { t: 'data' }> => f.t === 'data');
      a.destroy();
      await vi.waitFor(() => expect(r.owner.hasOwner()).toBe(false));
      for (let i = 0; i < 4; i++) emit(); // emitted while the owner is away

      const b = await handshake(r.pipe, r.secret);
      b.send({ t: 'claim' });
      await b.next('slots');
      b.send({ t: 'attach', slot: 'claude' });
      // Output racing the attach request: some lands before it is processed, some after.
      for (let i = 0; i < 6; i++) { emit(); await new Promise((res) => setImmediate(res)); }
      const at = await b.next('attached');
      for (let i = 0; i < 3; i++) emit(); // after the attach reply
      await vi.waitFor(() => expect(b.frames.filter((f) => f.t === 'data').length).toBeGreaterThanOrEqual(3));
      await new Promise((res) => setTimeout(res, 50));

      // What a client reconstructs: apply every chunk with seq above what it already has.
      let have = live1[live1.length - 1].seq;
      const seen: Array<{ seq: number; d: string }> = live1.map((x) => ({ seq: x.seq, d: x.d }));
      const apply = (seq: number, d: string): void => {
        if (seq <= have) return;
        expect(seq).toBe(have + 1); // gapless
        have = seq; seen.push({ seq, d });
      };
      at.ring.forEach((x) => apply(x.seq, x.d));
      for (const f of b.frames) if (f.t === 'data') { expect(f.seq).toBeGreaterThan(at.seq); apply(f.seq, f.d); }
      expect(seen.map((x) => x.d).join('')).toBe(Array.from({ length: n }, (_, i) => `<${i}>`).join(''));
      expect(have).toBe(n);
    });
  });

  describe('grace window and shutdown', () => {
    it('keeps sessions until the grace window ends after the owner socket drops, then kills them and closes', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      c.send({ t: 'spawn', slot: 'codex', spec: spec(), meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(2));
      c.destroy();
      await vi.waitFor(() => expect(r.owner.hasOwner()).toBe(false));
      r.clock.advance(GRACE - 1);
      expect(r.ptys.map((p) => p.killed)).toEqual([0, 0]);
      expect(fs.existsSync(r.discovery)).toBe(true);
      r.clock.advance(1);
      await r.owner.closed;
      expect(r.ptys.map((p) => p.killed)).toEqual([1, 1]);
      expect(fs.existsSync(r.discovery)).toBe(false);
    });

    it('starts the grace timer on release too', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      c.send({ t: 'release' });
      await c.whenClosed();
      expect(r.ptys[0].killed).toBe(0);
      r.clock.advance(GRACE - 1);
      expect(r.ptys[0].killed).toBe(0);
      r.clock.advance(1);
      await r.owner.closed;
      expect(r.ptys[0].killed).toBe(1);
    });

    it('cancels the grace timer when an owner claims in time', async () => {
      const r = await rig();
      const a = await owned(r.pipe, r.secret);
      a.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      a.destroy();
      await vi.waitFor(() => expect(r.owner.hasOwner()).toBe(false));
      r.clock.advance(GRACE - 1);
      await owned(r.pipe, r.secret);
      r.clock.advance(GRACE * 2);
      expect(r.ptys[0].killed).toBe(0);
    });

    it('shutdown kills every shell, removes the discovery file and closes', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      c.send({ t: 'spawn', slot: 'terminal2', spec: spec(), meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(2));
      c.send({ t: 'shutdown' });
      await r.owner.closed;
      expect(r.ptys.map((p) => p.killed)).toEqual([1, 1]);
      expect(fs.existsSync(r.discovery)).toBe(false);
    });

    it('exits after the idle window when there is no owner and no live shell', async () => {
      const r = await rig();
      r.clock.advance(IDLE_EXIT_MS - 1);
      expect(fs.existsSync(r.discovery)).toBe(true);
      r.clock.advance(1);
      await r.owner.closed;
      expect(fs.existsSync(r.discovery)).toBe(false);
    });

    it('drops an owner whose socket backs up instead of buffering', async () => {
      const r = await rig();
      const c = await owned(r.pipe, r.secret);
      c.send({ t: 'spawn', slot: 'claude', spec: spec(), meta: {} });
      await vi.waitFor(() => expect(r.ptys).toHaveLength(1));
      c.socket.pause(); // never reads
      const chunk = 'y'.repeat(60_000);
      for (let i = 0; i < 300; i++) r.ptys[0].emit(chunk);
      await vi.waitFor(() => expect(r.owner.hasOwner()).toBe(false));
      expect(r.ptys[0].killed).toBe(0); // dropped owner only starts the grace window
    });
  });

  describe('discovery file', () => {
    it('refuses to start while another live owner holds the discovery file', async () => {
      const first = await rig();
      const clock = new FakeClock();
      const second = createOwner({
        spawn: () => new FakePty(), homedir: HOME, discoveryPath: first.discovery, now: clock.now, setTimer: clock.setTimer, graceMs: GRACE,
      });
      running.owners.push(second);
      await expect(second.listening).rejects.toThrow(/another pty-owner/);
      expect(JSON.parse(fs.readFileSync(first.discovery, 'utf8')).pipe).toBe(first.pipe);
    });

    it('replaces a stale discovery file whose pipe is dead', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyowner-'));
      running.dirs.push(dir);
      const stale = path.join(dir, 'd.json');
      fs.writeFileSync(stale, JSON.stringify({ v: 1, pipe: `\\\\.\\pipe\\aether-dead-${newNonce()}`, pid: 1, startedAt: 1, secret: newSecret() }));
      const r = await rig({ discoveryPath: stale });
      expect(JSON.parse(fs.readFileSync(stale, 'utf8')).pipe).toBe(r.pipe);
    });
  });
});

describe.skipIf(process.platform === 'win32')('ownerCore on non-win32', () => {
  it.skip('pipe tests are Windows-only: the helper listens on a Windows named pipe', () => {});
});

