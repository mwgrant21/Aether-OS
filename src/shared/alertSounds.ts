import type { AlarmLevel } from '../state/types';

export type AlertAction =
  | { kind: 'playYellow' }
  | { kind: 'startRed' }
  | { kind: 'stopRed' }
  | { kind: 'playAnomalyChime' };

export interface AlertSnapshot {
  alarmLevel: AlarmLevel;
  anomalyCount: number;
}

export function decideAlertActions(prev: AlertSnapshot, next: AlertSnapshot): AlertAction[] {
  const actions: AlertAction[] = [];

  if (next.alarmLevel !== prev.alarmLevel) {
    if (next.alarmLevel === 'crit') {
      actions.push({ kind: 'startRed' });
    } else if (next.alarmLevel === 'warn' && prev.alarmLevel === 'crit') {
      actions.push({ kind: 'stopRed' });
    } else if (next.alarmLevel === 'warn') {
      actions.push({ kind: 'playYellow' });
    } else if (next.alarmLevel === 'ok' && prev.alarmLevel === 'crit') {
      actions.push({ kind: 'stopRed' });
    }
    // warn -> ok is intentionally silent (matches tick.ts's existing
    // notification logic, which also only reacts to level !== 'ok').
  }

  if (prev.anomalyCount === 0 && next.anomalyCount > 0) {
    actions.push({ kind: 'playAnomalyChime' });
  }

  return actions;
}
