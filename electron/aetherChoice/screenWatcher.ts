// Per-slot screen watcher: one headless mirror (scrollback 0) per watched Claude slot, fed from the
// slot's observe events. It only reads. Screen text lives inside the mirror; read() returns just the
// shared IdleReading enum and version() just the latched X.Y.Z string.
import { createTerminalMirror, type TerminalMirror } from '../terminalMirror';
import type { SlotEvent } from '../terminalHub';
import type { TerminalInfo } from '../../src/shared/remote/types';
import { classifyScreen, extractClaudeVersion } from '../../src/shared/aetherChoice/idleClassifier';
import type { IdleReading } from '../../src/shared/aetherChoice/types';

export type WatchedSlot = 'claude' | 'terminal2';
export type ObservableSlot = { observe(l: (e: SlotEvent) => void): () => void; info(): TerminalInfo };
export type ScreenMirror = Pick<TerminalMirror, 'write' | 'resize' | 'viewportText' | 'dispose'>;
export type ScreenMirrorFactory = (o: { cols: number; rows: number; scrollback: number }) => ScreenMirror;
export type ScreenWatcherDeps = {
  slots: Record<WatchedSlot, ObservableSlot>;
  createMirror?: ScreenMirrorFactory;
  classify?: typeof classifyScreen;
};
export type ScreenWatcher = {
  read(slot: WatchedSlot): Promise<IdleReading>;
  version(slot: WatchedSlot): string | null;
  dispose(): void;
};

type Coverage = 'full' | 'partial';
type SlotState = {
  gen: number;
  mirror: ScreenMirror | null;
  coverage: Coverage;
  version: string | null;
  probing: boolean;
  probeAgain: boolean;
  unsubscribe: () => void;
};

const SLOT_IDS: readonly WatchedSlot[] = ['claude', 'terminal2'];
const validDims = (cols: unknown, rows: unknown): boolean =>
  Number.isInteger(cols) && (cols as number) > 0 && Number.isInteger(rows) && (rows as number) > 0;

// The newest banner is the lowest one on screen, so scan from the bottom.
const lastClaudeVersion = (rows: string[]): string | null => extractClaudeVersion([...rows].reverse());

export function createScreenWatcher(deps: ScreenWatcherDeps): ScreenWatcher {
  const makeMirror: ScreenMirrorFactory = deps.createMirror ?? ((o) => createTerminalMirror(o));
  const classify = deps.classify ?? classifyScreen;
  let disposed = false;
  const states = {} as Record<WatchedSlot, SlotState>;

  const dropMirror = (s: SlotState): void => {
    const m = s.mirror;
    s.mirror = null;
    if (m !== null) { try { m.dispose(); } catch { /* already gone */ } }
  };
  const retire = (s: SlotState): void => {
    s.gen++;
    dropMirror(s);
    s.version = null;
    s.probeAgain = false;
  };
  const open = (s: SlotState, cols: number, rows: number, coverage: Coverage): void => {
    s.mirror = validDims(cols, rows) ? makeMirror({ cols, rows, scrollback: 0 }) : null;
    s.coverage = coverage;
  };

  // At most one probe in flight per slot; a request that arrives meanwhile earns exactly one follow-up.
  const requestProbe = (s: SlotState): void => {
    if (s.mirror === null) return;
    if (s.probing) { s.probeAgain = true; return; }
    void runProbe(s);
  };
  const runProbe = async (s: SlotState): Promise<void> => {
    const m = s.mirror;
    if (m === null) return;
    s.probing = true;
    const g = s.gen;
    try {
      const rows = await m.viewportText();
      if (s.gen === g) {
        // A shell screen clears the latch and never sets it: it can still show the old banner row.
        if (classify({ rows, coverage: s.coverage, claudeVersion: null }) === 'shell') s.version = null;
        else {
          const seen = lastClaudeVersion(rows);
          if (seen !== null) s.version = seen;
        }
      }
    } catch { /* probe is best effort */ }
    s.probing = false;
    if (s.probeAgain) {
      s.probeAgain = false;
      requestProbe(s);
    }
  };

  const onEvent = (s: SlotState, e: SlotEvent): void => {
    try {
      if (disposed) return;
      if (e.kind === 'start') {
        retire(s);
        open(s, e.cols, e.rows, 'full');
      } else if (e.kind === 'out') {
        if (s.mirror === null) return;
        s.mirror.write(e.d);
        requestProbe(s);
      } else if (e.kind === 'size') {
        if (s.mirror !== null && validDims(e.cols, e.rows)) s.mirror.resize(e.cols, e.rows);
      } else if (e.state === 'exited') {
        retire(s);
      }
    } catch {
      try { retire(s); } catch { /* nothing more to do */ }
    }
  };

  for (const id of SLOT_IDS) {
    const s: SlotState = {
      gen: 0, mirror: null, coverage: 'full', version: null, probing: false, probeAgain: false,
      unsubscribe: () => undefined,
    };
    states[id] = s;
    const slot = deps.slots[id];
    s.unsubscribe = slot.observe((e) => onEvent(s, e));
    try {
      const info = slot.info();
      if (info.state === 'running') open(s, info.cols, info.rows, 'partial');
    } catch { /* reads unknown until the next start */ }
  }

  return {
    async read(slot) {
      try {
        const s = (SLOT_IDS as readonly string[]).includes(slot) ? states[slot] : undefined;
        if (disposed || s === undefined || s.mirror === null) return 'unknown';
        const g = s.gen;
        const rows = await s.mirror.viewportText();
        if (disposed || s.gen !== g) return 'unknown';
        const seen = lastClaudeVersion(rows);
        if (seen !== null) s.version = seen;
        const reading = classify({ rows, coverage: s.coverage, claudeVersion: s.version });
        if (reading === 'shell') s.version = null;
        return reading;
      } catch {
        return 'unknown';
      }
    },
    version(slot) {
      const s = (SLOT_IDS as readonly string[]).includes(slot) ? states[slot] : undefined;
      return s?.version ?? null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of SLOT_IDS) {
        const s = states[id];
        try { s.unsubscribe(); } catch { /* ignore */ }
        retire(s);
      }
    },
  };
}
