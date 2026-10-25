import { PtyLifecycle, type PtyLike, type PtyLifecycleHandlers } from './ptyLifecycle';
import { createTerminalMirror, type TerminalMirror } from './terminalMirror';
import {
  TERMINAL_CHUNK_MAX_BYTES, TERMINAL_RING_BYTES, TERMINAL_SLOTS,
  type TerminalAttachment, type TerminalInfo, type TerminalReadPort, type TerminalSlotId,
  type TerminalSlotState, type TerminalTap,
} from '../src/shared/remote/types';

/** Raw observation events a slot emits (internal API for the hub's read path). */
export type SlotEvent =
  | { kind: 'out'; q: number; d: string }
  | { kind: 'size'; cols: number; rows: number }
  | { kind: 'state'; state: TerminalSlotState }
  | { kind: 'start'; q: number; cols: number; rows: number };

export type SlotListener = (event: SlotEvent) => void;

const DEFAULT_COLS = 100; // what spawnPty defaults to
const DEFAULT_ROWS = 30;

const validDims = (cols: unknown, rows: unknown): cols is number =>
  Number.isInteger(cols) && (cols as number) > 0 && Number.isInteger(rows) && (rows as number) > 0;

/** Split into pieces of at most `maxBytes` raw UTF-8 bytes, never inside a code point. */
export function splitUtf8(data: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let start = 0, bytes = 0, i = 0;
  while (i < data.length) {
    const cp = data.codePointAt(i) as number;
    const width = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + width > maxBytes) { pieces.push(data.slice(start, i)); start = i; bytes = 0; }
    bytes += width;
    i += cp > 0xffff ? 2 : 1;
  }
  if (start < data.length) pieces.push(data.slice(start));
  return pieces;
}

/** One of the three desktop terminals: a PtyLifecycle that also records state,
 *  size and a strictly increasing output sequence number `q`. */
export class TerminalSlot extends PtyLifecycle {
  private state: TerminalSlotState = 'not-started';
  private cols = 0;
  private rows = 0;
  private q = 0;
  private readonly listeners = new Set<SlotListener>();

  constructor(readonly id: TerminalSlotId) { super(); }

  info(): TerminalInfo {
    const label = TERMINAL_SLOTS.find((slot) => slot.s === this.id)?.label ?? this.id;
    return { s: this.id, label, state: this.state, cols: this.cols, rows: this.rows, q: this.q };
  }

  observe(listener: SlotListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: SlotEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* an observer failure must never reach the renderer path */ }
    }
  }

  start(spawn: () => PtyLike, handlers: PtyLifecycleHandlers, size?: { cols: number; rows: number }): PtyLike {
    return super.start(spawn, {
      onData: (data) => {
        try {
          handlers.onData(data); // renderer first
        } finally {
          // a throwing renderer handler must not skip the fan-out
          for (const d of splitUtf8(data, TERMINAL_CHUNK_MAX_BYTES)) {
            this.q += 1;
            this.emit({ kind: 'out', q: this.q, d });
          }
        }
      },
      onAlive: () => {
        // A pty whose exit fired synchronously while being wired has already cleared `current` and
        // reported 'exited'; onAlive then runs last. Keep the start marker (q, size) but do not
        // flip the state back to 'running'.
        const alive = this.current !== null;
        if (alive) this.state = 'running';
        this.q += 1;
        if (size && validDims(size.cols, size.rows)) { this.cols = size.cols; this.rows = size.rows; }
        else { this.cols = DEFAULT_COLS; this.rows = DEFAULT_ROWS; }
        this.emit({ kind: 'start', q: this.q, cols: this.cols, rows: this.rows });
        if (alive) this.emit({ kind: 'state', state: 'running' });
        handlers.onAlive();
      },
      onExit: () => {
        this.state = 'exited';
        this.emit({ kind: 'state', state: 'exited' });
        handlers.onExit();
      },
    });
  }

  resize(cols: number, rows: number): void {
    super.resize(cols, rows); // a throw here records nothing
    // No live pty means nothing was resized (super is a no-op); do not invent a size.
    if (!this.current || !validDims(cols, rows)) return;
    this.cols = cols; this.rows = rows;
    this.emit({ kind: 'size', cols, rows });
  }
}

// ---- Read path (TerminalReadPort) ----

type Delivery =
  | { k: 'snap'; q: number; cols: number; rows: number; d: string }
  | { k: 'out'; q: number; d: string }
  | { k: 'size'; cols: number; rows: number };

interface MirrorBox { m: TerminalMirror; inflight: number; retired: boolean }
interface RingEntry { q: number; cost: number; d: string }

interface TapState {
  tap: TerminalTap;
  owner: SlotRead;
  dead: boolean;
  draining: boolean;
  queue: Delivery[];      // ready to deliver, in order
  pending: boolean;       // waiting for its snapshot; live events collect in `held`
  held: Delivery[];
  snapGen: number;
}

/** Hub-side read state for one slot. `fedQ` is the last q this state has processed; attach decisions
 *  use it (not slot.info().q) so an event another observer already saw but we have not yet is never skipped. */
interface SlotRead {
  slot: TerminalSlot;
  box: MirrorBox | null;
  ring: RingEntry[];
  head: number;
  cost: number;
  floor: number;          // oldest q we can still resume from is floor - 1 (the client already has it)
  lastResizeQ: number;    // resume needs lastQ >= this
  fedQ: number;
  gen: number;            // bumps on start/release: in-flight snapshots from an older generation are ignored
  taps: Set<TapState>;
}

export type MirrorFactory = (o: { cols: number; rows: number }) => TerminalMirror;

export interface TerminalHub {
  slot(id: TerminalSlotId): TerminalSlot;
  /** Read-only view for the remote gateway: list / attach / onState / retain, nothing else. */
  readPort(): TerminalReadPort;
}

const NOOP_ATTACHMENT: TerminalAttachment = { detach() { /* nothing attached */ } };

/** Owns the three PtyLifecycles (claude, terminal2, codex). `createMirror` is a test seam. */
export function createTerminalHub(opts: { createMirror?: MirrorFactory } = {}): TerminalHub {
  const makeMirror: MirrorFactory = opts.createMirror ?? ((o) => createTerminalMirror(o));
  const slots = new Map<TerminalSlotId, TerminalSlot>(TERMINAL_SLOTS.map(({ s }) => [s, new TerminalSlot(s)]));
  const reads = new Map<TerminalSlotId, SlotRead>();
  const stateListeners = new Set<(e: { s: TerminalSlotId; state: TerminalSlotState }) => void>();
  let retainCount = 0;

  // ---- per-tap delivery: ordered, never re-entrant, a throwing tap is dropped ----
  function kill(t: TapState): void {
    t.dead = true;
    t.queue.length = 0;
    t.held.length = 0;
    t.owner.taps.delete(t);
  }
  function drain(t: TapState): void {
    if (t.draining) return;
    t.draining = true;
    try {
      while (!t.dead && t.queue.length > 0) {
        const e = t.queue.shift() as Delivery;
        try {
          if (e.k === 'snap') t.tap.snap({ q: e.q, cols: e.cols, rows: e.rows, d: e.d });
          else if (e.k === 'out') t.tap.out({ q: e.q, d: e.d });
          else t.tap.size({ cols: e.cols, rows: e.rows });
        } catch {
          kill(t);
        }
      }
    } finally {
      t.draining = false;
    }
  }
  function push(t: TapState, e: Delivery): void {
    if (t.dead) return;
    if (t.pending) { t.held.push(e); return; }
    t.queue.push(e);
    drain(t);
  }
  const fanOut = (r: SlotRead, e: Delivery): void => { for (const t of [...r.taps]) push(t, e); };

  // ---- mirror + ring lifecycle ----
  function retire(box: MirrorBox): void {
    box.retired = true;
    if (box.inflight === 0) box.m.dispose(); // otherwise disposed when the last in-flight snapshot settles
  }
  function resetRing(r: SlotRead): void {
    r.ring = []; r.head = 0; r.cost = 0;
    r.floor = r.fedQ + 1;
  }
  function newBox(info: TerminalInfo): MirrorBox | null {
    if (info.state !== 'running' || !validDims(info.cols, info.rows)) return null;
    try { return { m: makeMirror({ cols: info.cols, rows: info.rows }), inflight: 0, retired: false }; } catch { return null; }
  }
  function ringPush(r: SlotRead, e: RingEntry): void {
    r.ring.push(e);
    r.cost += e.cost;
    while (r.cost > TERMINAL_RING_BYTES && r.head < r.ring.length) {
      r.cost -= r.ring[r.head].cost;
      r.floor = r.ring[r.head].q + 1;
      r.head++;
    }
    if (r.head > 1024 && r.head * 2 > r.ring.length) { r.ring = r.ring.slice(r.head); r.head = 0; }
  }

  function onSlotEvent(r: SlotRead, e: SlotEvent): void {
    const retained = retainCount > 0;
    if (e.kind === 'out') {
      r.fedQ = e.q;
      if (retained) {
        if (r.box) { try { r.box.m.write(e.d); } catch { /* a broken mirror must not stop the feed */ } }
        ringPush(r, { q: e.q, cost: JSON.stringify(e.d).length, d: e.d });
      }
      fanOut(r, { k: 'out', q: e.q, d: e.d });
    } else if (e.kind === 'size') {
      if (retained && r.box) { try { r.box.m.resize(e.cols, e.rows); } catch { /* see above */ } }
      // recorded even while unretained, so a later retain cannot resume a client across it
      r.lastResizeQ = r.fedQ + 1; // a client must have seen output after the resize to resume across it
      fanOut(r, { k: 'size', cols: e.cols, rows: e.rows });
    } else if (e.kind === 'start') {
      r.fedQ = e.q;
      r.gen += 1;
      if (retained) {
        if (r.box) retire(r.box);
        resetRing(r);
        r.lastResizeQ = 0;
        r.box = newBox(r.slot.info());
      }
      for (const t of [...r.taps]) {
        t.pending = false; // any snapshot still in flight belongs to the old generation
        t.held.length = 0;
        push(t, { k: 'snap', q: e.q, cols: e.cols, rows: e.rows, d: '' });
      }
    } else {
      // state: exit clears the mirror and ring (privacy: cleared on slot exit); taps get nothing
      if (e.state === 'exited' && retained) {
        if (r.box) retire(r.box);
        r.box = null;
        resetRing(r);
      }
      for (const cb of [...stateListeners]) {
        try { cb({ s: r.slot.id, state: e.state }); } catch { /* listener failure is its own */ }
      }
    }
  }

  for (const [id, slot] of slots) {
    const r: SlotRead = {
      slot, box: null, ring: [], head: 0, cost: 0, floor: 1, lastResizeQ: 0,
      fedQ: slot.info().q, gen: 0, taps: new Set(),
    };
    reads.set(id, r);
    slot.observe((e) => onSlotEvent(r, e));
  }

  // ---- the port ----
  function attach(id: TerminalSlotId, lastQ: number | null, tap: TerminalTap): TerminalAttachment {
    const r = reads.get(id);
    if (!r) return NOOP_ATTACHMENT;
    const info = r.slot.info();
    const retained = retainCount > 0;
    const t: TapState = { tap, owner: r, dead: false, draining: false, queue: [], pending: false, held: [], snapGen: r.gen };
    const attachment: TerminalAttachment = { detach: () => kill(t) };

    if (!retained) {
      // nothing is mirrored while unretained: an empty snapshot, and no registration
      t.queue.push({ k: 'snap', q: r.fedQ, cols: info.cols, rows: info.rows, d: '' });
      drain(t);
      return attachment;
    }

    const resumable = typeof lastQ === 'number' && Number.isSafeInteger(lastQ) && lastQ >= 0
      && lastQ >= r.floor - 1 && lastQ <= r.fedQ && lastQ >= r.lastResizeQ;
    if (resumable) {
      const from = lastQ as number;
      if (from < r.fedQ) {
        const first = r.head + (from + 1 - r.ring[r.head].q); // ring q's are consecutive
        for (let i = first; i < r.ring.length; i++) t.queue.push({ k: 'out', q: r.ring[i].q, d: r.ring[i].d });
      }
      r.taps.add(t);
      drain(t);
      return attachment;
    }

    r.taps.add(t);
    const box = r.box;
    if (!box) {
      t.queue.push({ k: 'snap', q: r.fedQ, cols: info.cols, rows: info.rows, d: '' });
      drain(t);
      return attachment;
    }
    t.pending = true;
    const snapQ = r.fedQ;
    box.inflight += 1;
    box.m.snapshot().catch(() => ({ cols: 0, rows: 0, d: '' })).then((res) => {
      box.inflight -= 1;
      if (box.retired && box.inflight === 0) box.m.dispose();
      if (t.dead || !t.pending || t.snapGen !== r.gen) return;
      t.pending = false;
      const ok = res.cols > 0;
      const now = r.slot.info();
      t.queue.push({ k: 'snap', q: snapQ, cols: ok ? res.cols : now.cols, rows: ok ? res.rows : now.rows, d: ok ? res.d : '' });
      for (const h of t.held) t.queue.push(h);
      t.held.length = 0;
      drain(t);
    });
    return attachment;
  }

  function retain(): () => void {
    retainCount += 1;
    if (retainCount === 1) {
      for (const r of reads.values()) {
        r.gen += 1;
        resetRing(r);
        r.box = newBox(r.slot.info());
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      retainCount -= 1;
      if (retainCount > 0) return;
      for (const r of reads.values()) {
        r.gen += 1;
        for (const t of [...r.taps]) kill(t);
        if (r.box) { r.box.retired = true; r.box.m.dispose(); r.box = null; }
        resetRing(r);
      }
    };
  }

  const port: TerminalReadPort = {
    list: () => [...slots.values()].map((s) => s.info()),
    attach,
    onState(cb) {
      stateListeners.add(cb);
      return () => { stateListeners.delete(cb); };
    },
    retain,
  };

  return { slot: (id) => slots.get(id) as TerminalSlot, readPort: () => port };
}
