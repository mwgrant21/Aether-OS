// Headless screen model of one PTY stream. Pure: no I/O, no logging, and it never
// subscribes to the mirror's onData, so query replies cannot reach a PTY.
// write/resize/snapshot run in call order through one queue: writes are paced by the parse callback,
// and resize/snapshot wait until every earlier write has been parsed.
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

import {
  TERMINAL_MIRROR_SCROLLBACK_LINES, TERMINAL_SNAPSHOT_BYTES, TERMINAL_SNAPSHOT_SCROLLBACK_LINES,
} from '../src/shared/remote/types';

// Flow control: writes beyond this many UTF-16 units already handed to xterm wait in our own queue
// (xterm discards its backlog past about 50 MB); parse-completion callbacks release them in order.
const WRITE_HIGH_WATER = 1024 * 1024;

interface HeadlessTerm {
  cols: number;
  rows: number;
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
  buffer: { active: {
    type: string; viewportY: number; cursorX: number; cursorY: number;
    getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
  } };
}
interface SerializerLike {
  serialize(o?: { scrollback?: number }): string;
}

// Both packages are CJS/UMD: take the named export off the default import.
const { Terminal } = headlessPkg as unknown as { Terminal: new (o: Record<string, unknown>) => HeadlessTerm };
const { SerializeAddon } = serializePkg as unknown as { SerializeAddon: new () => SerializerLike };

/** cols 0 means "no snapshot" (mirror disposed or serialization failed): d is empty and the caller must not use it. */
export interface TerminalSnapshot { cols: number; rows: number; d: string }
export interface TerminalMirror {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  snapshot(): Promise<TerminalSnapshot>;
  dispose(): void;
  /** UTF-16 units written but not yet parsed (queued here plus in xterm); for load measurement. */
  pendingBytes(): number;
}

export function createTerminalMirror(opts: {
  cols: number;
  rows: number;
  scrollback?: number;
}): TerminalMirror {
  const term = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback ?? TERMINAL_MIRROR_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  let disposed = false;
  let inTerm = 0;   // handed to xterm, not yet parsed
  let queued = 0;   // waiting in our queue
  type Op =
    | { k: 'w'; data: string }
    | { k: 'r'; cols: number; rows: number }
    | { k: 's'; resolve: (s: TerminalSnapshot) => void };
  let queue: Op[] = [];
  let head = 0;
  let pumping = false;
  const NO_SNAPSHOT: TerminalSnapshot = { cols: 0, rows: 0, d: '' };

  const encodedLength = (s: string): number => JSON.stringify(s).length;

  // Lower the scrollback until the JSON-escaped length fits. If even scrollback 0 is over the
  // cap (the cap is a hard protocol limit), fall back to a plain-text viewport: visible rows
  // without colours plus a cursor-position escape, with whole rows dropped from the top if needed.
  // An alternate-screen terminal gets a \x1b[?1049h prefix (other DEC modes are not carried).
  // A pending-wrap cursor (cursorX == cols) lands on the last column. Dropping rows shifts
  // content up, so the client shows blank rows at the bottom.
  function serializeBounded(): string {
    let lines = TERMINAL_SNAPSHOT_SCROLLBACK_LINES;
    let d = serializer.serialize({ scrollback: lines });
    while (encodedLength(d) > TERMINAL_SNAPSHOT_BYTES && lines > 0) {
      lines = lines > 16 ? Math.floor(lines / 2) : 0;
      d = serializer.serialize({ scrollback: lines });
    }
    return encodedLength(d) > TERMINAL_SNAPSHOT_BYTES ? plainViewport() : d;
  }

  function plainViewport(): string {
    const b = term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < term.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    const prefix = b.type === 'alternate' ? '\x1b[?1049h' : '';
    let dropped = 0;
    const build = (): string => {
      const row = Math.max(0, b.cursorY - dropped);
      return `${prefix}${rows.slice(dropped).join('\r\n')}\x1b[${row + 1};${b.cursorX + 1}H`;
    };
    let d = build();
    while (encodedLength(d) > TERMINAL_SNAPSHOT_BYTES && dropped < rows.length) {
      dropped++;
      d = build();
    }
    return d;
  }

  function pump(): void {
    if (disposed || pumping) return;
    pumping = true;
    try {
      while (head < queue.length) {
        const op = queue[head];
        if (op.k === 'w') {
          if (inTerm >= WRITE_HIGH_WATER) break;
          head++;
          const n = op.data.length;
          queued -= n;
          inTerm += n;
          term.write(op.data, () => { inTerm -= n; pump(); });
        } else {
          if (inTerm > 0) break; // every earlier write must be parsed first
          head++;
          if (op.k === 'r') {
            term.resize(op.cols, op.rows);
          } else {
            let snap = NO_SNAPSHOT;
            try { snap = { cols: term.cols, rows: term.rows, d: serializeBounded() }; } catch { /* no snapshot */ }
            op.resolve(snap);
          }
        }
      }
      if (head > 1024 && head * 2 > queue.length) { queue = queue.slice(head); head = 0; }
    } finally {
      pumping = false;
    }
  }

  return {
    write(data) {
      if (disposed || data.length === 0) return;
      queued += data.length;
      queue.push({ k: 'w', data });
      pump();
    },
    resize(cols, rows) {
      if (disposed) return;
      queue.push({ k: 'r', cols, rows });
      pump();
    },
    snapshot() {
      if (disposed) return Promise.resolve(NO_SNAPSHOT);
      return new Promise<TerminalSnapshot>((resolve) => {
        queue.push({ k: 's', resolve });
        pump();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (let i = head; i < queue.length; i++) {
        const op = queue[i];
        if (op.k === 's') op.resolve(NO_SNAPSHOT);
      }
      queue = [];
      head = 0;
      term.dispose();
    },
    pendingBytes: () => queued + inTerm,
  };
}
