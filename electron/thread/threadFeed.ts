// Follows ONE slot's Claude transcript read-only (poll-tail) and fans thread entries out to attached phones
// (V3-A3 T4, spec 4.1/4.4/4.6). Only fs.promises.open/stat and the handle's read/close touch the file; nothing is
// written, the path never reaches a frame or log line, and the only log line is the fixed
// `thread: transcript unreadable slot=<id>` (once per outage). Every entry comes from parseThreadLine (redacted).
//
// Lifetime: the first attach starts the timer, the last detach (or stop()) clears the timer and frees every buffer.
// Atomicity: all state mutation and tap delivery happens in synchronous commit sections (reseed commit, consume).
// attach() builds its snapshot from that state in the same synchronous step that registers the tap, so a phone sees
// each event exactly once: either inside its snapshot or as a later add/upd with q + 1.
//
// Wire hygiene: the phone hard-rejects a bad frame and a rejected frame kills the link, so every integer field is
// rounded to a whole number before it leaves, and the entries array is kept within THREAD_HISTORY_ENTRIES and
// THREAD_SNAPSHOT_BYTES (UTF-8 bytes of its JSON, which is never below the UTF-16 length) by dropping the oldest.
import { promises as fsp } from 'node:fs';
import {
  THREAD_DETAIL_STORE_BYTES,
  THREAD_HISTORY_ENTRIES,
  THREAD_PERM_CLEAR_MS,
  THREAD_POLL_MS,
  THREAD_QUIET_MS,
  THREAD_SNAPSHOT_BYTES,
  type ThreadAttachment,
  type ThreadDetail,
  type ThreadEntry,
  type ThreadMeta,
  type ThreadSlotId,
  type ThreadSnapshot,
  type ThreadTap,
  type ThreadWhy,
} from '../../src/shared/remote/threadTypes';
import { createParseCtx, parseThreadLine, type ThreadOp, type ThreadParseCtx } from './threadParser';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const NL = 0x0a;
const PERM_TYPES: ReadonlySet<string> = new Set(['permission_prompt', 'agent_needs_input']);
const NO_QUIET_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'SendMessage']);

export interface ThreadFeedDeps {
  slot: ThreadSlotId;
  resolve: () => { sessionId: string; file: string } | null;
  statuslineCtx?: () => { pct: number } | null;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: any) => void;
  log?: (line: string) => void;
  pollMs?: number;
  seedBytes?: number;
  maxReadBytes?: number;
}

export interface ThreadFeed {
  attach(tap: ThreadTap): ThreadAttachment;
  detail(id: string): ThreadDetail | null;
  noteNotification(sessionId: string, type: string): void;
  /** One poll. The timer calls it; it is public so a test can drive it deterministically. */
  tick(): Promise<void>;
  stop(): void;
}

type Status = 'none' | 'starting' | 'ok' | 'unreadable';

const NOOP_ATTACHMENT: ThreadAttachment = { detach() {} };

/** Whole non-negative number or null. Fractional (fs mtimeMs) is rounded; NaN/Infinity/non-number is null. */
function whole(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

// A replaced file (same path, new inode) must not be followed from the old offset. dev+ino identify it;
// birthtime covers filesystems that report ino 0.
function fileIdentity(st: { dev: number; ino: number; birthtimeMs: number }): string {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}`;
}

async function readRange(file: string, start: number, length: number): Promise<Buffer> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

/** Every integer field of an entry as a whole number; the parser already does this, this is the wire guard. */
function wireEntry(e: ThreadEntry): ThreadEntry {
  const ts = whole(e.ts) ?? 0;
  if (e.k === 't') return { ...e, ts, sz: e.sz === null ? null : whole(e.sz) ?? 0, ...(e.dn === undefined ? {} : { dn: whole(e.dn) ?? 0 }) };
  if (e.k === 'th') return { ...e, ts, ms: e.ms === null ? null : whole(e.ms) };
  return { ...e, ts };
}

const sizeOf = (e: ThreadEntry): number => Buffer.byteLength(JSON.stringify(e), 'utf8');

const EMPTY_META: ThreadMeta = { ctxTok: null, ctxPct: null, work: 'unknown', since: null, tok: null, last: null, wait: null };

export function createThreadFeed(deps: ThreadFeedDeps): ThreadFeed {
  const slot = deps.slot;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const pollMs = deps.pollMs ?? THREAD_POLL_MS;
  const seedBytes = deps.seedBytes ?? 512 * 1024;
  const maxReadBytes = deps.maxReadBytes ?? 1024 * 1024;

  const taps = new Set<ThreadTap>();
  let timer: unknown = null;
  let running = false;
  let inFlight: Promise<void> | null = null;
  let epoch = 0;

  let status: Status = 'none';
  let currentId: string | null = null;
  let q = 0;
  let items: { e: ThreadEntry; size: number }[] = [];
  let itemBytes = 0;
  let ctx: ThreadParseCtx = createParseCtx();
  let offset = 0; // absolute byte position of the next unread byte
  let pending: Buffer = Buffer.alloc(0); // unterminated tail, contiguous before `offset`
  let discarding = false; // drop bytes up to the next newline (we are mid-line)
  let identity: string | null = null;
  let mtime: number | null = null;

  // Meta inputs.
  let ctxTok: number | null = null;
  let tokSincePrompt = 0;
  let promptTs: number | null = null;
  let endTurn: boolean | null = null; // null = no assistant/user line seen yet
  let lastTs: number | null = null;
  let lastUsageSig: string | null = null;
  let lastGrowAt = 0;
  let permAt: number | null = null;
  const runSeenAt = new Map<string, number>();
  let lastMetaJson: string | null = null;
  let lastMetaAt = 0;

  // Detail store: insertion order is LRU order (oldest first); bounded by THREAD_DETAIL_STORE_BYTES.
  const details = new Map<string, { d: ThreadDetail; bytes: number }>();
  let detailBytes = 0;

  function storeDetail(id: string, d: ThreadDetail): void {
    const prev = details.get(id);
    if (prev) {
      detailBytes -= prev.bytes;
      details.delete(id);
    }
    const bytes = Buffer.byteLength(d.input ?? '', 'utf8') + Buffer.byteLength(d.x ?? '', 'utf8') + 64;
    details.set(id, { d, bytes });
    detailBytes += bytes;
    while (detailBytes > THREAD_DETAIL_STORE_BYTES && details.size > 1) {
      const oldest = details.keys().next().value;
      if (oldest === undefined) break;
      detailBytes -= details.get(oldest)?.bytes ?? 0;
      details.delete(oldest);
    }
  }

  function clearState(): void {
    items = [];
    itemBytes = 0;
    ctx = createParseCtx();
    offset = 0;
    pending = Buffer.alloc(0);
    discarding = false;
    identity = null;
    mtime = null;
    details.clear();
    detailBytes = 0;
    runSeenAt.clear();
    ctxTok = null;
    tokSincePrompt = 0;
    promptTs = null;
    endTurn = null;
    lastTs = null;
    lastUsageSig = null;
    permAt = null;
  }

  function entriesBytes(): number {
    return items.length === 0 ? 2 : itemBytes + (items.length - 1) + 2;
  }

  function trim(): void {
    while (items.length > 0 && (items.length > THREAD_HISTORY_ENTRIES || (items.length > 1 && entriesBytes() > THREAD_SNAPSHOT_BYTES))) {
      const first = items.shift();
      if (first) itemBytes -= first.size;
    }
  }

  function buildMeta(): ThreadMeta {
    if (status !== 'ok') return EMPTY_META;
    const t = now();
    if (permAt !== null && t - permAt >= THREAD_PERM_CLEAR_MS) permAt = null;
    let wait: ThreadMeta['wait'] = null;
    if (permAt !== null) wait = 'perm';
    else if (t - lastGrowAt >= THREAD_QUIET_MS) {
      for (const it of items) {
        const e = it.e;
        if (e.k !== 't' || e.st !== 'run' || NO_QUIET_TOOLS.has(e.n)) continue;
        if (t - (runSeenAt.get(e.id) ?? t) >= THREAD_QUIET_MS) {
          wait = 'quiet';
          break;
        }
      }
    }
    const pct = deps.statuslineCtx?.()?.pct;
    return {
      ctxTok,
      ctxPct: typeof pct === 'number' && Number.isFinite(pct) ? pct : null,
      work: endTurn === null ? 'unknown' : endTurn ? 'idle' : 'working',
      since: promptTs !== null && promptTs > 0 ? promptTs : null,
      tok: promptTs !== null ? tokSincePrompt : null,
      last: lastTs !== null && lastTs > 0 ? lastTs : mtime,
      wait,
    };
  }

  function buildSnap(): ThreadSnapshot {
    if (status === 'ok') return { q, avail: true, why: null, entries: items.map((i) => i.e), m: buildMeta() };
    const why: ThreadWhy = status === 'unreadable' ? 'unreadable' : status === 'starting' ? 'starting' : 'no-session';
    return { q, avail: false, why, entries: [], m: EMPTY_META };
  }

  function each(fn: (t: ThreadTap) => void): void {
    for (const t of [...taps]) {
      try {
        fn(t);
      } catch {
        taps.delete(t);
      }
    }
    if (taps.size === 0 && running) stopInternal();
  }

  function publishSnap(): void {
    q += 1;
    const s = buildSnap();
    lastMetaJson = JSON.stringify(s.m);
    lastMetaAt = now();
    each((t) => t.snap(s));
  }

  function flushMeta(): void {
    if (status !== 'ok' || taps.size === 0) return;
    const m = buildMeta();
    const j = JSON.stringify(m);
    if (j === lastMetaJson || now() - lastMetaAt < 1000) return;
    lastMetaJson = j;
    lastMetaAt = now();
    each((t) => t.meta(m));
  }

  function pushItem(incoming: ThreadEntry): ThreadEntry {
    const e = wireEntry(incoming);
    const size = sizeOf(e);
    items.push({ e, size });
    itemBytes += size;
    trim();
    return e;
  }

  function apply(op: ThreadOp, live: boolean): void {
    if (op.op === 'add') {
      const e = pushItem(op.e);
      if (e.k === 't' && e.st === 'run') runSeenAt.set(e.id, now());
      if (op.detail) storeDetail(e.id, op.detail);
      if (e.ts > 0) lastTs = Math.max(lastTs ?? 0, e.ts);
      if (live) {
        q += 1;
        const qq = q;
        each((t) => t.add(qq, e));
      }
    } else if (op.op === 'upd') {
      lastUsageSig = null;
      endTurn = false; // a tool result arrived: the turn continues
      const e = wireEntry(op.e);
      runSeenAt.delete(e.id);
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]?.e.id === e.id) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return; // its row is outside the window: the phone has no such id
      if (op.detail) storeDetail(e.id, op.detail);
      const size = sizeOf(e);
      itemBytes += size - (items[idx]?.size ?? 0);
      items[idx] = { e, size };
      trim();
      if (live) {
        q += 1;
        const qq = q;
        each((t) => t.upd(qq, e));
      }
    } else if (op.op === 'prompt') {
      lastUsageSig = null;
      endTurn = false;
      promptTs = whole(op.ts) ?? 0;
      tokSincePrompt = 0;
      if (op.ts > 0) lastTs = Math.max(lastTs ?? 0, whole(op.ts) ?? 0);
    } else {
      // Lines of one assistant message repeat the same usage; count a repeat once.
      const sig = `${op.ctxTok}:${op.outTok}`;
      ctxTok = whole(op.ctxTok);
      endTurn = op.endTurn;
      if (sig !== lastUsageSig) tokSincePrompt += whole(op.outTok) ?? 0;
      lastUsageSig = sig;
      if (op.ts > 0) lastTs = Math.max(lastTs ?? 0, whole(op.ts) ?? 0);
    }
  }

  // Splits chunk (which starts at absolute byte chunkStart) into complete lines and parses each.
  function consume(chunk: Buffer, chunkStart: number, live: boolean): number {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const dataStart = chunkStart - pending.length;
    pending = Buffer.alloc(0);
    offset = chunkStart + chunk.length;
    let pos = 0;
    let lines = 0;
    if (discarding) {
      const i = data.indexOf(NL);
      if (i < 0) return 0;
      pos = i + 1;
      discarding = false;
    }
    for (;;) {
      const i = data.indexOf(NL, pos);
      if (i < 0) break;
      lines += 1;
      if (i > pos && i - pos <= MAX_LINE_BYTES) {
        try {
          for (const op of parseThreadLine(data.toString('utf8', pos, i), dataStart + pos, ctx)) apply(op, live);
        } catch {
          // one bad line never stops the feed
        }
      }
      pos = i + 1;
    }
    const rest = data.length - pos;
    if (rest > MAX_PENDING_BYTES) discarding = true;
    else if (rest > 0) pending = Buffer.from(data.subarray(pos));
    return lines;
  }

  function fail(err: unknown, sessionId: string | null): void {
    const code = (err as { code?: string } | null)?.code;
    const next: Status = code === 'ENOENT' ? 'starting' : 'unreadable';
    currentId = sessionId;
    if (status === next) return;
    if (next === 'unreadable') log(`thread: transcript unreadable slot=${slot}`);
    clearState();
    status = next;
    publishSnap();
  }

  function toNone(): void {
    if (status === 'none') return;
    clearState();
    currentId = null;
    status = 'none';
    publishSnap();
  }

  async function reseed(s: { sessionId: string; file: string }, myEpoch: number): Promise<void> {
    let seed: Buffer;
    let seedStart: number;
    let ident: string;
    let mt: number;
    try {
      const st = await fsp.stat(s.file);
      ident = fileIdentity(st);
      mt = whole(st.mtimeMs) ?? 0;
      seedStart = Math.max(0, st.size - seedBytes);
      seed = await readRange(s.file, seedStart, st.size - seedStart);
    } catch (err) {
      if (myEpoch === epoch) fail(err, s.sessionId);
      return;
    }
    if (myEpoch !== epoch) return;
    // Synchronous commit: reset, seed, publish. An attach cannot interleave.
    clearState();
    currentId = s.sessionId;
    identity = ident;
    mtime = mt;
    discarding = seedStart > 0;
    lastGrowAt = now();
    consume(seed, seedStart, false);
    status = 'ok';
    publishSnap();
  }

  async function follow(s: { sessionId: string; file: string }, myEpoch: number): Promise<void> {
    let size: number;
    let ident: string;
    let mt: number;
    try {
      const st = await fsp.stat(s.file);
      size = st.size;
      ident = fileIdentity(st);
      mt = whole(st.mtimeMs) ?? 0;
    } catch (err) {
      if (myEpoch === epoch) fail(err, s.sessionId);
      return;
    }
    if (myEpoch !== epoch) return;
    if (ident !== identity || size < offset || size - offset > maxReadBytes) return reseed(s, myEpoch); // replaced, truncated, or too far behind to follow without a gap
    if (size === offset) return;
    let chunk: Buffer;
    try {
      chunk = await readRange(s.file, offset, size - offset);
    } catch (err) {
      if (myEpoch === epoch) fail(err, s.sessionId);
      return;
    }
    if (myEpoch !== epoch) return;
    mtime = mt;
    lastGrowAt = now();
    if (consume(chunk, offset, true) > 0) permAt = null;
  }

  function tick(): Promise<void> {
    if (!running) return Promise.resolve();
    if (inFlight) return inFlight; // a poll is already running: join it, never overlap
    const myEpoch = epoch;
    const p = poll(myEpoch).finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  }

  async function poll(myEpoch: number): Promise<void> {
    try {
      const s = deps.resolve();
      if (!s) toNone();
      else if (s.sessionId !== currentId || status !== 'ok') await reseed(s, myEpoch);
      else await follow(s, myEpoch);
      if (myEpoch === epoch) flushMeta();
    } catch {
      // never throw out of the timer
    }
  }

  function stopInternal(): void {
    if (timer !== null) (deps.clearIntervalFn ?? clearInterval)(timer as any);
    timer = null;
    running = false;
    epoch += 1;
    taps.clear();
    clearState();
    status = 'none';
    currentId = null;
    q = 0;
    lastMetaJson = null;
    lastMetaAt = 0;
    inFlight = null;
  }

  return {
    attach(tap) {
      if (!running) {
        running = true;
        // First phone: nothing is read until now. Resolve synchronously so the first snapshot can say why it is empty.
        status = deps.resolve() ? 'starting' : 'none';
        timer = (deps.setIntervalFn ?? setInterval)(() => void tick(), pollMs);
        (timer as { unref?: () => void } | null)?.unref?.();
        void tick();
      }
      try {
        tap.snap(buildSnap());
      } catch {
        if (taps.size === 0) stopInternal();
        return NOOP_ATTACHMENT;
      }
      taps.add(tap);
      return {
        detach() {
          if (taps.delete(tap) && taps.size === 0) stopInternal();
        },
      };
    },
    detail(id) {
      const hit = details.get(id);
      if (!hit) return null;
      details.delete(id);
      details.set(id, hit); // most recently used
      return hit.d;
    },
    noteNotification(sessionId, type) {
      if (!running || status !== 'ok' || !PERM_TYPES.has(type)) return;
      if (currentId === sessionId) permAt = now();
    },
    tick,
    stop: stopInternal,
  };
}
