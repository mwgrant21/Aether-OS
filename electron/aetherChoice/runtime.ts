// AetherChoice runtime: composes the screen watcher and the pick host and feeds the host from the
// slots' observe events (output, start, exit). It gives the engine a write port that returns false
// instead of throwing, and exposes the launch, user-input, statusline, flush and dispose surface
// that main wires up. Returns null unless AETHER_CHOICE_HOST is exactly '1'.
// Pure of electron, fs, pty and timers: everything arrives through AetherChoiceRuntimeDeps.
import { createPickHost } from './pickHost';
import type { OwnedSlot, PickHostDeps } from './pickHost';
import { createScreenWatcher } from './screenWatcher';
import type { ObservableSlot, ScreenWatcherDeps } from './screenWatcher';
import type { FailureInfo } from './applyEngine';
import type { SlotEvent } from '../terminalHub';
import { ladderPick } from '../../src/shared/aetherChoice/pickPolicy';
import type { ThreadPickRecord } from '../../src/shared/aetherChoice/pickRecord';
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
  flush(): Promise<void>;
  dispose(): void;
};

const OWNED: readonly OwnedSlot[] = ['claude', 'terminal2'];
const isOwned = (slot: string): slot is OwnedSlot => (OWNED as readonly string[]).includes(slot);

export function createAetherChoiceRuntime(deps: AetherChoiceRuntimeDeps): AetherChoiceRuntime | null {
  if (deps.env.AETHER_CHOICE_HOST !== '1') return null;

  let disposed = false;
  const planned = new Set<OwnedSlot>();
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // a failing sink or host call must not escape into the pty path
    }
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

  const unsubscribe: Array<() => void> = OWNED.map((slot) =>
    deps.slots[slot].observe((e: SlotEvent) => {
      if (disposed) return;
      safe(() => {
        if (e.kind === 'out') {
          host.noteOutput(slot);
        } else if (e.kind === 'start') {
          if (planned.delete(slot)) host.onLaunched(slot);
          else host.onForeignLaunch(slot);
        } else if (e.kind === 'state' && e.state === 'exited') {
          planned.delete(slot);
          host.onSlotExit(slot);
        }
      });
    }),
  );

  return {
    launchCommandFor(slot, o) {
      if (disposed) return undefined;
      const d = host.launchFor(slot, { sessionId: o?.sessionId });
      if (d.command !== null) {
        planned.add(slot);
        return d.command;
      }
      planned.delete(slot);
      return undefined;
    },
    onForeignLaunch(slot) {
      planned.delete(slot);
      host.onForeignLaunch(slot);
    },
    noteUserInput(slot) {
      if (isOwned(slot)) host.noteUserInput(slot);
    },
    wrapUserWritePort(port) {
      return {
        write(s, d) {
          if (isOwned(s)) host.noteUserInput(s);
          return port.write(s, d);
        },
      };
    },
    onStatusline(s) {
      if (!disposed) host.onStatusline(s);
    },
    flush: () => host.flush(),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribe) safe(off);
      host.dispose();
      watcher.dispose();
    },
  };
}
