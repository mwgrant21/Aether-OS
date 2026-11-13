// Renderer-side "is Claude busy?" detector for the GUI chat pane. Pure: timers and the screen reader are injected
// (same shape as trustPrompt.ts's watcher). It reads the xterm screen text, never the PTY stream.
//
// Needles below were read from claude 2.1.323 (probe P4, 2026-11-12). A Claude reword is a one-line change here.

export const GUI_BUSY_QUIET_MS = 3000;       // output silence after which a working/waiting gate re-reads the screen
export const GUI_BUSY_IDLE_SAMPLE_MS = 1000; // throttle: one screen read per second of output, also while idle
export const GUI_BUSY_SETTLE_MS = 3000;      // idle plus this much more silence (and a second idle read) = settled
export const GUI_BUSY_CANARY_MS = 4000;      // output for longer than this with every read idle = matcher is blind
export const GUI_BUSY_SCAN_ROWS = 10;        // only the last N non-empty screen rows are read

// true = a background shell/agent is reliably visible on screen (P4, approved by Matt 2026-11-12), so a chat with
// one running reads as busy and auto-stop may be ON.
export const GUI_BG_MARKER_RELIABLE = true;

export type BusyState = 'idle' | 'working' | 'waiting';
export const isBusy = (s: BusyState): boolean => s !== 'idle';

// Background tasks that keep a chat busy after the reply ended. Bare "agent", "1 agent" and "for agents"
// are constant idle noise in the footer and must NOT match; a running background agent shows as the
// separate footer segment "· 1 monitor ·" instead.
export const BG_TASK_NEEDLES: readonly RegExp[] = [
  /·\s*\d+ shells?\s*(?:·|$)/i,   // footer segment "· 1 shell ·"
  /still running/i,               // done row "... · 1 shell still running"
  /\/tasks to see subagents/i,    // background agent
  /·\s*\d+ monitors?\b/i,         // footer segment "· 1 monitor · ← 1 agent" while a background agent runs
];

export interface BusyNeedles {
  /** A dialog is open: permission ("Esc to cancel · Tab to amend"), plan approval or ask ("Enter to select ... Esc to cancel"). */
  waiting: readonly RegExp[];
  /** A reply is streaming: the spinner row (glyph, one word, ellipsis). Tool-activity rows are not the signal. */
  working: readonly RegExp[];
  bgTask: readonly RegExp[];
}
export const BUSY_NEEDLES: BusyNeedles = {
  waiting: [/esc to cancel/i, /tab to amend/i, /do you want to proceed\?/i],
  working: [/^\s*[✢✻✽✶·*]\s+\S+…/u],
  bgTask: BG_TASK_NEEDLES,
};

/** Classifies the screen from its last GUI_BUSY_SCAN_ROWS non-empty rows: waiting, else working, else idle. */
export function classifyWorkScreen(text: string, needles: BusyNeedles = BUSY_NEEDLES): BusyState {
  const rows = text.split('\n').filter((r) => r.trim() !== '').slice(-GUI_BUSY_SCAN_ROWS);
  const any = (list: readonly RegExp[]): boolean => rows.some((r) => list.some((n) => n.test(r)));
  if (any(needles.waiting)) return 'waiting';
  if (any(needles.working) || any(needles.bgTask)) return 'working';
  return 'idle';
}

export interface BusyGate {
  /** The user sent something that can start a reply. */
  turnStarted(): void;
  /** One PTY chunk arrived. */
  feed(): void;
  reset(): void;
  dispose(): void;
  state(): BusyState;
  /** false = the canary decided the matcher cannot see Claude's working screen; consumers turn auto-stop OFF. */
  trusted(): boolean;
}

export function createBusyGate(o: {
  schedule: (fn: () => void, ms: number) => () => void;
  readScreen: () => string;
  onChange: (s: BusyState) => void;
  onSettled: () => void;
  onTrust: (trusted: boolean) => void;
  now?: () => number;
  needles?: BusyNeedles;
}): BusyGate {
  const now = o.now ?? Date.now;
  let state: BusyState = 'idle';
  let trusted = true;
  let disposed = false;
  let turnActive = false;  // a turn is in progress (user-started or Claude-initiated)
  let turnStartAt = 0;
  let sawWork = false;     // a read in this turn classified non-idle
  let settleArmed = false; // idle was reached and onSettled has not fired yet
  let cancelQuiet: (() => void) | null = null;
  let cancelSample: (() => void) | null = null;
  let cancelSettle: (() => void) | null = null;

  const clear = (c: (() => void) | null): null => { c?.(); return null; };
  const clearAll = (): void => {
    cancelQuiet = clear(cancelQuiet);
    cancelSample = clear(cancelSample);
    cancelSettle = clear(cancelSettle);
  };
  const setState = (s: BusyState): void => {
    if (s === state) return;
    state = s;
    o.onChange(s);
  };
  const setTrusted = (t: boolean): void => {
    if (t === trusted) return;
    trusted = t;
    o.onTrust(t);
  };
  const read = (): BusyState => classifyWorkScreen(o.readScreen(), o.needles);
  const noteWork = (c: BusyState): void => {
    if (c === 'idle') return;
    sawWork = true;
    setTrusted(true);
  };
  const beginTurn = (): void => {
    settleArmed = false;
    cancelSettle = clear(cancelSettle);
    if (!turnActive) { turnActive = true; turnStartAt = now(); sawWork = false; }
  };
  const armQuiet = (): void => {
    cancelQuiet?.();
    cancelQuiet = o.schedule(onQuiet, GUI_BUSY_QUIET_MS);
  };
  const armSettle = (): void => {
    cancelSettle?.();
    cancelSettle = o.schedule(onSettle, GUI_BUSY_SETTLE_MS);
  };

  function onQuiet(): void {
    cancelQuiet = null;
    const c = read();
    noteWork(c);
    if (c !== 'idle') { setState(c); return; }
    turnActive = false;
    setState('idle');
    settleArmed = true;
    armSettle();
  }

  function onSettle(): void {
    cancelSettle = null;
    if (!settleArmed) return;
    const c = read();
    noteWork(c);
    if (c !== 'idle') {
      settleArmed = false;
      beginTurn();
      setState(c);
      armQuiet();
      return;
    }
    settleArmed = false;
    o.onSettled();
  }

  function onSample(): void {
    cancelSample = null;
    const c = read();
    if (state === 'idle') {
      if (c === 'idle') return;
      beginTurn(); // a Claude-initiated turn: a finished background task, a scheduled prompt
      noteWork(c);
      setState(c);
      armQuiet();
      return;
    }
    if (c !== 'idle') { noteWork(c); setState(c); return; }
    if (turnActive && !sawWork && trusted && now() - turnStartAt > GUI_BUSY_CANARY_MS) setTrusted(false);
  }

  return {
    turnStarted() {
      if (disposed) return;
      beginTurn();
      setState('working');
      armQuiet();
    },
    feed() {
      if (disposed) return;
      if (state !== 'idle') armQuiet();
      else if (settleArmed) armSettle(); // settle counts silence from the LAST chunk
      if (!cancelSample) cancelSample = o.schedule(onSample, GUI_BUSY_IDLE_SAMPLE_MS);
    },
    reset() {
      clearAll();
      turnActive = false;
      sawWork = false;
      settleArmed = false;
      setState('idle');
      setTrusted(true);
    },
    dispose() {
      disposed = true;
      clearAll();
    },
    state: () => state,
    trusted: () => trusted,
  };
}
