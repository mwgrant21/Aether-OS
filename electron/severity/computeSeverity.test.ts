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
  it('a non-finite or negative elapsed (clock skew, bad subtraction) gives no slowness bump', () => {
    // Infinity > 3 * median is true on its own, so only the isFinite guard keeps this at 1.
    for (const e of [Number.POSITIVE_INFINITY, Number.NaN, -5000]) {
      expect(computeSeverity({ exit: 'ok', elapsedMs: e, medianMsAtEval: 100 }).severity).toBe(1);
    }
  });
  it('findingWeights: a 3 floors at 3, a 4 at 4, 1s and 2s do nothing, [] equals omitted', () => {
    expect(computeSeverity({ exit: 'ok', ...base, findingWeights: [1, 3] }).severity).toBe(3);
    expect(computeSeverity({ exit: 'ok', ...base, findingWeights: [4] }).severity).toBe(4);
    expect(computeSeverity({ exit: 'ok', ...base, findingWeights: [1, 2] }).severity).toBe(1);
    expect(computeSeverity({ exit: 'ok', ...base, findingWeights: [] })).toEqual(computeSeverity({ exit: 'ok', ...base }));
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

import { TOOL_ERROR_FLOOR } from './computeSeverity';
describe('tool-error floor (spike GO)', () => {
  it('completed with >= 3 tool errors -> floor 3; 2 errors -> no floor', () => {
    expect(TOOL_ERROR_FLOOR).toBe(3);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 1, medianMsAtEval: null, toolErrors: 3 }).severity).toBe(3);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 1, medianMsAtEval: null, toolErrors: 2 }).severity).toBe(1);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 1, medianMsAtEval: null, toolErrors: null }).severity).toBe(1);
  });
  it('never lifts killed above 2, never lowers failed', () => {
    expect(computeSeverity({ exit: 'killed', elapsedMs: 1, medianMsAtEval: null, toolErrors: 9 }).severity).toBe(2);
    expect(computeSeverity({ exit: 'error', elapsedMs: 1, medianMsAtEval: null, toolErrors: 9 }).severity).toBe(4);
  });
  it('ignores non-finite toolErrors', () => {
    expect(computeSeverity({ exit: 'ok', elapsedMs: 1, medianMsAtEval: null, toolErrors: Number.NaN }).severity).toBe(1);
  });
});
