// Keeps xterm decorations in sync with status markers ([STOP] [WARN] [MANUAL] [ASK]) in a terminal
// buffer. Shared by all three terminals. It only reads the buffer; it never touches the pty stream.
// Decorations are row-bound, so every flush reconciles: stale ones (a row Ink redrew) are disposed
// and missing ones registered, keyed by line:kind:part:x:width.
// Limitation: only the last SCAN_ROWS absolute rows are scanned, and fence state starts false at
// the first scanned row, so a ``` fence opened more than SCAN_ROWS rows above the end is not seen.
// Rows that scrolled out of the window keep their decorations.
import {
  MARKER_STYLE, readLineText, scanMarkerLines,
  type BufferLike, type LineText, type MarkerKind, type MarkerSpan,
} from '../../shared/terminalMarkers';

export const SCAN_ROWS = 300;

interface Disposable { dispose(): void }
interface MarkerLike extends Disposable { readonly line: number; readonly isDisposed: boolean }
interface DecorationLike extends Disposable { readonly isDisposed?: boolean }
interface DecorationOptions {
  marker: MarkerLike;
  x: number;
  width: number;
  foregroundColor?: string;
  backgroundColor?: string;
  layer?: 'bottom' | 'top';
}

/** Structural subset of xterm's Terminal, so tests need no renderer. */
export interface MarkerTerm {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: BufferLike & {
    readonly type: string; readonly baseY: number; readonly cursorY: number; readonly length: number;
  } };
  registerMarker(cursorYOffset?: number): MarkerLike | undefined;
  registerDecoration(options: DecorationOptions): DecorationLike | undefined;
  onWriteParsed(cb: () => void): Disposable;
  onResize(cb: () => void): Disposable;
  onScroll(cb: () => void): Disposable;
  onBufferChange(cb: () => void): Disposable;
}

export interface TerminalMarkers {
  setEnabled(on: boolean): void;
  flush(): void;
  dispose(): void;
}

/** tail is the key minus its line prefix: kind:part:x:width. */
interface Entry { marker: MarkerLike; deco: DecorationLike; tail: string }

const keyOf = (line: number, s: Pick<MarkerSpan, 'kind' | 'part' | 'x' | 'width'>): string =>
  `${line}:${s.kind}:${s.part}:${s.x}:${s.width}`;

export function attachTerminalMarkers(term: MarkerTerm): TerminalMarkers {
  let enabled = false;
  let disposed = false;
  let frame: { cancel(): void } | null = null;
  const live = new Map<string, Entry>();
  // Keys registerDecoration refused (it returns undefined); skipped so a refusal is not retried every frame.
  let refused = new Set<string>();

  const release = (e: Entry): void => {
    e.deco.dispose();
    e.marker.dispose();
  };
  const disposeAll = (): void => {
    for (const e of live.values()) release(e);
    live.clear();
    refused = new Set();
  };

  const flush = (): void => {
    if (disposed) return;
    if (!enabled) { disposeAll(); return; }
    const buf = term.buffer.active;
    const start = Math.max(0, buf.length - SCAN_ROWS);
    const lines: LineText[] = [];
    for (let y = start; y < buf.length; y++) lines.push(readLineText(buf, y, term.cols));
    const wanted = new Map<string, MarkerSpan>();
    for (const s of scanMarkerLines(lines)) wanted.set(keyOf(start + s.row, s), s);

    // Re-key survivors by their live line; drop entries whose marker died.
    const current = new Map<string, Entry>();
    for (const e of live.values()) {
      if (e.marker.isDisposed) { e.deco.dispose(); continue; }
      current.set(`${e.marker.line}:${e.tail}`, e);
    }
    live.clear();
    for (const [k, e] of current) {
      const line = e.marker.line;
      if (line >= start && !wanted.has(k)) release(e);
      else live.set(k, e);
    }
    refused = new Set([...refused].filter((k) => wanted.has(k)));

    const cursorAbs = buf.baseY + buf.cursorY;
    for (const [k, s] of wanted) {
      if (live.has(k) || refused.has(k)) continue;
      const marker = term.registerMarker(start + s.row - cursorAbs);
      if (!marker) continue;
      const style = MARKER_STYLE[s.kind as MarkerKind];
      const deco = term.registerDecoration({
        marker, x: s.x, width: s.width, layer: 'bottom',
        ...(s.part === 'chip'
          ? { backgroundColor: style.color, foregroundColor: style.chipText }
          : { foregroundColor: style.color }),
      });
      if (!deco) { marker.dispose(); refused.add(k); continue; }
      const entry: Entry = { marker, deco, tail: k.slice(k.indexOf(':') + 1) };
      live.set(k, entry);
    }
  };

  const schedule = (): void => {
    if (!enabled || disposed || frame) return;
    const run = (): void => { frame = null; flush(); };
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(run);
      frame = { cancel: () => cancelAnimationFrame(id) };
    } else {
      const id = setTimeout(run, 16);
      frame = { cancel: () => clearTimeout(id) };
    }
  };

  const subs: Disposable[] = [
    term.onWriteParsed(schedule),
    term.onResize(schedule),
    term.onScroll(schedule),
    term.onBufferChange(() => { disposeAll(); schedule(); }),
  ];

  return {
    setEnabled(on) {
      if (disposed || on === enabled) return;
      enabled = on;
      if (on) schedule();
      else { frame?.cancel(); frame = null; flush(); }
    },
    flush,
    dispose() {
      if (disposed) return;
      frame?.cancel();
      frame = null;
      disposeAll();
      disposed = true;
      for (const s of subs) s.dispose();
    },
  };
}
