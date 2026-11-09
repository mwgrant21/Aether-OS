import type { TerminalAttachment, TerminalReadPort, TerminalSlotId, TerminalTap } from '../src/shared/remote/types';

const SNAP_TIMEOUT_MS = 2000;

export interface DesktopFeed {
  /** Live pty data for the desktop window: sent now, or held while a snapshot is in flight. */
  data(d: string): void;
  /** Deliver a fresh hub snapshot, then the data that arrived meanwhile. A second call supersedes the first. */
  reattach(): void;
  /** The session ended: sent now, or after the pending snapshot and held data so the exit text lands last. Dropped if the slot restarts before the snapshot releases. */
  exit(): void;
  dispose(): void;
}

/**
 * Orders a re-attached renderer's stream: snapshot first, then every chunk fed after the attach
 * instant, each exactly once. Main's direct data() feed is the single source of live data; the
 * hub tap's own out/size events are ignored so nothing is delivered twice.
 */
export function createDesktopFeed(o: {
  port: TerminalReadPort;
  slot: TerminalSlotId;
  send: (channel: string, payload: unknown) => void;
  channels: { data: string; snap: string; exit: string };
  setTimer?: (fn: () => void, ms: number) => () => void;
}): DesktopFeed {
  const setTimer = o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  let gen = 0;
  let gated = false;
  let held: string[] = [];
  let exitPending = false;
  let exitQ: number | undefined;
  const slotQ = () => o.port.list().find((i) => i.s === o.slot)?.q;
  let attachment: TerminalAttachment | null = null;
  let cancelTimer: (() => void) | null = null;

  function teardown(): void {
    cancelTimer?.(); cancelTimer = null;
    attachment?.detach(); attachment = null;
  }
  /** Un-gate and flush held data in order. The hub never calls snap on exit/release mid-snapshot, so this also runs from the timeout. */
  function release(): void {
    gated = false;
    cancelTimer?.(); cancelTimer = null;
    const out = held; held = [];
    for (const d of out) o.send(o.channels.data, d);
    if (exitPending) {
      exitPending = false;
      // The slot restarted since the exit (its q moved on): that exit belongs to the old session, drop it.
      if (slotQ() === exitQ) o.send(o.channels.exit, undefined);
    }
  }

  return {
    data(d) {
      if (gated) held.push(d);
      else o.send(o.channels.data, d);
    },
    exit() {
      if (gated) { exitPending = true; exitQ = slotQ(); }
      else o.send(o.channels.exit, undefined);
    },
    reattach() {
      teardown();
      const mine = ++gen;
      gated = true;
      held = [];
      const tap: TerminalTap = {
        snap: (e) => {
          if (mine !== gen || !gated) return; // superseded, or a later hub snap (e.g. slot restart) after release
          o.send(o.channels.snap, { cols: e.cols, rows: e.rows, d: e.d });
          release();
          // The snap can fire synchronously inside attach(), before `attachment` is assigned; detach after.
          queueMicrotask(() => { if (mine === gen) { attachment?.detach(); attachment = null; } });
        },
        out: () => undefined,
        size: () => undefined,
      };
      attachment = o.port.attach(o.slot, null, tap);
      if (gated) {
        cancelTimer = setTimer(() => { if (mine === gen && gated) { release(); teardown(); } }, SNAP_TIMEOUT_MS);
      }
    },
    dispose() {
      gen++;
      teardown();
      release();
    },
  };
}
