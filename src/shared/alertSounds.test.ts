import { describe, expect, it } from 'vitest';
import { decideAlertActions } from './alertSounds';

function snap(alarmLevel: 'ok' | 'warn' | 'crit', anomalyCount = 0) {
  return { alarmLevel, anomalyCount };
}

describe('decideAlertActions', () => {
  it('plays yellow chirp on ok -> warn', () => {
    expect(decideAlertActions(snap('ok'), snap('warn'))).toEqual([{ kind: 'playYellow' }]);
  });

  it('starts red loop on warn -> crit, with no yellow re-fire', () => {
    expect(decideAlertActions(snap('warn'), snap('crit'))).toEqual([{ kind: 'startRed' }]);
  });

  it('starts red loop on ok -> crit (skips warn in one tick)', () => {
    expect(decideAlertActions(snap('ok'), snap('crit'))).toEqual([{ kind: 'startRed' }]);
  });

  it('stops red loop on crit -> warn', () => {
    expect(decideAlertActions(snap('crit'), snap('warn'))).toEqual([{ kind: 'stopRed' }]);
  });

  it('stops red loop on crit -> ok', () => {
    expect(decideAlertActions(snap('crit'), snap('ok'))).toEqual([{ kind: 'stopRed' }]);
  });

  it('plays nothing on warn -> ok (de-escalation to ok is silent)', () => {
    expect(decideAlertActions(snap('warn'), snap('ok'))).toEqual([]);
  });

  it('plays nothing when the alarm level does not change', () => {
    expect(decideAlertActions(snap('ok'), snap('ok'))).toEqual([]);
    expect(decideAlertActions(snap('warn'), snap('warn'))).toEqual([]);
    expect(decideAlertActions(snap('crit'), snap('crit'))).toEqual([]);
  });

  it('plays the anomaly chime on a 0 -> N>0 transition', () => {
    expect(decideAlertActions(snap('ok', 0), snap('ok', 1))).toEqual([{ kind: 'playAnomalyChime' }]);
    expect(decideAlertActions(snap('ok', 0), snap('ok', 3))).toEqual([{ kind: 'playAnomalyChime' }]);
  });

  it('does not re-fire the chime on N>0 -> M>0', () => {
    expect(decideAlertActions(snap('ok', 1), snap('ok', 3))).toEqual([]);
  });

  it('does not fire the chime on N>0 -> 0', () => {
    expect(decideAlertActions(snap('ok', 2), snap('ok', 0))).toEqual([]);
  });

  it('combines an alarm-level action with the anomaly chime in the same tick', () => {
    expect(decideAlertActions(snap('ok', 0), snap('crit', 1))).toEqual([
      { kind: 'startRed' },
      { kind: 'playAnomalyChime' },
    ]);
  });
});
