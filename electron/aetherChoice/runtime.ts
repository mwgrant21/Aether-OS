// AetherChoice runtime: composes the screen watcher and the pick host and feeds the host from the
// slots' observe events (output, start, exit). It gives the engine a write port that returns false
// instead of throwing, and exposes the launch, user-input, statusline, flush and dispose surface
// that main wires up. Returns null unless AETHER_CHOICE_HOST is exactly '1'.
// Pure of electron, fs, pty and timers: everything arrives through AetherChoiceRuntimeDeps.
// With AETHER_CHOICE_TRACE=1 it also samples each owned slot once a second through deps.schedule and
// logs one change-only line of enums, a version number, a boolean and two counters. Observe-only: it
// never writes to a slot and never calls a host method.
import { createPickHost } from './pickHost';
import type { OwnedSlot, PickHostDeps, SlotState } from './pickHost';
import { createScreenWatcher } from './screenWatcher';
import type { ObservableSlot, ScreenWatcherDeps } from './screenWatcher';
import type { FailureInfo } from './applyEngine';
import type { SlotEvent } from '../terminalHub';
import { ladderPick } from '../../src/shared/aetherChoice/pickPolicy';
import type { ThreadPickRecord } from '../../src/shared/aetherChoice/pickRecord';
import type { Pick as ModelPick } from '../../src/shared/aetherChoice/types';
import type { TerminalWritePort } from '../../src/shared/remote/types';
import type { StatuslineSnapshot } from '../../src/shared/statuslinePayload';

export type AetherChoiceRuntimeDeps = {
  env: Readonly<Record<string, string | undefined>>;
  slots: Record<OwnedSlot, ObservableSlot>;
  /** The ENGINE port (terminalHub.writePort()), never the user-input wrapper. */
  writePort: TerminalWritePort;
  loadRecords(): Record<string, ThreadPickRecord>;
  save(records: Record<string, ThreadPickRecord>): Promise<void>;
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
  log(line: string): void;
  sendToWindow(channel: string, payload: unknown): void;
  watcher?: Pick<ScreenWatcherDeps, 'createMirror' | 'classify'>;
  host?: Partial<Pick<PickHostDeps, 'quietMs' | 'readMaxAgeMs' | 'tickMs' | 'launchGraceMs' | 'readbackTimeoutMs' | 'minWriteGapMs'>>;
};

export type AetherChoiceRuntime = {
  /** undefined = leave the spawn arguments untouched. */
  launchCommandFor(slot: OwnedSlot, o?: { sessionId?: string }): string | undefined;
  onForeignLaunch(slot: OwnedSlot): void;
  noteUserInput(slot: string): void;
  wrapUserWritePort(port: TerminalWritePort): TerminalWritePort;
  onStatusline(snapshot: StatuslineSnapshot): void;
  state(slot: string): SlotState | null;
  submitPick(slot: string, pick: ModelPick): { rejected: string | null };
  clearHalt(slot: string): void;
  flush(): Promise<void>;
  dispose(): void;
};

const MANUAL_REASON = 'manual pick';
const OWNED: readonly OwnedSlot[] = ['claude', 'terminal2'];
const isOwned = (slot: string): slot is OwnedSlot => (OWNED as readonly string[]).includes(slot);

export function createAetherChoiceRuntime(deps: AetherChoiceRuntimeDeps): AetherChoiceRuntime | null {
  if (deps.env.AETHER_CHOICE_HOST !== '1') return null;

  let disposed = false;
  // slot -> session id of a launch handed out by launchCommandFor and not yet matched by a start event
  const planned = new Map<OwnedSlot, string | undefined>();
  // slots whose current process has started and not yet reported exit
  const running = new Set<OwnedSlot>();
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // a failing sink or host call must not escape into the pty path
    }
  };

  // Trace state. Every field stays empty and unused unless the trace switch is exactly '1'.
  const trace = deps.env.AETHER_CHOICE_TRACE === '1';
  const quietMs = deps.host?.quietMs ?? 1500;
  const lastOutAt = new Map<OwnedSlot, number>();
  const lastInAt = new Map<OwnedSlot, number>();
  const lastKey = new Map<OwnedSlot, string>();
  const cancels = new Map<OwnedSlot, () => void>();
  const stampOut = (slot: OwnedSlot): void => {
    if (trace) safe(() => lastOutAt.set(slot, deps.now()));
  };
  const stampIn = (slot: OwnedSlot): void => {
    if (trace) safe(() => lastInAt.set(slot, deps.now()));
  };
  // a host fault while noting user input must never cost the user a keystroke; logged once per slot (per-keystroke path)
  const inputFaultLogged = new Set<OwnedSlot>();
  const noteInput = (slot: OwnedSlot): void => {
    stampIn(slot);
    try {
      host.noteUserInput(slot);
    } catch {
      if (!inputFaultLogged.has(slot)) {
        inputFaultLogged.add(slot);
        safe(() => deps.log(`input-note-failed ${slot}`));
      }
    }
  };
  const forgetOut = (slot: OwnedSlot): void => {
    lastOutAt.delete(slot);
    lastKey.delete(slot);
  };

  const enginePort: TerminalWritePort = {
    write(s, d) {
      try {
        return deps.writePort.write(s, d) === true;
      } catch {
        return false;
      }
    },
  };

  const notifyFailure = (info: FailureInfo): void => {
    safe(() =>
      deps.log(
        `halted ${info.threadId} wanted ${info.wanted.model}/${info.wanted.effort} actual ${info.actual ? `${info.actual.model}/${info.actual.effort}` : 'unknown'}`,
      ),
    );
    safe(() => deps.sendToWindow('aetherChoice:halted', info));
  };

  const watcher = createScreenWatcher({ slots: deps.slots, ...deps.watcher });
  const host = createPickHost({
    writePort: enginePort,
    readScreen: (s) => watcher.read(s),
    loadRecords: deps.loadRecords,
    save: deps.save,
    initialPick: ladderPick('default', { opusUnlocked: false }),
    now: deps.now,
    schedule: deps.schedule,
    log: deps.log,
    notifyFailure,
    ...deps.host,
  });

  const sinceMs = (now: number, stamp: number | undefined): number | null =>
    stamp === undefined ? null : Math.max(0, Math.round(now - stamp));

  const arm = (slot: OwnedSlot): void => {
    if (disposed) return;
    safe(() => {
      cancels.set(
        slot,
        deps.schedule(() => {
          void sample(slot);
        }, 1000),
      );
    });
  };

  // One sample per slot; the next is armed only after this one settles, so a slow read never overlaps.
  const sample = async (slot: OwnedSlot): Promise<void> => {
    if (disposed) return;
    try {
      if (deps.slots[slot].info().state === 'running') {
        const reading = await watcher.read(slot);
        if (disposed) return;
        const version = watcher.version(slot) ?? 'none';
        const now = deps.now();
        const out = sinceMs(now, lastOutAt.get(slot));
        const inp = sinceMs(now, lastInAt.get(slot));
        const quiet = out !== null && out >= quietMs;
        const key = `${reading}|${version}|${quiet}`;
        if (lastKey.get(slot) !== key) {
          lastKey.set(slot, key);
          deps.log(
            `trace ${slot} reading=${reading} version=${version} quiet=${quiet} sinceOutMs=${out ?? 'none'} sinceInMs=${inp ?? 'none'}`,
          );
        }
      }
    } catch {
      // a failing clock, log or read must not stop the chain
    }
    arm(slot);
  };
  if (trace) for (const slot of OWNED) arm(slot);

  const unsubscribe: Array<() => void> = OWNED.map((slot) =>
    deps.slots[slot].observe((e: SlotEvent) => {
      if (disposed) return;
      safe(() => {
        if (e.kind === 'out') {
          host.noteOutput(slot);
          stampOut(slot);
        } else if (e.kind === 'start') {
          forgetOut(slot);
          // TerminalSlot reports start even for a pty that exited while being wired; that slot is not running.
          if (deps.slots[slot].info().state !== 'exited') running.add(slot);
          if (planned.delete(slot)) host.onLaunched(slot);
          else host.onForeignLaunch(slot);
        } else if (e.kind === 'state' && e.state === 'exited') {
          forgetOut(slot);
          // A plan made while a process was still running belongs to its replacement, so this exit is the
          // retiring process's: retire the old session, then re-arm the same launch for the next start.
          const replacement = running.delete(slot) && planned.has(slot);
          const sessionId = planned.get(slot);
          planned.delete(slot);
          host.onSlotExit(slot);
          if (replacement && host.launchFor(slot, { sessionId }).command !== null) planned.set(slot, sessionId);
        }
      });
    }),
  );

  return {
    launchCommandFor(slot, o) {
      if (disposed) return undefined;
      try {
        const d = host.launchFor(slot, { sessionId: o?.sessionId });
        if (d.command !== null) {
          planned.set(slot, o?.sessionId);
          return d.command;
        }
        planned.delete(slot);
        return undefined;
      } catch {
        // a host fault must not reach pty:start: launch unmanaged and drop any plan from an earlier call
        planned.delete(slot);
        safe(() => deps.log(`launch-failed ${slot}`));
        return undefined;
      }
    },
    onForeignLaunch(slot) {
      planned.delete(slot);
      try {
        host.onForeignLaunch(slot);
      } catch {
        // the next start event retries the reset while no plan is held
        safe(() => deps.log(`foreign-launch-failed ${slot}`));
      }
    },
    noteUserInput(slot) {
      if (isOwned(slot)) noteInput(slot);
    },
    wrapUserWritePort(port) {
      return {
        write(s, d) {
          if (isOwned(s)) noteInput(s);
          return port.write(s, d);
        },
      };
    },
    onStatusline(s) {
      if (!disposed) host.onStatusline(s);
    },
    state(slot) {
      if (disposed) return null;
      try {
        return host.state(slot as OwnedSlot);
      } catch {
        return null;
      }
    },
    submitPick(slot, pick) {
      if (disposed) return { rejected: 'disposed' };
      try {
        return host.submitPick(slot as OwnedSlot, pick, MANUAL_REASON);
      } catch {
        return { rejected: 'error' };
      }
    },
    clearHalt(slot) {
      if (disposed) return;
      safe(() => host.clearHalt(slot as OwnedSlot));
    },
    flush: () => host.flush(),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribe) safe(off);
      for (const cancel of cancels.values()) safe(cancel);
      cancels.clear();
      host.dispose();
      watcher.dispose();
    },
  };
}
