// Headless screen model of one PTY stream. Pure: no I/O, no logging, and it never
// subscribes to the mirror's onData, so query replies cannot reach a PTY.
// write/resize/snapshot run in call order: resize and snapshot are queued behind earlier
// writes with term.write('', cb), whose callback fires after every earlier chunk is parsed.
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

// Mirrors section 2.1 of the V2 spec (src/shared/remote/types.ts, added by T1);
// T4 should import these from types.ts and drop the local copies.
export const TERMINAL_SNAPSHOT_BYTES = 256 * 1024;
export const TERMINAL_SNAPSHOT_SCROLLBACK_LINES = 1000;
export const TERMINAL_MIRROR_SCROLLBACK_LINES = 2000;

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

export interface TerminalSnapshot { cols: number; rows: number; d: string }
export interface TerminalMirror {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  snapshot(): Promise<TerminalSnapshot>;
  dispose(): void;
  /** UTF-16 units written but not yet parsed; for load measurement. */
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
  let pending = 0;
  const waiting = new Set<() => void>();

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

  return {
    write(data) {
      if (disposed || data.length === 0) return;
      pending += data.length;
      term.write(data, () => { pending -= data.length; });
    },
    resize(cols, rows) {
      if (disposed) return;
      term.write('', () => { if (!disposed) term.resize(cols, rows); });
    },
    snapshot() {
      if (disposed) return Promise.resolve({ cols: 0, rows: 0, d: '' });
      return new Promise<TerminalSnapshot>((resolve) => {
        const empty = (): void => resolve({ cols: 0, rows: 0, d: '' });
        waiting.add(empty);
        term.write('', () => {
          waiting.delete(empty);
          if (disposed) return empty();
          resolve({ cols: term.cols, rows: term.rows, d: serializeBounded() });
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const w of waiting) w();
      waiting.clear();
      term.dispose();
    },
    pendingBytes: () => pending,
  };
}
