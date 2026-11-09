// Main-side connection to the detached pty-owner helper: mutual-HMAC handshake, claim, the
// verbs, a ping timer and the one-shot reconnect of Design 12. Dial-out only (no listen), no
// process launching, no node-pty: the launcher and the helper entry own those.
//
// Trust: the helper's proof is checked before anything but `hello` and `auth` is written, so a
// squatter on the pipe never receives a spawn or write frame.
import net from 'node:net';
import fs from 'node:fs';
import {
  PROTO, createFrameReader, decodeDiscovery, encodeFrame, newNonce, parseHelperFrame, signProof, verifyProof,
  type ClientFrame, type Discovery, type HelperFrame, type LaunchSpec, type Meta, type RingChunk, type SlotInfo,
} from './protocol';
import { RemotePty } from './remotePty';
import type { TerminalSlotId } from '../../src/shared/remote/types';

/** Arms a one-shot timer and returns its cancel function. */
export type SetTimer = (fn: () => void, ms: number) => () => void;
const realSetTimer: SetTimer = (fn, ms) => { const h = setTimeout(fn, ms); h.unref(); return () => clearTimeout(h); };

export const PING_MS = 2000;
export const DEAD_AFTER_MS = 7000; // no inbound frame for this long: treat the socket as dead
export const CONNECT_TIMEOUT_MS = 5000;
export const RECONNECT_MS = 2000; // Design 12
export const CLAIM_RETRIES = 5; // `busy` can be a race with the old owner's socket close
export const CLAIM_BACKOFF_MS = 100; // doubles per retry
const ATTACH_TIMEOUT_MS = 2000;

export interface OwnerClientOptions {
  setTimer?: SetTimer;
  now?: () => number;
  /** Fixed-string diag lines only. */
  log?: (line: string) => void;
  connectTimeoutMs?: number;
  reconnectMs?: number;
  claimRetries?: number;
  claimBackoffMs?: number;
}
export interface AttachResult {
  pty: RemotePty; state: 'running' | 'exited'; cols: number; rows: number; meta: Meta; startedAt: number;
  ring: RingChunk[]; seq: number;
}
export interface OwnerClient {
  /** Resolves once authenticated and claimed; rejects (and `ready` stays false) otherwise. */
  connect(discoveryPath: string): Promise<void>;
  readonly ready: boolean;
  spawn(slot: TerminalSlotId, spec: LaunchSpec, meta: Meta): RemotePty;
  list(): Promise<SlotInfo[]>;
  attach(slot: TerminalSlotId): Promise<AttachResult>;
  forget(slot: TerminalSlotId): void;
  release(): void;
  shutdown(): void;
  /** Fires once when the connection is lost for good (reconnect failed, or displaced). */
  onLost(cb: () => void): () => void;
}

interface Session { socket: net.Socket }
interface Opening { done: Promise<Session>; abort(): void }
type State = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'dead' | 'closed';
type AttachedFrame = Extract<HelperFrame, { t: 'attached' }>;
interface AttachWaiter { slot: TerminalSlotId; apply(f: AttachedFrame): void; reject(why: string): void }

export function createOwnerClient(opts: OwnerClientOptions = {}): OwnerClient {
  const setTimer = opts.setTimer ?? realSetTimer;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const reconnectMs = opts.reconnectMs ?? RECONNECT_MS;
  const claimRetries = opts.claimRetries ?? CLAIM_RETRIES;
  const claimBackoffMs = opts.claimBackoffMs ?? CLAIM_BACKOFF_MS;

  let state: State = 'idle';
  let discoveryPath = '';
  let session: Session | null = null;
  let lastRx = 0;
  let cancelPing: () => void = () => {};
  let displaced = false;
  const remotes = new Map<TerminalSlotId, RemotePty>();
  const unconfirmed = new Set<TerminalSlotId>(); // spawned, no data/exit seen yet
  const listWaiters: Array<(slots: SlotInfo[]) => void> = [];
  let attachWaiter: AttachWaiter | null = null;
  let attachChain: Promise<unknown> = Promise.resolve();
  const lostCbs = new Set<() => void>();

  const link = {
    send(frame: ClientFrame): boolean {
      if (state !== 'ready' || !session || session.socket.destroyed) return false;
      try { session.socket.write(encodeFrame(frame)); return true; } catch { return false; }
    },
    dead: (): boolean => state === 'idle' || state === 'dead' || state === 'closed',
  };

  // ---- one connection: connect, mutual proof, claim ----
  function open(d: Discovery, onFrame: (f: HelperFrame) => void, onClose: (s: Session) => void): Opening {
    const socket = net.createConnection(d.pipe);
    const sess: Session = { socket };
    const nonceC = newNonce();
    let settled = false;
    let phase: 'challenge' | 'ready' | 'claim' = 'challenge';
    let attempt = 0;
    let cancelRetry: () => void = () => {};
    let post = false;
    let resolveDone!: (s: Session) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<Session>((res, rej) => { resolveDone = res; rejectDone = rej; });
    done.catch(() => { /* surfaced to the caller */ });
    const fail = (why: string): void => {
      if (settled) return;
      settled = true; cancelRetry(); socket.destroy(); rejectDone(new Error(why));
    };
    const writeFrame = (f: ClientFrame): void => { try { socket.write(encodeFrame(f)); } catch { fail('write failed'); } };
    const sendClaim = (): void => writeFrame({ t: 'claim' });

    function step(f: HelperFrame): void {
      if (phase === 'challenge') {
        if (f.t !== 'challenge') { fail(f.t === 'error' ? `error ${f.code}` : f.t === 'busy' ? 'busy' : 'unexpected frame'); return; }
        if (!verifyProof(d.secret, 'server', nonceC, f.proofS)) { fail('bad proof'); return; }
        writeFrame({ t: 'auth', proofC: signProof(d.secret, 'client', f.nonceS) });
        phase = 'ready';
      } else if (phase === 'ready') {
        if (f.t !== 'ready') { fail(f.t === 'error' ? `error ${f.code}` : 'unexpected frame'); return; }
        phase = 'claim';
        sendClaim();
      } else if (f.t === 'slots') {
        post = true; settled = true; resolveDone(sess);
      } else if (f.t === 'busy') {
        // The previous owner's socket may be dead before the helper has noticed: back off and retry.
        if (attempt >= claimRetries) { fail('busy'); return; }
        const delay = claimBackoffMs * 2 ** attempt;
        attempt++;
        cancelRetry = setTimer(sendClaim, delay);
      } else {
        fail(f.t === 'error' ? `error ${f.code}` : 'unexpected frame');
      }
    }

    const reader = createFrameReader((raw) => {
      const f = parseHelperFrame(raw);
      if (!f) { if (post) socket.destroy(); else fail('bad frame'); return; }
      if (post) onFrame(f); else step(f);
    }, () => { if (post) socket.destroy(); else fail('bad frame'); });
    socket.on('connect', () => writeFrame({ t: 'hello', proto: PROTO, nonceC }));
    socket.on('data', (c) => reader.push(c));
    socket.on('error', () => { /* close follows */ });
    socket.on('close', () => { if (post) onClose(sess); else fail('closed'); });
    return { done, abort: () => fail('timeout') };
  }

  function readDiscovery(): Discovery {
    const d = decodeDiscovery(fs.readFileSync(discoveryPath, 'utf8'));
    if (!d) throw new Error('bad discovery file');
    return d;
  }

  // ---- inbound ----
  function onFrame(f: HelperFrame): void {
    lastRx = now();
    switch (f.t) {
      case 'data': unconfirmed.delete(f.slot); remotes.get(f.slot)?.deliver(f.seq, f.d); return;
      case 'exit': unconfirmed.delete(f.slot); remotes.get(f.slot)?.deliverExit(); return;
      case 'slots': listWaiters.shift()?.(f.slots); return;
      case 'attached': if (attachWaiter?.slot === f.slot) attachWaiter.apply(f); return;
      case 'displaced': displaced = true; return;
      case 'error': onError(f.code); return;
      default: return; // pong, and handshake frames that have no business here
    }
  }
  function onError(code: string): void {
    if (code === 'no-slot') { attachWaiter?.reject('no-slot'); return; }
    if (code === 'spawn-failed') {
      // The error frame names no slot: ask the helper which of the unconfirmed spawns exist.
      const snapshot = [...unconfirmed];
      unconfirmed.clear();
      listWaiters.push((slots) => {
        const present = new Set(slots.map((s) => s.slot));
        for (const slot of snapshot) if (!present.has(slot)) remotes.get(slot)?.deliverExit();
      });
      link.send({ t: 'list' });
      return;
    }
    log(`pty-owner error ${code}`);
  }

  function onClose(s: Session): void {
    if (s !== session) return;
    session = null;
    cancelPing();
    attachWaiter?.reject('closed');
    for (const w of listWaiters.splice(0)) w([]);
    if (state === 'closed') return;
    if (state === 'reconnecting') return; // the in-flight attempt observes the rejection
    if (displaced) { lose('displaced'); return; }
    void reconnect();
  }

  function startPing(): void {
    cancelPing();
    lastRx = now();
    const tick = (): void => {
      if (state !== 'ready' || !session) return;
      if (now() - lastRx > DEAD_AFTER_MS) { session.socket.destroy(); return; }
      link.send({ t: 'ping' });
      cancelPing = setTimer(tick, PING_MS);
    };
    cancelPing = setTimer(tick, PING_MS);
  }

  function lose(why: string): void {
    if (state === 'dead' || state === 'closed') return;
    state = 'dead';
    cancelPing();
    log(`pty-owner connection lost: ${why}`);
    for (const r of remotes.values()) r.deliverExit();
    for (const cb of [...lostCbs]) { try { cb(); } catch { /* ignore */ } }
  }

  // Design 12: one attempt within reconnectMs: re-auth, claim, attach every live shell again.
  async function reconnect(): Promise<void> {
    state = 'reconnecting';
    let timedOut = false;
    let opening: Opening | null = null;
    const cancel = setTimer(() => { timedOut = true; opening?.abort(); session?.socket.destroy(); }, reconnectMs);
    try {
      opening = open(readDiscovery(), onFrame, onClose);
      session = await opening.done;
      if (timedOut) throw new Error('timeout');
      displaced = false;
      state = 'ready';
      startPing();
      for (const [slot, r] of [...remotes]) {
        if (r.finished) continue;
        try { await attachInternal(slot, r); } catch (e) {
          if ((e as Error).message === 'no-slot') r.deliverExit(); else throw e;
        }
      }
    } catch (e) {
      if (session) { const s = session; session = null; s.socket.destroy(); }
      state = 'reconnecting';
      lose((e as Error).message || 'reconnect failed');
    } finally { cancel(); }
  }

  // ---- verbs ----
  function attachInternal(slot: TerminalSlotId, reuse?: RemotePty): Promise<AttachResult> {
    const run = attachChain.then(() => new Promise<AttachResult>((resolve, reject) => {
      if (state !== 'ready') { reject(new Error('not connected')); return; }
      let cancelTimeout: () => void = () => {};
      const waiter: AttachWaiter = {
        slot,
        apply(f) {
          cancelTimeout(); attachWaiter = null;
          // Done in the frame handler itself so data frames behind `attached` find the RemotePty.
          const pty = reuse ?? new RemotePty(slot, link);
          remotes.set(slot, pty);
          for (const c of f.ring) pty.deliver(c.seq, c.d);
          pty.bump(f.seq);
          if (f.state === 'exited') pty.deliverExit();
          resolve({ pty, state: f.state, cols: f.cols, rows: f.rows, meta: f.meta, startedAt: f.startedAt, ring: f.ring, seq: f.seq });
        },
        reject(why) { cancelTimeout(); attachWaiter = null; reject(new Error(why)); },
      };
      attachWaiter = waiter;
      cancelTimeout = setTimer(() => waiter.reject('timeout'), ATTACH_TIMEOUT_MS);
      if (!link.send({ t: 'attach', slot })) waiter.reject('not connected');
    }));
    attachChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function closeIntentionally(frame: ClientFrame): void {
    if (state !== 'ready') { state = 'closed'; return; }
    link.send(frame);
    state = 'closed';
    cancelPing();
    const s = session;
    session = null;
    s?.socket.end();
  }

  return {
    async connect(path: string): Promise<void> {
      discoveryPath = path;
      state = 'connecting';
      displaced = false;
      let opening: Opening | null = null;
      const cancel = setTimer(() => opening?.abort(), connectTimeoutMs);
      try {
        opening = open(readDiscovery(), onFrame, onClose);
        session = await opening.done;
        state = 'ready';
        startPing();
      } catch (e) {
        state = 'idle';
        throw e;
      } finally { cancel(); }
    },
    get ready(): boolean { return state === 'ready'; },
    spawn(slot, spec, meta): RemotePty {
      const pty = new RemotePty(slot, link);
      remotes.set(slot, pty);
      unconfirmed.add(slot);
      if (!link.send({ t: 'spawn', slot, spec, meta })) pty.deliverExit();
      return pty;
    },
    list(): Promise<SlotInfo[]> {
      return new Promise((resolve, reject) => {
        if (state !== 'ready') { reject(new Error('not connected')); return; }
        listWaiters.push(resolve);
        if (!link.send({ t: 'list' })) { listWaiters.pop(); reject(new Error('not connected')); }
      });
    },
    attach: (slot) => attachInternal(slot),
    forget(slot): void {
      remotes.delete(slot); unconfirmed.delete(slot);
      link.send({ t: 'forget', slot });
    },
    release: () => closeIntentionally({ t: 'release' }),
    shutdown: () => closeIntentionally({ t: 'shutdown' }),
    onLost(cb): () => void { lostCbs.add(cb); return () => { lostCbs.delete(cb); }; },
  };
}
