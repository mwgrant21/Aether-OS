// AetherChoice per-thread pick record. Pure: immutable records, no I/O, no clock
// (callers pass `now`), no prompt text. Option R: a model pick on a live thread
// is held in modelPending and never enters the apply queue.
import { LAUNCH_EFFORTS } from './types';
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
  intended: Pick;
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
  // Not live and not halted: nothing is running, so the pick simply becomes the intent.
  if (!rec.live && !rec.halted) {
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
  // Live (or halted): model part is held for the next resume, effort part is queued.
  // Latest wins: both pending slots are rebuilt from this submit alone.
  const modelPending = next.model !== rec.intended.model ? next.model : null;
  const effortChanged = next.effort !== rec.intended.effort;
  const queue: QueuedPick | null = effortChanged
    ? {
        pick: { model: rec.intended.model, effort: next.effort },
        reason: meta.reason,
        trigger: meta.trigger,
        source: meta.source,
        queuedAt: meta.now,
      }
    : null;
  return {
    record: {
      ...rec,
      queue,
      modelPending,
      pendingSource: queue || modelPending ? meta.source : null,
      reason: queue || modelPending ? meta.reason : rec.reason,
      trigger: queue || modelPending ? meta.trigger : rec.trigger,
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
  const folded: Pick = {
    model: rec.modelPending ?? rec.intended.model,
    effort: rec.queue?.pick.effort ?? rec.intended.effort,
  };
  const hasPending = rec.queue !== null || rec.modelPending !== null;
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

export function markLaunched(rec: ThreadPickRecord, plan: LaunchPlan): ThreadPickRecord {
  let { intended, queue, modelPending } = rec;
  if (modelPending !== null && modelPending === plan.model) {
    intended = { ...intended, model: modelPending };
    modelPending = null;
  }
  if (queue && queue.pick.effort === plan.effort) {
    intended = { ...intended, effort: queue.pick.effort };
    queue = null;
  }
  return {
    ...rec,
    live: true,
    lastLaunchedModel: plan.model,
    lastBudgetLevel: plan.budgetLevel,
    intended,
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

export function markNotApplied(
  rec: ThreadPickRecord,
  wanted: Pick,
  actual: Pick | null,
): ThreadPickRecord {
  return { ...rec, halted: { wanted: { ...wanted }, actual: actual ? { ...actual } : null }, outcome: 'not-applied' };
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
