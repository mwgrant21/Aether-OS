// AetherChoice apply engine. Turns record changes into at most one `/effort <level>\r`
// write per confirmed-idle moment, entirely through injected ports (no fs, no pty, no
// clock of its own). Option R: it never emits /model; a model pick stays in modelPending.
import type { TerminalSlotId, TerminalWritePort } from '../../src/shared/remote/types';
import { LAUNCH_EFFORTS } from '../../src/shared/aetherChoice/types';
import type { Pick, PickSource, PickTrigger, ReadoutState } from '../../src/shared/aetherChoice/types';
import { applyBudget } from '../../src/shared/aetherChoice/pickPolicy';
import {
  clearHalt,
  clearPendingStepDown,
  deriveReadoutState,
  markNotApplied,
  setPendingStepDown,
  submitPick,
} from '../../src/shared/aetherChoice/pickRecord';
import type { ThreadPickRecord } from '../../src/shared/aetherChoice/pickRecord';

export type IdleReading =
  | 'idle'
  | 'generating'
  | 'busy'
  | 'picker'
  | 'modal'
  | 'switch-model-modal'
  | 'draft'
  | 'unknown';

/** OPEN-2: no real idle detector exists. This stub refuses to guess. */
export const unknownIdle = (_slot: TerminalSlotId): IdleReading => 'unknown';

export type PickLineOutcome = 'queued' | 'sent' | 'confirmed' | 'not-applied';

export type PickLineFields = {
  time: string;
  from: string;
  to: string;
  source: PickSource;
  trigger: PickTrigger;
  outcome: PickLineOutcome;
};

/** Output-pane line, fields in this fixed order. */
export function formatPickLine(f: PickLineFields): string {
  return `${f.time} ${f.from} -> ${f.to} ${f.source} ${f.trigger} ${f.outcome}`;
}

export type FailureInfo = { threadId: string; wanted: Pick; actual: Pick | null };

export type ApplyEngineDeps = {
  writePort: TerminalWritePort;
  slotFor(threadId: string): TerminalSlotId | null;
  idle(slot: TerminalSlotId): IdleReading;
  now(): number;
  log(line: string): void;
  notifyFailure(info: FailureInfo): void;
  awayMode(): boolean;
  usage(): { sessionPct: number; weekPct: number };
  getRecord(threadId: string): ThreadPickRecord | undefined;
  setRecord(threadId: string, rec: ThreadPickRecord): void;
  /** Minimum ms between two writes to one thread (default 2000): the screen can read idle for a repaint after a write. */
  minWriteGapMs?: number;
};

export type PickMetaIn = { reason: string; trigger: PickTrigger; source: PickSource };

/** Once the queue is consumed, only a held model pick still has an owner. Both queue-consuming branches use this. */
const ownerAfterQueueConsumed = (rec: ThreadPickRecord): PickSource | null => (rec.modelPending ? rec.pendingSource : null);

const fmt = (p: Pick): string => `${p.model}/${p.effort}`;

export function createApplyEngine(deps: ApplyEngineDeps) {
  const minGap = deps.minWriteGapMs ?? 2000;
  const lastWriteAt = new Map<string, number>();
  const stamp = (): string => new Date(deps.now()).toISOString();

  function line(from: Pick, to: Pick, source: PickSource, trigger: PickTrigger, outcome: PickLineOutcome): void {
    deps.log(formatPickLine({ time: stamp(), from: fmt(from), to: fmt(to), source, trigger, outcome }));
  }

  function onPick(threadId: string, pick: Pick, meta: PickMetaIn): { rejected: string | null } {
    const rec = deps.getRecord(threadId);
    if (!rec) return { rejected: 'unknown thread' };
    const r = submitPick(rec, pick, { ...meta, now: deps.now() });
    if (r.rejected !== null) return { rejected: r.rejected };
    deps.setRecord(threadId, r.record);
    const changed =
      JSON.stringify([r.record.queue, r.record.modelPending, r.record.intended]) !==
      JSON.stringify([rec.queue, rec.modelPending, rec.intended]);
    if (changed) line(rec.launched ?? rec.intended, pick, meta.source, meta.trigger, 'queued');
    return { rejected: null };
  }

  function onIdleCheck(threadId: string): 'sent' | 'skipped' {
    const rec = deps.getRecord(threadId);
    // Ruling 9b: zero bytes reach a halted slot.
    // A queued effort survives an exit (markExited keeps it) and waits for the next live thread: with
    // no live thread the command could reach the underlying shell, so nothing is written or cleared.
    if (!rec || !rec.live || rec.halted || !rec.queue) return 'skipped';
    const slot = deps.slotFor(threadId);
    if (slot !== 'claude' && slot !== 'terminal2') return 'skipped';
    const q = rec.queue;
    // The running pick is the baseline; `intended` is the desired pick and may differ after a budget lowering.
    const base = rec.launched ?? rec.intended;
    // The queued model may be stale and the plan may have been budget-lowered since: re-run the budget
    // against the live model and read only the effort. A budget-triggered queue already carries one policy
    // step, so it is re-evaluated from the desired effort (never from the queued, already-lowered one):
    // one threshold crossing is one step.
    const budgetInput = q.trigger === 'budget' ? rec.intended.effort : q.pick.effort;
    const b = applyBudget({ model: base.model, effort: budgetInput }, deps.usage(), q.source, rec.lastBudgetLevel);
    const effort = b.pick.effort;
    // The level this budget run reached feeds the next run's hysteresis (a manual source is never budgeted).
    const levelAfter = q.source === 'manual' ? rec.lastBudgetLevel : b.level;
    if (!(LAUNCH_EFFORTS as readonly string[]).includes(effort)) return 'skipped';
    // A budget step-down is never a desire; a real desire the budget held down is kept as intent.
    const desire = q.trigger !== 'budget';
    if (effort === base.effort) {
      deps.setRecord(threadId, {
        ...rec,
        intended: desire ? { ...rec.intended, effort: q.pick.effort } : rec.intended,
        source: desire ? q.source : rec.source,
        queue: null,
        pendingSource: ownerAfterQueueConsumed(rec),
        lastBudgetLevel: levelAfter,
      });
      return 'skipped';
    }
    const order = LAUNCH_EFFORTS as readonly string[];
    const stepDown = order.indexOf(effort) < order.indexOf(base.effort);
    const last = lastWriteAt.get(threadId);
    if (last !== undefined && deps.now() - last < minGap) return 'skipped';
    const reading = deps.idle(slot);
    const midTurnOk = reading === 'generating' && q.trigger === 'budget' && stepDown;
    if (reading !== 'idle' && !midTurnOk) return 'skipped';
    if (!deps.writePort.write(slot, `/effort ${effort}\r`)) return 'skipped';
    lastWriteAt.set(threadId, deps.now());
    let next: ThreadPickRecord = {
      ...rec,
      // The write changes what is running; only a real desire changes what is wanted.
      intended: desire ? { ...rec.intended, effort: q.pick.effort } : rec.intended,
      launched: { ...base, effort },
      queue: null,
      source: desire ? q.source : rec.source,
      pendingSource: ownerAfterQueueConsumed(rec),
      lastBudgetLevel: levelAfter,
      // A held model pick stays visible in the readout: 'sent' would mask it until a confirmed report.
      outcome: rec.modelPending ? 'none' : 'sent',
    };
    if (q.trigger === 'budget') next = setPendingStepDown(next);
    deps.setRecord(threadId, next);
    line(base, next.launched ?? base, q.source, q.trigger, 'sent');
    return 'sent';
  }

  function reportOutcome(
    threadId: string,
    outcome: 'confirmed' | 'not-applied',
    actual: Pick | null = null,
  ): void {
    const rec = deps.getRecord(threadId);
    if (!rec) return;
    if (outcome === 'confirmed') {
      const next = clearPendingStepDown({ ...rec, lastConfirmed: { ...(rec.launched ?? rec.intended) }, outcome: 'confirmed' });
      deps.setRecord(threadId, next);
      line(rec.launched ?? rec.intended, rec.launched ?? rec.intended, rec.source, rec.trigger, 'confirmed');
      return;
    }
    if (rec.halted) return;
    deps.setRecord(threadId, markNotApplied(rec, rec.launched ?? rec.intended, actual));
    // A15 port level: notified regardless of awayMode().
    deps.notifyFailure({ threadId, wanted: { ...(rec.launched ?? rec.intended) }, actual });
    line(rec.launched ?? rec.intended, actual ?? rec.launched ?? rec.intended, rec.source, rec.trigger, 'not-applied');
  }

  function clearThreadHalt(threadId: string): void {
    const rec = deps.getRecord(threadId);
    if (rec) deps.setRecord(threadId, clearHalt(rec));
  }

  function readoutState(threadId: string, opts: { blocked?: boolean } = {}): ReadoutState | null {
    const rec = deps.getRecord(threadId);
    // No readback source is wired: 'sent' reads as 'unconfirmed', never 'applied'.
    return rec ? deriveReadoutState(rec, { ...opts, hasReadback: false }) : null;
  }

  return { onPick, onIdleCheck, reportOutcome, clearHalt: clearThreadHalt, readoutState };
}
