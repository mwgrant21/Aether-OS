import { PtyLifecycle, type PtyLike, type PtyLifecycleHandlers } from './ptyLifecycle';
import {
  TERMINAL_CHUNK_MAX_BYTES, TERMINAL_SLOTS,
  type TerminalInfo, type TerminalSlotId, type TerminalSlotState,
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
        handlers.onData(data); // renderer first
        for (const d of splitUtf8(data, TERMINAL_CHUNK_MAX_BYTES)) {
          this.q += 1;
          this.emit({ kind: 'out', q: this.q, d });
        }
      },
      onAlive: () => {
        this.state = 'running';
        this.q += 1;
        if (size && validDims(size.cols, size.rows)) { this.cols = size.cols; this.rows = size.rows; }
        else { this.cols = DEFAULT_COLS; this.rows = DEFAULT_ROWS; }
        this.emit({ kind: 'start', q: this.q, cols: this.cols, rows: this.rows });
        this.emit({ kind: 'state', state: 'running' });
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

export interface TerminalHub {
  slot(id: TerminalSlotId): TerminalSlot;
}

/** Owns the three PtyLifecycles (claude, terminal2, codex). */
export function createTerminalHub(): TerminalHub {
  const slots = new Map<TerminalSlotId, TerminalSlot>(TERMINAL_SLOTS.map(({ s }) => [s, new TerminalSlot(s)]));
  return { slot: (id) => slots.get(id) as TerminalSlot };
}
