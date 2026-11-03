// AetherChoice pick policy. Pure: no I/O, no clock, no signal detection.
import { MANUAL_ONLY_EFFORTS, MODEL_ALIASES } from './types';
import type { Pick, PickSource, PickTrigger, TaskClass } from './types';

export type BudgetLevel = 'none' | 'step' | 'floor';

/** ASSUMPTION: the kit says "with hysteresis" without a number. */
export const HYSTERESIS_POINTS = 5;
export const STEP_SESSION_PCT = 70;
export const STEP_WEEK_PCT = 75;
export const FLOOR_PCT = 90;

/** Budget rungs, low to high. */
export const LADDER_RUNGS: readonly Pick[] = [
  { model: 'haiku', effort: 'low' },
  { model: 'sonnet', effort: 'medium' },
  { model: 'sonnet', effort: 'high' },
  { model: 'opus', effort: 'high' },
];

export function ladderPick(taskClass: TaskClass, opts: { opusUnlocked: boolean }): Pick {
  if (taskClass === 'mechanical') return { model: 'haiku', effort: 'low' };
  if (opts.opusUnlocked) return { model: 'opus', effort: 'high' };
  if (taskClass === 'judgment') return { model: 'sonnet', effort: 'high' };
  return { model: 'sonnet', effort: 'medium' };
}

export function rejectAuto(
  pick: { model: string; effort: string },
): { ok: true } | { ok: false; reason: string } {
  if (!(MODEL_ALIASES as readonly string[]).includes(pick.model)) {
    return { ok: false, reason: `model ${pick.model} is not auto-pickable` };
  }
  if ((MANUAL_ONLY_EFFORTS as readonly string[]).includes(pick.effort)) {
    return { ok: false, reason: `effort ${pick.effort} is manual-only` };
  }
  return { ok: true };
}

export type MissSignal =
  | 'test-failed-after-done'
  | 're-ask-within-3-turns'
  | 'stop-then-reprompt'
  | 'thumbs-down'
  | 'phrase-wrong'
  | 'phrase-try-again'
  | 'new-request'
  | 'direction-change'
  | 'agent-self-reported-failure';

const MISSES: readonly MissSignal[] = [
  'test-failed-after-done',
  're-ask-within-3-turns',
  'stop-then-reprompt',
  'thumbs-down',
  'phrase-wrong',
  'phrase-try-again',
];

export type MissCounter = { taskClass: TaskClass; count: number };

export const OPUS_UNLOCK_MISSES = 2;

export function isMiss(signal: MissSignal): boolean {
  return MISSES.includes(signal);
}

export function registerMiss(
  counter: MissCounter,
  taskClass: TaskClass,
  signal: MissSignal,
): MissCounter {
  if (counter.taskClass !== taskClass) return { taskClass, count: 0 };
  return isMiss(signal) ? { taskClass, count: counter.count + 1 } : counter;
}

export function opusUnlocked(counter: MissCounter): boolean {
  return counter.count >= OPUS_UNLOCK_MISSES;
}

export type BudgetResult = { pick: Pick; level: BudgetLevel; banner: boolean; reason: string };

function budgetLevel(
  usage: { sessionPct: number; weekPct: number },
  prev: BudgetLevel,
): BudgetLevel {
  const { sessionPct: s, weekPct: w } = usage;
  const h = HYSTERESIS_POINTS;
  if (s >= FLOOR_PCT || w >= FLOOR_PCT) return 'floor';
  if (prev === 'floor' && (s >= FLOOR_PCT - h || w >= FLOOR_PCT - h)) return 'floor';
  if (s >= STEP_SESSION_PCT || w >= STEP_WEEK_PCT) return 'step';
  if (prev !== 'none' && (s >= STEP_SESSION_PCT - h || w >= STEP_WEEK_PCT - h)) return 'step';
  return 'none';
}

/**
 * prevLevel is the level this thread was last at; it enables hysteresis on recovery.
 * Manual picks are never changed.
 */
export function applyBudget(
  pick: Pick,
  usage: { sessionPct: number; weekPct: number },
  source: PickSource,
  prevLevel: BudgetLevel = 'none',
): BudgetResult {
  const level = budgetLevel(usage, prevLevel);
  if (source === 'manual' || level === 'none') {
    return { pick, level: source === 'manual' ? 'none' : level, banner: false, reason: '' };
  }
  if (level === 'floor') {
    return {
      pick: { model: 'haiku', effort: 'low' },
      level,
      banner: true,
      reason: 'budget floor: session or week at 90%',
    };
  }
  const idx = LADDER_RUNGS.findIndex((r) => r.model === pick.model && r.effort === pick.effort);
  const sessionHit =
    usage.sessionPct >= STEP_SESSION_PCT ||
    (prevLevel !== 'none' && usage.sessionPct >= STEP_SESSION_PCT - HYSTERESIS_POINTS);
  const trigger = sessionHit ? 'session 70%' : 'week 75%';
  const reason = `budget step-down: ${trigger}`;
  if (idx <= 0) return { pick, level, banner: false, reason };
  return { pick: { ...LADDER_RUNGS[idx - 1] }, level, banner: false, reason };
}

export function shouldRepick(
  prev: { taskClass: TaskClass; budgetLevel: BudgetLevel },
  next: {
    taskClass: TaskClass;
    budgetLevel: BudgetLevel;
    trigger: PickTrigger | null;
    turnInFlight: boolean;
  },
): boolean {
  if (next.turnInFlight || next.trigger === null) return false;
  switch (next.trigger) {
    case 'new-thread':
    case 'miss':
    case 'think-harder':
      return true;
    case 'task-class':
      return prev.taskClass !== next.taskClass;
    case 'budget':
      return prev.budgetLevel !== next.budgetLevel;
    case 'manual':
      return false;
  }
}
