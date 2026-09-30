import { describe, it, expect } from 'vitest';
import { computeSeverity, exitStateForStatus, SLOW_FACTOR } from './computeSeverity';

const base = { elapsedMs: 1000, medianMsAtEval: null };

describe('computeSeverity (spec section 3 table)', () => {
  it('completed, normal -> ok, 1', () => {
    expect(computeSeverity({ exit: 'ok', ...base }).severity).toBe(1);
  });
  it('completed and slow (elapsed > 3x established median) -> 2', () => {
    expect(SLOW_FACTOR).toBe(3);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 301, medianMsAtEval: 100 }).severity).toBe(2);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 300, medianMsAtEval: 100 }).severity).toBe(1);
  });
  it('slowness alone is capped at 2, however slow', () => {
    expect(computeSeverity({ exit: 'ok', elapsedMs: 10_000_000, medianMsAtEval: 1 }).severity).toBe(2);
  });
  it('failed -> error, 4', () => {
    const r = computeSeverity({ exit: exitStateForStatus('failed'), ...base });
    expect(r.exitState).toBe('error');
    expect(r.severity).toBe(4);
  });
  it('killed -> killed, 2 (even when slow, and never above 2)', () => {
    expect(exitStateForStatus('killed')).toBe('killed');
    expect(computeSeverity({ exit: 'killed', ...base }).severity).toBe(2);
    expect(computeSeverity({ exit: 'killed', elapsedMs: 9_999, medianMsAtEval: 1 }).severity).toBe(2);
    expect(computeSeverity({ exit: 'killed', ...base, findingWeights: [4] }).severity).toBe(2);
  });
  it('stalled -> fatal, 4', () => {
    expect(computeSeverity({ exit: 'fatal', ...base }).severity).toBe(4);
  });
  it('unknown status -> ok, 1 (never guess a failure)', () => {
    expect(exitStateForStatus('unknown')).toBe('ok');
    expect(computeSeverity({ exit: exitStateForStatus('unknown'), ...base }).severity).toBe(1);
  });
  it('completed maps to ok', () => {
    expect(exitStateForStatus('completed')).toBe('ok');
  });
  it('unused exit values keep their section-4 floors', () => {
    expect(computeSeverity({ exit: 'partial', ...base }).severity).toBe(2);
    expect(computeSeverity({ exit: 'timeout', ...base }).severity).toBe(3);
    expect(computeSeverity({ exit: 'blocked', ...base }).severity).toBe(4);
  });
  it('negative elapsed (clock skew) gives no slowness bump', () => {
    expect(computeSeverity({ exit: 'ok', elapsedMs: -5000, medianMsAtEval: 100 }).severity).toBe(1);
  });
  it('an unusable median (0, negative, NaN) is treated as unestablished', () => {
    for (const m of [0, -1, Number.NaN]) {
      const r = computeSeverity({ exit: 'ok', elapsedMs: 1e9, medianMsAtEval: m });
      expect(r.severity).toBe(1);
      expect(r.medianMs).toBeNull();
    }
  });
  it('result carries exactly severity, exitState, elapsedMs, medianMs (no text)', () => {
    const r = computeSeverity({ exit: 'ok', elapsedMs: 840000, medianMsAtEval: 240000 });
    expect(Object.keys(r).sort()).toEqual(['elapsedMs', 'exitState', 'medianMs', 'severity']);
    expect(r).toEqual({ severity: 2, exitState: 'ok', elapsedMs: 840000, medianMs: 240000 });
  });
});
