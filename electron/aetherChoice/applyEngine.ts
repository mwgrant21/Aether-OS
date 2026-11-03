// AetherChoice apply engine. Turns record changes into at most one `/effort <level>\r`
// write per confirmed-idle moment, entirely through injected ports (no fs, no pty, no
// clock of its own). Option R: it never emits /model; a model pick stays in modelPending.
import type { TerminalSlotId, TerminalWritePort } from '../../src/shared/remote/types';
import { LAUNCH_EFFORTS } from '../../src/shared/aetherChoice/types';
import type { Pick, PickSource, PickTrigger, ReadoutState } from '../../src/shared/aetherChoice/types';
import { LADDER_RUNGS, applyBudget } from '../../src/shared/aetherChoice/pickPolicy';
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
};

export type PickMetaIn = { reason: string; trigger: PickTrigger; source: PickSource };

const fmt = (p: Pick): string => `${p.model}/${p.effort}`;

export function createApplyEngine(deps: ApplyEngineDeps) {
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
    if (changed) line(rec.intended, pick, meta.source, meta.trigger, 'queued');
    return { rejected: null };
  }

  function onIdleCheck(threadId: string): 'sent' | 'skipped' {
    const rec = deps.getRecord(threadId);
    // Ruling 9b: zero bytes reach a halted slot.
    if (!rec || rec.halted || !rec.queue) return 'skipped';
    const slot = deps.slotFor(threadId);
    if (slot !== 'claude' && slot !== 'terminal2') return 'skipped';
    const q = rec.queue;
    // The running pick is the baseline; `intended` is the desired pick and may differ after a budget lowering.
    const base = rec.launched ?? rec.intended;
    // The queued model may be stale and the plan may have been budget-lowered since:
    // re-run the budget against the live model and the queued effort, and read only the effort.
    const b = applyBudget({ model: base.model, effort: q.pick.effort }, deps.usage(), q.source, rec.lastBudgetLevel);
    const effort = b.pick.effort;
    if (!(LAUNCH_EFFORTS as readonly string[]).includes(effort)) return 'skipped';
    if (effort === base.effort) {
      deps.setRecord(threadId, { ...rec, queue: null });
      return 'skipped';
    }
    const order = LAUNCH_EFFORTS as readonly string[];
    const stepDown = order.indexOf(effort) < order.indexOf(base.effort);
    const reading = deps.idle(slot);
    const midTurnOk = reading === 'generating' && q.trigger === 'budget' && stepDown;
    if (reading !== 'idle' && !midTurnOk) return 'skipped';
    if (!deps.writePort.write(slot, `/effort ${effort}\r`)) return 'skipped';
    let next: ThreadPickRecord = {
      ...rec,
      intended: { ...rec.intended, effort },
      launched: rec.launched ? { ...rec.launched, effort } : null,
      queue: null,
      source: q.source,
      pendingSource: rec.modelPending ? rec.pendingSource : null,
      outcome: 'sent',
    };
    if (q.trigger === 'budget') next = setPendingStepDown(next);
    deps.setRecord(threadId, next);
    line(rec.intended, next.intended, q.source, q.trigger, 'sent');
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
      line(rec.intended, rec.intended, rec.source, rec.trigger, 'confirmed');
      return;
    }
    if (rec.halted) return;
    deps.setRecord(threadId, markNotApplied(rec, rec.launched ?? rec.intended, actual));
    // A15 port level: notified regardless of awayMode().
    deps.notifyFailure({ threadId, wanted: { ...(rec.launched ?? rec.intended) }, actual });
    line(rec.intended, actual ?? rec.intended, rec.source, rec.trigger, 'not-applied');
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
