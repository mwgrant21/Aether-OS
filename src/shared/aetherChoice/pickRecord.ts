// AetherChoice per-thread pick record. Pure: immutable records, no I/O, no clock
// (callers pass `now`), no prompt text. Option R: a model pick on a live thread
// is held in modelPending and never enters the apply queue.
import { LAUNCH_EFFORTS, MODEL_ALIASES } from './types';
import type {
  LaunchEffort,
  ModelAlias,
  Pick,
  PickSource,
  PickTrigger,
  ReadoutState,
} from './types';
import { LADDER_RUNGS, applyBudget, rejectAuto } from './pickPolicy';
import type { BudgetLevel } from './pickPolicy';

export type QueuedPick = {
  pick: Pick;
  reason: string;
  trigger: PickTrigger;
  source: PickSource;
  queuedAt: number;
};

export type HaltInfo = { wanted: Pick; actual: Pick | null };

export type ThreadPickRecord = {
  threadId: string;
  claudeVersion: string | null;
  live: boolean;
  /** The desired pick. A budget step-down is re-evaluated from it on every launch, never stored over it. */
  intended: Pick;
  /** The pick actually running: set at launch (after budget lowering) and by successful /effort writes. null until a launch; diffs run against `launched ?? intended`. */
  launched: Pick | null;
  lastConfirmed: Pick | null;
  lastLaunchedModel: ModelAlias | null;
  /** Budget level of the last launch; feeds applyBudget's hysteresis on the next one. */
  lastBudgetLevel: BudgetLevel;
  pendingStepDown: boolean;
  reason: string;
  trigger: PickTrigger;
  /** Source of `intended`. */
  source: PickSource;
  /** Effort part of a pending pick (latest wins). The model never goes here. */
  queue: QueuedPick | null;
  /** Model part of a pending pick: applies as --model at the next launch/resume. */
  modelPending: ModelAlias | null;
  /** Source of whatever is pending in queue/modelPending; null when nothing is. */
  pendingSource: PickSource | null;
  halted: HaltInfo | null;
  outcome: 'none' | 'sent' | 'confirmed' | 'not-applied';
};

export type PickMeta = { reason: string; trigger: PickTrigger; source: PickSource };

export function newRecord(
  threadId: string,
  pick: Pick,
  meta: PickMeta,
  claudeVersion: string | null = null,
): ThreadPickRecord {
  return {
    threadId,
    claudeVersion,
    live: false,
    intended: { ...pick },
    launched: null,
    lastConfirmed: null,
    lastLaunchedModel: null,
    lastBudgetLevel: 'none',
    pendingStepDown: false,
    reason: meta.reason,
    trigger: meta.trigger,
    source: meta.source,
    queue: null,
    modelPending: null,
    pendingSource: null,
    halted: null,
    outcome: 'none',
  };
}

export type SubmitResult = { record: ThreadPickRecord; rejected: string | null };

export function submitPick(
  rec: ThreadPickRecord,
  next: Pick,
  meta: PickMeta & { now: number },
): SubmitResult {
  if (meta.source === 'auto') {
    const r = rejectAuto(next);
    if (!r.ok) return { record: rec, rejected: r.reason };
    // An auto pick never overwrites a pending manual one.
    if (rec.pendingSource === 'manual') return { record: rec, rejected: 'pending manual pick wins' };
  }
  // A budget step-down is never a desire: it must not touch `intended` or the desired pending pick.
  const budgetSubmit = meta.source === 'auto' && meta.trigger === 'budget';
  const live = rec.live || rec.halted !== null;
  if (!live) {
    if (budgetSubmit) return { record: rec, rejected: null };
    // Nothing is running, so the pick simply becomes the intent.
    return {
      record: {
        ...rec,
        intended: { ...next },
        reason: meta.reason,
        trigger: meta.trigger,
        source: meta.source,
        queue: null,
        modelPending: null,
        pendingSource: null,
      },
      rejected: null,
    };
  }
  const base = rec.launched ?? rec.intended;
  if (budgetSubmit) {
    // A manual pick is never silently reverted: a budget step-down never touches a manual record (live matches launch, I4).
    if (rec.source === 'manual' || rec.pendingSource === 'manual') return { record: rec, rejected: null };
    // Effort only (Option R), and never over a pending desire. The engine re-runs the budget when it writes.
    if (rec.modelPending !== null || (rec.queue !== null && rec.queue.trigger !== 'budget')) {
      return { record: rec, rejected: null };
    }
    const queue: QueuedPick | null =
      next.effort !== base.effort
        ? { pick: { model: base.model, effort: next.effort }, reason: meta.reason, trigger: meta.trigger, source: meta.source, queuedAt: meta.now }
        : null;
    return {
      record: { ...rec, queue, pendingSource: queue ? meta.source : null, outcome: queue && rec.outcome === 'sent' ? 'none' : rec.outcome },
      rejected: null,
    };
  }
  // Live (or halted): a part that differs from the running pick is held (model, applies at the next
  // resume) or queued (effort). A part equal to the running pick needs nothing applied, so it becomes
  // `intended` now. Latest wins: both pending slots are rebuilt from this submit alone.
  let intended = rec.intended;
  let modelPending: ModelAlias | null = null;
  if (next.model !== base.model) modelPending = next.model;
  else if (next.model !== intended.model) intended = { ...intended, model: next.model };
  let queue: QueuedPick | null = null;
  if (next.effort !== base.effort) {
    queue = {
      pick: { model: base.model, effort: next.effort },
      reason: meta.reason,
      trigger: meta.trigger,
      source: meta.source,
      queuedAt: meta.now,
    };
  } else if (next.effort !== intended.effort) intended = { ...intended, effort: next.effort };
  const intendedChanged = intended !== rec.intended;
  const changed = intendedChanged || queue !== null || modelPending !== null;
  return {
    record: {
      ...rec,
      intended,
      queue,
      modelPending,
      pendingSource: queue || modelPending ? meta.source : null,
      // A new pending part supersedes an earlier sent write: the readout shows what waits now.
      outcome: (queue || modelPending) && rec.outcome === 'sent' ? 'none' : rec.outcome,
      // A manual submit is never silently reverted: it owns the record's source.
      source: meta.source === 'manual' || intendedChanged ? meta.source : rec.source,
      reason: changed ? meta.reason : rec.reason,
      trigger: changed ? meta.trigger : rec.trigger,
    },
    rejected: null,
  };
}

export type LaunchPlan = {
  model: ModelAlias;
  effort: LaunchEffort;
  resume: boolean;
  reasonSuffix: string;
  budgetLevel: BudgetLevel;
};

export type LaunchPlanError = { error: 'effort-not-launchable' };

function onLadder(p: Pick): boolean {
  return LADDER_RUNGS.some((r) => r.model === p.model && r.effort === p.effort);
}

export function planLaunch(
  rec: ThreadPickRecord,
  usage: { sessionPct: number; weekPct: number },
): LaunchPlan | LaunchPlanError {
  // A budget-queued effort is a step-down in flight, not a desire: it never enters the plan.
  const desiredQueue = rec.queue && rec.queue.trigger !== 'budget' ? rec.queue : null;
  const folded: Pick = {
    model: rec.modelPending ?? rec.intended.model,
    effort: desiredQueue?.pick.effort ?? rec.intended.effort,
  };
  const hasPending = desiredQueue !== null || rec.modelPending !== null;
  const source = hasPending && rec.pendingSource ? rec.pendingSource : rec.source;
  // applyBudget only understands ladder picks; anything else is left untouched.
  const budgetSource: PickSource = source === 'auto' && !onLadder(folded) ? 'manual' : source;
  const b = applyBudget(folded, usage, budgetSource, rec.lastBudgetLevel);
  if (!(LAUNCH_EFFORTS as readonly string[]).includes(b.pick.effort)) {
    return { error: 'effort-not-launchable' };
  }
  const reasonSuffix = b.reason + (b.banner ? ' (banner)' : '');
  return {
    model: b.pick.model,
    effort: b.pick.effort,
    resume: rec.lastLaunchedModel !== null,
    reasonSuffix,
    budgetLevel: b.level,
  };
}

/**
 * `launched` records what actually started (after any budget lowering); `intended` stays the
 * desired pick and only advances for a pending part the launch consumed. A consumed pending
 * pick hands its source to the record.
 */
export function markLaunched(rec: ThreadPickRecord, plan: LaunchPlan): ThreadPickRecord {
  let { intended, queue, modelPending } = rec;
  let consumed = false;
  if (modelPending !== null && modelPending === plan.model) {
    intended = { ...intended, model: modelPending };
    modelPending = null;
    consumed = true;
  }
  if (queue && queue.trigger === 'budget') {
    // The plan re-evaluates the budget itself; a queued step-down is stale and never becomes intent.
    queue = null;
  } else if (queue && queue.pick.effort === plan.effort) {
    intended = { ...intended, effort: queue.pick.effort };
    queue = null;
    consumed = true;
  }
  return {
    ...rec,
    live: true,
    lastLaunchedModel: plan.model,
    lastBudgetLevel: plan.budgetLevel,
    intended,
    launched: { model: plan.model, effort: plan.effort },
    source: consumed && rec.pendingSource ? rec.pendingSource : rec.source,
    queue,
    modelPending,
    pendingSource: queue || modelPending ? rec.pendingSource : null,
  };
}

/** Keeps queue and modelPending (A4). */
export function markExited(rec: ThreadPickRecord): ThreadPickRecord {
  return { ...rec, live: false };
}

export function setPendingStepDown(rec: ThreadPickRecord): ThreadPickRecord {
  return { ...rec, pendingStepDown: true };
}

export function clearPendingStepDown(rec: ThreadPickRecord): ThreadPickRecord {
  return { ...rec, pendingStepDown: false };
}

function isLaunchablePick(p: Pick): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(p.model) && (LAUNCH_EFFORTS as readonly string[]).includes(p.effort);
}

export function markNotApplied(
  rec: ThreadPickRecord,
  wanted: Pick,
  actual: Pick | null,
): ThreadPickRecord {
  // A reported actual pick is what is really running: it replaces the optimistic `launched`.
  // `intended` stays, so an explicit retry of the desired pick queues again. An unlaunchable actual is ignored.
  // Only a launchable actual is stored (the pick store rejects any other and would drop the whole record).
  const known: Pick | null = actual !== null && isLaunchablePick(actual) ? { model: actual.model, effort: actual.effort } : null;
  return {
    ...rec,
    launched: known ? { ...known } : rec.launched,
    halted: { wanted: { ...wanted }, actual: known },
    outcome: 'not-applied',
  };
}

/** Only clears the halt; the explicit clear is the caller's decision. */
export function clearHalt(rec: ThreadPickRecord): ThreadPickRecord {
  return { ...rec, halted: null };
}

export function deriveReadoutState(
  rec: ThreadPickRecord,
  opts: { blocked?: boolean; hasReadback?: boolean } = {},
): ReadoutState {
  if (rec.halted) return 'notApplied';
  if (opts.blocked) return 'blocked';
  if (rec.outcome === 'sent') return opts.hasReadback === false ? 'unconfirmed' : 'applying';
  if (rec.queue) return 'queued';
  if (rec.modelPending) return 'queuedModel';
  return 'steady';
}
