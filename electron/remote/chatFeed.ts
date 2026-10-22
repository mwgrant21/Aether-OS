// Follows the pinned Claude session's transcript read-only (poll-tail), fills the replay buffer
// from the last seedBytes at attach, and lets phones join with session + history followed by
// live events. Only fs.promises.open/stat/read touch the file; nothing is written or persisted,
// and the file path never appears in a message or log line. Every ChatEvent comes from
// parseChatLine (masked) and is frozen before it enters the buffer.
import { promises as fsp } from 'node:fs';
import { parseChatLine, type ChatParseContext } from './chatParser';
import { createReplayBuffer, type ReplayBuffer } from './replayBuffer';
import { titleFromHead } from '../board/boardFeed';
import type { ChatEvent, ChatFeed, ServerMessage } from './types';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const NL = 0x0a;

export interface ChatFeedDeps {
  resolveSession: () => { sessionId: string; file: string } | null;
  readTitle?: (file: string) => Promise<string | null>;
  pollMs?: number;
  seedBytes?: number;
  maxReadBytes?: number;
  buffer?: ReplayBuffer;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: any) => void;
  log?: (line: string) => void;
}

function freezeEvent(e: ChatEvent): ChatEvent {
  if (e.k === 'msg') Object.freeze(e.tools);
  return Object.freeze(e);
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

export function createChatFeed(deps: ChatFeedDeps): ChatFeed & { start(): void; stop(): void } {
  const pollMs = deps.pollMs ?? 1000;
  const seedBytes = deps.seedBytes ?? 512 * 1024;
  const maxReadBytes = deps.maxReadBytes ?? 1024 * 1024;
  const buffer = deps.buffer ?? createReplayBuffer();
  const readTitle = deps.readTitle ?? ((f: string) => titleFromHead(f).catch(() => null));
  const log = deps.log ?? (() => {});

  const listeners = new Set<(m: ServerMessage) => void>();
  let timer: unknown = null;
  let inFlight = false;
  let epoch = 0;
  let running = false;

  // Per-session follow state.
  let currentId: string | null = null;
  let attached = false;
  let title: string | null = null;
  let ctx: ChatParseContext = { dispatchIds: new Set() };
  let offset = 0; // absolute byte position of the next unread byte
  let pending: Buffer = Buffer.alloc(0); // unterminated tail, contiguous before `offset`
  let discarding = false; // drop bytes up to the next newline (we are mid-line)
  let unreadable = false;

  function broadcast(m: ServerMessage): void {
    for (const l of [...listeners]) {
      try {
        l(m);
      } catch {
        listeners.delete(l);
      }
    }
  }

  function resetState(): void {
    buffer.clear();
    ctx = { dispatchIds: new Set() };
    offset = 0;
    pending = Buffer.alloc(0);
    discarding = false;
  }

  // Splits chunk (which starts at absolute byte chunkStart) into complete lines and parses each.
  function consume(chunk: Buffer, chunkStart: number, emit: (e: ChatEvent) => void): void {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const dataStart = chunkStart - pending.length;
    pending = Buffer.alloc(0);
    offset = chunkStart + chunk.length;
    let pos = 0;
    if (discarding) {
      const i = data.indexOf(NL);
      if (i < 0) return;
      pos = i + 1;
      discarding = false;
    }
    for (;;) {
      const i = data.indexOf(NL, pos);
      if (i < 0) break;
      if (i > pos && i - pos <= MAX_LINE_BYTES) {
        try {
          for (const e of parseChatLine(data.toString('utf8', pos, i), dataStart + pos, ctx)) emit(freezeEvent(e));
        } catch {
          // one bad line never stops the feed
        }
      }
      pos = i + 1;
    }
    const rest = data.length - pos;
    if (rest > MAX_PENDING_BYTES) discarding = true;
    else if (rest > 0) pending = Buffer.from(data.subarray(pos));
  }

  function noteUnreadable(): void {
    if (!unreadable) log('remote: transcript unreadable');
    unreadable = true;
  }

  async function attach(s: { sessionId: string; file: string } | null, myEpoch: number): Promise<void> {
    let seed: Buffer = Buffer.alloc(0);
    let seedStart = 0;
    let newTitle: string | null = null;
    if (s) {
      try {
        const size = (await fsp.stat(s.file)).size;
        seedStart = Math.max(0, size - seedBytes);
        seed = await readRange(s.file, seedStart, size - seedStart);
        unreadable = false;
      } catch {
        noteUnreadable();
        seed = Buffer.alloc(0);
        seedStart = 0;
      }
      newTitle = await Promise.resolve(readTitle(s.file)).catch(() => null);
    }
    if (myEpoch !== epoch) return;
    // Synchronous commit: reset, seed, publish. A join cannot interleave.
    resetState();
    currentId = s?.sessionId ?? null;
    attached = s !== null;
    title = newTitle;
    discarding = seedStart > 0;
    consume(seed, seedStart, (e) => buffer.push(e));
    broadcast({ t: 'session', attached, title });
    broadcast({ t: 'history', events: buffer.snapshot() });
  }

  async function follow(s: { sessionId: string; file: string }, myEpoch: number): Promise<void> {
    let size: number;
    try {
      size = (await fsp.stat(s.file)).size;
    } catch {
      noteUnreadable();
      return;
    }
    if (myEpoch !== epoch) return;
    if (size < offset) return attach(s, myEpoch); // truncated or replaced
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
    let newTitle: string | null = null;
    if (title === null && chunk.length > 0) newTitle = await Promise.resolve(readTitle(s.file)).catch(() => null);
    if (myEpoch !== epoch) return;
    unreadable = false;
    if (jump) {
      pending = Buffer.alloc(0);
      discarding = true;
    }
    consume(chunk, start, (e) => {
      buffer.push(e);
      broadcast({ t: 'event', event: e });
    });
    if (newTitle !== null && title === null) {
      title = newTitle;
      broadcast({ t: 'session', attached, title });
    }
  }

  async function tick(): Promise<void> {
    if (inFlight || !running) return;
    inFlight = true;
    const myEpoch = epoch;
    try {
      const s = deps.resolveSession();
      const id = s?.sessionId ?? null;
      if (id !== currentId) await attach(s, myEpoch);
      else if (s) await follow(s, myEpoch);
    } catch {
      noteUnreadable();
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      running = true;
      void tick();
      timer = (deps.setIntervalFn ?? setInterval)(() => void tick(), pollMs);
      (timer as { unref?: () => void } | null)?.unref?.();
    },
    stop() {
      if (timer !== null) (deps.clearIntervalFn ?? clearInterval)(timer as any);
      timer = null;
      running = false;
      epoch++;
      listeners.clear();
      resetState();
      currentId = null;
      attached = false;
      title = null;
      unreadable = false;
    },
    join(listener) {
      try {
        listener({ t: 'session', attached, title });
        listener({ t: 'history', events: buffer.snapshot() });
      } catch {
        return { leave() {} };
      }
      listeners.add(listener);
      return {
        leave() {
          listeners.delete(listener);
        },
      };
    },
  };
}
