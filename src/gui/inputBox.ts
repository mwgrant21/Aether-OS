import { GUI_READY_CEILING_MS } from '../../electron/gui/guiTypes';

/** Rows scanned from the bottom of the screen (non-empty rows only). */
export const GUI_INPUT_BOX_SCAN_ROWS = 12;

const RULE_ROW = /^\s*\u2500{20,}\s*$/u;
const INPUT_ROW = /^\s*[\u276f>](?:\s|$)/u;

/**
 * True when the last GUI_INPUT_BOX_SCAN_ROWS non-empty screen rows hold Claude's
 * input box: a rule row, an input row, then (after at most 2 wrapped input rows)
 * a closing rule row. Means "the box has been drawn", not "Claude is idle".
 */
export function claudeInputReady(text: string): boolean {
  const rows = text
    .split('\n')
    .filter((r) => r.trim() !== '')
    .slice(-GUI_INPUT_BOX_SCAN_ROWS);
  for (let i = 0; i + 2 < rows.length; i++) {
    if (!RULE_ROW.test(rows[i]) || !INPUT_ROW.test(rows[i + 1])) continue;
    for (let j = i + 2; j <= i + 4 && j < rows.length; j++) {
      if (RULE_ROW.test(rows[j])) return true;
    }
  }
  return false;
}

/** Poll cadence for the input-box gate (same value as the trust watcher). */
export const GUI_INPUT_BOX_POLL_MS = 250;

export type InputBoxReason = 'box' | 'ceiling';

export interface InputBoxGateOptions {
  schedule: (fn: () => void, ms: number) => () => void;
  readScreen: () => string;
  onVisible: (reason: InputBoxReason) => void;
  pollMs?: number;
  ceilingMs?: number;
}

export interface InputBoxGate {
  /** Call once per PTY data chunk. */
  feed(): void;
  /** New start: clear timers and allow one more fire. */
  reset(): void;
  dispose(): void;
}

/**
 * Fires onVisible('box') once the input box has been on screen for two
 * consecutive polls, or onVisible('ceiling') ceilingMs after the first chunk,
 * whichever comes first; at most once per start. Nothing is read before the
 * first chunk. Polls re-arm themselves, bounded by the ceiling.
 */
export function createInputBoxGate(o: InputBoxGateOptions): InputBoxGate {
  const pollMs = o.pollMs ?? GUI_INPUT_BOX_POLL_MS;
  const ceilingMs = o.ceilingMs ?? GUI_READY_CEILING_MS;
  let fired = false;
  let started = false;
  let streak = 0;
  let cancelPoll: (() => void) | null = null;
  let cancelCeiling: (() => void) | null = null;

  const clear = (): void => {
    cancelPoll?.();
    cancelCeiling?.();
    cancelPoll = null;
    cancelCeiling = null;
  };
  const fire = (reason: InputBoxReason): void => {
    if (fired) return;
    fired = true;
    clear();
    o.onVisible(reason);
  };
  const poll = (): void => {
    cancelPoll = null;
    if (fired) return;
    streak = claudeInputReady(o.readScreen()) ? streak + 1 : 0;
    if (streak >= 2) fire('box');
    else cancelPoll = o.schedule(poll, pollMs);
  };

  return {
    feed() {
      if (fired || started) return;
      started = true;
      cancelCeiling = o.schedule(() => fire('ceiling'), ceilingMs);
      cancelPoll = o.schedule(poll, pollMs);
    },
    reset() {
      clear();
      fired = false;
      started = false;
      streak = 0;
    },
    dispose() {
      clear();
      fired = true;
    },
  };
}
