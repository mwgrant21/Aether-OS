// Follows the pinned Claude session's transcript read-only (poll-tail) and serves ThreadEvents to
// thread-attached taps. Polls only while at least one tap is attached; the last detach stops the
// timer and drops the ring. Only fs.promises.open/stat/read touch the file; nothing is written,
// and neither the file path nor any transcript text appears in a log line.
import { promises as fsp } from 'node:fs';
import { parseThreadLine, turnMark } from './threadParser';
import {
  THREAD_SNAPSHOT_MAX_BYTES,
  THREAD_SNAPSHOT_MAX_EVENTS,
  THREAD_WORKING_STALE_MS,
  type ThreadEvent,
  type ThreadReadPort,
  type ThreadSlotId,
  type ThreadTap,
} from '../src/shared/remote/types';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const NL = 0x0a;

export interface ThreadFeedDeps {
  resolveSession: () => { sessionId: string; file: string } | null;
  now: () => number;
  pollMs?: number;
  seedBytes?: number;
  maxReadBytes?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: any) => void;
  log?: (line: string) => void;
}

// A replaced file (same path, new inode) must not be followed from the old offset.
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

export function createThreadFeed(deps: ThreadFeedDeps): ThreadReadPort {
  const pollMs = deps.pollMs ?? 1000;
  const seedBytes = deps.seedBytes ?? 512 * 1024;
  const maxReadBytes = deps.maxReadBytes ?? 1024 * 1024;
  const log = deps.log ?? (() => {});

  const taps = new Set<ThreadTap>();
  let timer: unknown = null;
  let inFlight = false;
  let epoch = 0;
  let q = 0; // feed-wide, +1 per emitted frame; a snap sent to a fresh attach carries it unchanged

  // Per-session follow state.
  let currentId: string | null = null;
  let attached = false;
  let ring: ThreadEvent[] = [];
  let offset = 0;
  let pending: Buffer = Buffer.alloc(0);
  let discarding = false;
  let unreadable = false;
  let identity: string | null = null;

  // Working derivation (spec D4, refined with stop_reason marks): busy = the last turn mark says a
  // turn is in progress; working = busy AND the transcript grew within THREAD_WORKING_STALE_MS.
  let busy = false;
  let streakAt: number | null = null;
  let lastGrowthMs = 0;
  let lastWorking = false;
  let lastSince: number | null = null;

  function workingNow(): { working: boolean; since: number | null } {
    const working = busy && deps.now() - lastGrowthMs <= THREAD_WORKING_STALE_MS;
    return { working, since: working ? (streakAt ?? lastGrowthMs) : null };
  }

  function resetState(): void {
    ring = [];
    offset = 0;
    pending = Buffer.alloc(0);
    discarding = false;
    busy = false;
    streakAt = null;
    lastGrowthMs = 0;
  }

  function snapshotEvents(): ThreadEvent[] {
    let evs = ring.slice(-THREAD_SNAPSHOT_MAX_EVENTS);
    let bytes = JSON.stringify(evs).length;
    while (evs.length > 1 && bytes > THREAD_SNAPSHOT_MAX_BYTES) {
      bytes -= JSON.stringify(evs[0]).length + 1;
      evs = evs.slice(1);
    }
    return evs;
  }

  function snapFrame() {
    const w = workingNow();
    return { q, attached, working: w.working, workingSinceMs: w.since, events: snapshotEvents() };
  }

  function stopIfIdle(): void {
    if (taps.size > 0) return;
    if (timer !== null) (deps.clearIntervalFn ?? clearInterval)(timer as any);
    timer = null;
    epoch++;
    resetState();
    currentId = null;
    attached = false;
    unreadable = false;
    identity = null;
    lastWorking = false;
    lastSince = null;
  }

  function broadcast(send: (t: ThreadTap) => void): void {
    for (const t of [...taps]) {
      try {
        send(t);
      } catch {
        taps.delete(t);
      }
    }
    stopIfIdle();
  }

  function emitSnap(): void {
    q++;
    const f = snapFrame();
    lastWorking = f.working;
    lastSince = f.workingSinceMs;
    broadcast((t) => t.snap(f));
  }

  function emitStateIfChanged(): void {
    if (taps.size === 0) return;
    const w = workingNow();
    if (w.working === lastWorking && w.since === lastSince) return;
    lastWorking = w.working;
    lastSince = w.since;
    q++;
    const f = { q, working: w.working, workingSinceMs: w.since };
    broadcast((t) => t.state(f));
  }

  // Splits chunk (starting at absolute byte chunkStart) into complete lines; parses each.
  function consume(chunk: Buffer, chunkStart: number): ThreadEvent[] {
    const out: ThreadEvent[] = [];
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const dataStart = chunkStart - pending.length;
    pending = Buffer.alloc(0);
    offset = chunkStart + chunk.length;
    let pos = 0;
    if (discarding) {
      const i = data.indexOf(NL);
      if (i < 0) return out;
      pos = i + 1;
      discarding = false;
    }
    for (;;) {
      const i = data.indexOf(NL, pos);
      if (i < 0) break;
      if (i > pos && i - pos <= MAX_LINE_BYTES) {
        const text = data.toString('utf8', pos, i);
        try {
          for (const e of parseThreadLine(text, dataStart + pos)) out.push(Object.freeze(e));
          const m = turnMark(text);
          if (m) {
            if (m.mark === 'busy') {
              if (!busy) streakAt = m.at > 0 ? m.at : deps.now();
              busy = true;
            } else {
              busy = false;
              streakAt = null;
            }
          }
        } catch {
          // one bad line never stops the feed
        }
      }
      pos = i + 1;
    }
    const rest = data.length - pos;
    if (rest > MAX_PENDING_BYTES) discarding = true;
    else if (rest > 0) pending = Buffer.from(data.subarray(pos));
    return out;
  }

  function pushRing(evs: ThreadEvent[]): void {
    ring.push(...evs);
    if (ring.length > THREAD_SNAPSHOT_MAX_EVENTS) ring = ring.slice(-THREAD_SNAPSHOT_MAX_EVENTS);
  }

  function noteUnreadable(): void {
    if (!unreadable) log('control: thread transcript unreadable');
    unreadable = true;
  }

  async function attachSession(s: { sessionId: string; file: string } | null, myEpoch: number): Promise<void> {
    let seed: Buffer = Buffer.alloc(0);
    let seedStart = 0;
    let newIdentity: string | null = null;
    let mtime = 0;
    if (s) {
      try {
        const st = await fsp.stat(s.file);
        newIdentity = fileIdentity(st);
        mtime = st.mtimeMs;
        seedStart = Math.max(0, st.size - seedBytes);
        seed = await readRange(s.file, seedStart, st.size - seedStart);
        unreadable = false;
      } catch {
        noteUnreadable();
        seed = Buffer.alloc(0);
        seedStart = 0;
      }
    }
    if (myEpoch !== epoch) return;
    // Synchronous commit: reset, seed, publish. An attach cannot interleave.
    resetState();
    currentId = s?.sessionId ?? null;
    identity = newIdentity;
    attached = s !== null;
    discarding = seedStart > 0;
    lastGrowthMs = mtime;
    pushRing(consume(seed, seedStart));
    emitSnap();
  }

  async function follow(s: { sessionId: string; file: string }, myEpoch: number): Promise<void> {
    let size: number;
    let ident: string;
    try {
      const st = await fsp.stat(s.file);
      size = st.size;
      ident = fileIdentity(st);
    } catch {
      noteUnreadable();
      return;
    }
    if (myEpoch !== epoch) return;
    if (identity !== null && ident !== identity) return attachSession(s, myEpoch); // replaced at the same path
    identity = ident;
    if (size < offset) return attachSession(s, myEpoch); // truncated
    if (size === offset) {
      unreadable = false;
      return;
    }
    const jump = size - offset > maxReadBytes;
    const start = jump ? size - maxReadBytes : offset;
    const end = jump ? size : Math.min(size, offset + maxReadBytes);
    let chunk: Buffer;
    try {
      chunk = await readRange(s.file, start, end - start);
    } catch {
      noteUnreadable();
      return;
    }
    if (myEpoch !== epoch) return;
    unreadable = false;
    if (jump) {
      pending = Buffer.alloc(0);
      discarding = true;
    }
    lastGrowthMs = deps.now();
    const evs = consume(chunk, start);
    if (evs.length > 0) {
      pushRing(evs);
      q++;
      const f = { q, events: evs };
      broadcast((t) => t.events(f));
    }
  }

  async function tick(): Promise<void> {
    if (inFlight || taps.size === 0) return;
    inFlight = true;
    const myEpoch = epoch;
    try {
      const s = deps.resolveSession();
      const id = s?.sessionId ?? null;
      if (id !== currentId) await attachSession(s, myEpoch);
      else if (s) await follow(s, myEpoch);
      if (myEpoch === epoch) emitStateIfChanged();
    } catch {
      noteUnreadable();
    } finally {
      inFlight = false;
    }
  }

  return {
    attach(_s: ThreadSlotId, tap: ThreadTap) {
      // Deliver the snapshot BEFORE registering: a tap whose snap throws (dead socket) must not
      // leak into the set, start the timer, or keep the feed alive.
      try {
        tap.snap(snapFrame());
      } catch {
        return { detach() {} };
      }
      taps.add(tap);
      if (timer === null) {
        void tick();
        timer = (deps.setIntervalFn ?? setInterval)(() => void tick(), pollMs);
        (timer as { unref?: () => void } | null)?.unref?.();
      }
      return {
        detach() {
          if (taps.delete(tap)) stopIfIdle();
        },
      };
    },
  };
}
