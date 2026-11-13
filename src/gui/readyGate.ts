import { GUI_READY_CEILING_MS, GUI_READY_QUIET_MS } from '../../electron/gui/guiTypes';

export type ReadyReason = 'quiet' | 'ceiling';

export interface ReadyGateOptions {
  quietMs?: number;
  ceilingMs?: number;
  schedule: (fn: () => void, ms: number) => () => void;
  onReady: (reason: ReadyReason) => void;
}

export interface ReadyGate {
  /** Call once per PTY data chunk. */
  feed(): void;
  /** New session: clear timers and allow one more ready. */
  reset(): void;
  dispose(): void;
}

/**
 * Heuristic "claude is ready for input" gate. Never ready before the first
 * chunk; fires onReady at most once per session; a stream
 * that never goes quiet still becomes ready at ceilingMs after the first chunk.
 */
export function createReadyGate(o: ReadyGateOptions): ReadyGate {
  const quietMs = o.quietMs ?? GUI_READY_QUIET_MS;
  const ceilingMs = o.ceilingMs ?? GUI_READY_CEILING_MS;
  let fired = false;
  let sawChunk = false;
  let cancelQuiet: (() => void) | null = null;
  let cancelCeiling: (() => void) | null = null;

  const clear = (): void => {
    cancelQuiet?.();
    cancelCeiling?.();
    cancelQuiet = null;
    cancelCeiling = null;
  };
  const fire = (reason: ReadyReason): void => {
    if (fired) return;
    fired = true;
    clear();
    o.onReady(reason);
  };

  return {
    feed() {
      if (fired) return;
      cancelQuiet?.();
      cancelQuiet = o.schedule(() => fire('quiet'), quietMs);
      if (!sawChunk) {
        sawChunk = true;
        cancelCeiling = o.schedule(() => fire('ceiling'), ceilingMs);
      }
    },
    reset() {
      clear();
      fired = false;
      sawChunk = false;
    },
    dispose() {
      clear();
      fired = true;
    },
  };
}
