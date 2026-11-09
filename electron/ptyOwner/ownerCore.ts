// Core of the detached pty-owner helper: a named-pipe server that owns the shells while main
// is away. node-pty is injected through `spawn` so this file stays testable and out of
// boundary rule 6 (no node-pty, child_process, electron or ptyLifecycle import here).
//
// Trust model: the pipe may be openable by other local users, so every verb except hello/auth
// is gated on a completed mutual-HMAC handshake, unauthenticated sockets are capped (4) and
// time out (5 s), and any malformed frame destroys the socket. Diag lines are fixed strings.
import net from 'node:net';
import { readFile, rm, writeFile } from 'node:fs/promises';
import {
  FRAME_MAX_BYTES, PROTO, RING_MAX, createFrameReader, encodeDiscovery, decodeDiscovery, encodeFrame,
  newNonce, newSecret, parseClientFrame, signProof, verifyProof,
  type ClientFrame, type HelperFrame, type LaunchSpec, type Meta, type RingChunk, type SlotInfo,
} from './protocol';
import type { TerminalSlotId } from '../../src/shared/remote/types';

/** Structural subset of a node-pty IPty; the real wiring lives in the helper entry. */
export interface OwnerPty {
  onData(cb: (d: string) => void): unknown;
  onExit(cb: () => void): unknown;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
/** Arms a one-shot timer and returns its cancel function. */
export type SetTimer = (fn: () => void, ms: number) => () => void;
export const realSetTimer: SetTimer = (fn, ms) => { const h = setTimeout(fn, ms); h.unref(); return () => clearTimeout(h); };

export interface OwnerOptions {
  spawn: (spec: LaunchSpec) => OwnerPty;
  homedir: string;
  discoveryPath: string;
  pipePath?: string;
  now?: () => number;
  setTimer?: SetTimer;
  graceMs: number;
  idleMs?: number;
  pid?: number;
  log?: (line: string) => void;
}
export interface Owner {
  /** Resolves once the pipe is listening AND the discovery file is written. */
  listening: Promise<{ pipe: string; secret: string }>;
  /** Resolves after the helper has killed every shell, removed the discovery file and closed the pipe. */
  closed: Promise<void>;
  /** Same teardown as grace expiry / `shutdown`. */
  close(): void;
  hasOwner(): boolean;
}

export const AUTH_DEADLINE_MS = 5000;
export const MAX_UNAUTH_SOCKETS = 4;
export const OWNER_STALE_MS = 4500; // ping every 2 s: more than two missed pings
export const IDLE_EXIT_MS = 30_000;
const RING_CHUNK_OVERHEAD = 24; // per-chunk cost so tiny chunks cannot blow the attach frame cap

interface Slot {
  pty: OwnerPty; state: 'running' | 'exited'; cols: number; rows: number; meta: Meta; startedAt: number;
  ring: Array<RingChunk & { cost: number }>; ringCost: number; seq: number;
}
interface Conn {
  socket: net.Socket; phase: 'new' | 'challenged' | 'authed'; nonceS: string; lastSeen: number;
  subs: Set<TerminalSlotId>; cancelAuth: () => void;
}

export function createOwner(opts: OwnerOptions): Owner {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? realSetTimer;
  const idleMs = opts.idleMs ?? IDLE_EXIT_MS;
  const log = opts.log ?? (() => {});
  const pipe = opts.pipePath ?? `\\\\.\\pipe\\aether-pty-owner-${newNonce()}`;
  const secret = newSecret();
  const endpoint = pipe;
  const conns = new Set<Conn>();
  const slots = new Map<TerminalSlotId, Slot>();
  let owner: Conn | null = null;
  let cancelAway: (() => void) | null = null;
  let closing = false;
  let wroteDiscovery = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => { resolveClosed = r; });
  const server = net.createServer();

  const liveCount = (): number => { let n = 0; for (const s of slots.values()) if (s.state === 'running') n++; return n; };
  const info = (id: TerminalSlotId, s: Slot): SlotInfo =>
    ({ slot: id, state: s.state, cols: s.cols, rows: s.rows, meta: s.meta, startedAt: s.startedAt });
  const allInfo = (): SlotInfo[] => [...slots.entries()].map(([id, s]) => info(id, s));

  function send(c: Conn, frame: HelperFrame): boolean {
    if (c.socket.destroyed) return false;
    // Owner-socket backpressure: drop the connection (it reconnects and replays from the ring).
    if (c.socket.writableLength > 2 * FRAME_MAX_BYTES) { log('owner backpressure drop'); c.socket.destroy(); return false; }
    try { c.socket.write(encodeFrame(frame)); return true; } catch { c.socket.destroy(); return false; }
  }

  function teardown(why: string): void {
    if (closing) return;
    closing = true;
    log(`owner closing: ${why}`);
    cancelAway?.(); cancelAway = null;
    for (const s of slots.values()) if (s.state === 'running') { try { s.pty.kill(); } catch { /* already dead */ } }
    for (const c of conns) { c.cancelAuth(); c.socket.destroy(); }
    const finish = (): void => { server.close(() => resolveClosed()); };
    if (wroteDiscovery) rm(opts.discoveryPath, { force: true }).then(finish, finish); else finish();
    // server.close() never fires its callback if the server was not listening.
    if (!server.listening) resolveClosed();
  }

  // Away mode: no owner. Shells live for graceMs; with no live shell the helper leaves after idleMs.
  function armAway(): void {
    cancelAway?.();
    const delay = liveCount() > 0 ? opts.graceMs : idleMs;
    cancelAway = setTimer(() => teardown('away timer expired'), delay);
  }
  function ownerGone(c: Conn): void {
    if (owner !== c) return;
    owner = null;
    armAway();
  }

  function ringAppend(s: Slot, d: string): void {
    s.seq += 1;
    const cost = JSON.stringify(d).length + RING_CHUNK_OVERHEAD;
    if (cost > RING_MAX) { s.ring = []; s.ringCost = 0; return; }
    s.ring.push({ seq: s.seq, d, cost });
    s.ringCost += cost;
    while (s.ringCost > RING_MAX && s.ring.length > 0) s.ringCost -= s.ring.shift()!.cost;
  }

  function wirePty(id: TerminalSlotId, s: Slot): void {
    const { pty } = s;
    pty.onData((d) => {
      if (closing || slots.get(id) !== s || s.pty !== pty) return;
      ringAppend(s, d); // always drain, owner or not
      if (owner && owner.subs.has(id)) send(owner, { t: 'data', slot: id, seq: s.seq, d });
    });
    pty.onExit(() => {
      if (closing || slots.get(id) !== s || s.pty !== pty || s.state === 'exited') return;
      s.state = 'exited';
      if (owner && owner.subs.has(id)) send(owner, { t: 'exit', slot: id });
      if (!owner && liveCount() === 0) armAway();
    });
  }

  function doSpawn(c: Conn, f: Extract<ClientFrame, { t: 'spawn' }>): void {
    const prev = slots.get(f.slot);
    if (prev && prev.state === 'running') { try { prev.pty.kill(); } catch { /* ignore */ } }
    let pty: OwnerPty;
    try { pty = opts.spawn(f.spec); } catch { slots.delete(f.slot); send(c, { t: 'error', code: 'spawn-failed' }); return; }
    // Seq stays monotonic across a respawn; only the ring is reset.
    const s: Slot = { pty, state: 'running', cols: f.spec.cols, rows: f.spec.rows, meta: f.meta, startedAt: now(),
      ring: [], ringCost: 0, seq: prev?.seq ?? 0 };
    slots.set(f.slot, s);
    c.subs.add(f.slot);
    wirePty(f.slot, s);
    for (const w of f.spec.writes) { try { pty.write(w); } catch { /* shell already gone */ } }
  }

  function claim(c: Conn): void {
    if (owner && owner !== c) {
      const stale = owner.socket.destroyed || now() - owner.lastSeen > OWNER_STALE_MS;
      if (!stale) { send(c, { t: 'busy' }); return; }
      const old = owner;
      owner = null;
      send(old, { t: 'displaced' });
      old.socket.end();
    }
    owner = c;
    cancelAway?.(); cancelAway = null;
    send(c, { t: 'slots', slots: allInfo() });
  }

  function onAuthedFrame(c: Conn, f: ClientFrame): void {
    switch (f.t) {
      case 'ping': send(c, { t: 'pong' }); return;
      case 'list': send(c, { t: 'slots', slots: allInfo() }); return;
      case 'claim': claim(c); return;
      case 'hello': case 'auth': c.socket.destroy(); return;
      default: break;
    }
    // Everything below acts on shells: only the claimed owner may do it.
    if (owner !== c) { send(c, { t: 'error', code: 'not-owner' }); return; }
    switch (f.t) {
      case 'spawn': doSpawn(c, f); return;
      case 'attach': {
        const s = slots.get(f.slot);
        if (!s) { send(c, { t: 'error', code: 'no-slot' }); return; }
        // Single-threaded: subscribe and snapshot in one step, so seq makes replay + live gapless.
        c.subs.add(f.slot);
        send(c, { t: 'attached', slot: f.slot, state: s.state, cols: s.cols, rows: s.rows, meta: s.meta,
          startedAt: s.startedAt, ring: s.ring.map(({ seq, d }) => ({ seq, d })), seq: s.seq });
        return;
      }
      case 'write': { const s = slots.get(f.slot); if (s?.state === 'running') { try { s.pty.write(f.d); } catch { /* gone */ } } return; }
      case 'resize': {
        const s = slots.get(f.slot);
        if (s?.state === 'running') { try { s.pty.resize(f.cols, f.rows); s.cols = f.cols; s.rows = f.rows; } catch { /* gone */ } }
        return;
      }
      case 'kill': { const s = slots.get(f.slot); if (s?.state === 'running') { try { s.pty.kill(); } catch { /* gone */ } } return; }
      case 'forget': {
        const s = slots.get(f.slot);
        if (!s) return;
        if (s.state === 'running') { send(c, { t: 'error', code: 'slot-running' }); return; }
        slots.delete(f.slot); c.subs.delete(f.slot);
        return;
      }
      case 'release':
        // Owner leaving on purpose: sessions stay, grace timer starts.
        ownerGone(c);
        c.socket.end();
        return;
      case 'shutdown': teardown('shutdown'); return;
      default: return;
    }
  }

  function onFrame(c: Conn, raw: Record<string, unknown>): void {
    const f = parseClientFrame(raw, opts.homedir);
    if (!f) { c.socket.destroy(); return; }
    c.lastSeen = now();
    if (c.phase === 'authed') { onAuthedFrame(c, f); return; }
    // Unauthenticated: hello then auth, nothing else.
    if (c.phase === 'new' && f.t === 'hello') {
      if (f.proto !== PROTO) { send(c, { t: 'error', code: 'proto' }); c.socket.end(); return; }
      c.nonceS = newNonce();
      c.phase = 'challenged';
      send(c, { t: 'challenge', nonceS: c.nonceS, proofS: signProof(secret, 'server', f.nonceC) });
      return;
    }
    if (c.phase === 'challenged' && f.t === 'auth' && verifyProof(secret, 'client', c.nonceS, f.proofC)) {
      c.phase = 'authed';
      c.cancelAuth();
      send(c, { t: 'ready', slots: allInfo() });
      return;
    }
    c.socket.destroy();
  }

  server.on('connection', (socket) => {
    if (closing) { socket.destroy(); return; }
    let unauth = 0;
    for (const x of conns) if (x.phase !== 'authed') unauth++;
    if (unauth >= MAX_UNAUTH_SOCKETS) { socket.destroy(); return; }
    const c: Conn = { socket, phase: 'new', nonceS: '', lastSeen: now(), subs: new Set(), cancelAuth: () => {} };
    c.cancelAuth = setTimer(() => socket.destroy(), AUTH_DEADLINE_MS);
    conns.add(c);
    const reader = createFrameReader((raw) => onFrame(c, raw), () => socket.destroy());
    socket.on('data', (chunk) => reader.push(chunk));
    socket.on('error', () => { /* close follows */ });
    socket.on('close', () => {
      conns.delete(c);
      c.cancelAuth();
      c.subs.clear();
      ownerGone(c);
    });
  });

  // Another live helper may already hold the discovery file; a dead one's file is replaced.
  async function probeAlive(pipeName: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const s = net.connect(pipeName);
      const cancel = setTimer(() => { s.destroy(); resolve(false); }, 1000);
      const done = (alive: boolean): void => { cancel(); s.destroy(); resolve(alive); };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  }
  async function writeDiscovery(): Promise<void> {
    const text = encodeDiscovery({ v: 1, pipe, pid: opts.pid ?? process.pid, startedAt: now(), secret });
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(opts.discoveryPath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        wroteDiscovery = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
        const old = decodeDiscovery(await readFile(opts.discoveryPath, 'utf8').catch(() => ''));
        if (old && await probeAlive(old.pipe)) throw new Error('another pty-owner is running');
        await rm(opts.discoveryPath, { force: true });
      }
    }
  }

  const listening = new Promise<{ pipe: string; secret: string }>((resolve, reject) => {
    function onListening(): void {
      server.removeListener('error', reject);
      writeDiscovery().then(
        () => { if (!owner) armAway(); resolve({ pipe, secret }); },
        (e) => { teardown('discovery failed'); reject(e); },
      );
    }
    server.once('error', reject);
    server.listen(endpoint, onListening);
  });
  listening.catch(() => { /* surfaced to the caller of `listening`; avoid an unhandled rejection here */ });

  return { listening, closed, close: () => teardown('close'), hasOwner: () => owner !== null };
}
