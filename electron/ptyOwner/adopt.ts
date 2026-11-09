// Adoption at app start (Design 10): attach to the shells a surviving helper still owns and hand
// each to its slot. Pure and injected: no ptyLifecycle / ptyManager / codexPtyManager / node-pty
// imports; main wires the targets. Never throws; one slot's failure does not affect the others.
// `attach()` has already buffered the ring into the RemotePty, so adopt never replays it: it
// registers the consumer first (target.start), then resume() flushes ring then live data once.
import type { AttachResult, OwnerClient, SetTimer } from './ownerClient';
import type { Meta } from './protocol';
import type { RemotePty } from './remotePty';
import type { TerminalSlotId } from '../../src/shared/remote/types';

export interface AdoptInfo { cols: number; rows: number; meta: Meta; startedAt: number }
export interface AdoptTarget {
  /** Start the slot on the adopted pty (callbacks registered, onAlive fired); must not resume it. */
  start(pty: RemotePty, info: AdoptInfo): void;
  /** Slot-specific module state, applied after the replay was released. */
  apply(info: AdoptInfo): void;
}
export interface AdoptDeps {
  client: Pick<OwnerClient, 'list' | 'attach' | 'forget'>;
  targets: Partial<Record<TerminalSlotId, AdoptTarget>>;
  setTimer: SetTimer;
  /** Fixed-string diag lines only. */
  log: (line: string) => void;
  budgetMs?: number;
  nudgeDelayMs?: number;
}

export async function adoptOwned(deps: AdoptDeps): Promise<TerminalSlotId[]> {
  const { client, targets, setTimer, log } = deps;
  const budgetMs = deps.budgetMs ?? 3000;
  const nudgeDelayMs = deps.nudgeDelayMs ?? 50;
  const adopted: TerminalSlotId[] = [];
  let expired = false;

  const forget = (slot: TerminalSlotId): void => {
    try { client.forget(slot); } catch { log('pty-owner: adopt forget failed'); }
  };

  const run = async (): Promise<void> => {
    const slots = await client.list();
    for (const s of slots) {
      if (expired) return;
      const target = targets[s.slot];
      if (!target) continue;
      try {
        if (s.state === 'exited') { forget(s.slot); continue; }
        const a: AttachResult = await client.attach(s.slot);
        if (expired) return;
        if (a.state === 'exited') { forget(s.slot); continue; }
        const info: AdoptInfo = { cols: a.cols, rows: a.rows, meta: a.meta, startedAt: a.startedAt };
        target.start(a.pty, info);
        a.pty.resume();
        adopted.push(s.slot);
        target.apply(info);
        a.pty.resize(a.cols, Math.max(1, a.rows - 1));
        setTimer(() => { try { a.pty.resize(a.cols, a.rows); } catch { /* connection gone */ } }, nudgeDelayMs);
      } catch {
        log('pty-owner: adopt slot failed');
      }
    }
  };

  let cancel: () => void = () => {};
  const timeout = new Promise<void>(resolve => {
    cancel = setTimer(() => { expired = true; resolve(); }, budgetMs);
  });
  try {
    await Promise.race([run().catch(() => { log('pty-owner: adopt failed'); }), timeout]);
  } catch { /* never throws */ }
  cancel();
  return [...adopted];
}
