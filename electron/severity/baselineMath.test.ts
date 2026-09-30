import { describe, it, expect } from 'vitest';
import { medianOf, isAdmissibleSample, BASELINE_MIN_SAMPLES, BASELINE_WINDOW } from './baselineMath';

describe('medianOf', () => {
  it('needs 5 samples', () => {
    expect(BASELINE_MIN_SAMPLES).toBe(5);
    expect(medianOf([10, 20, 30, 40])).toBeNull();
    expect(medianOf([10, 20, 30, 40, 50])).toBe(30);
  });
  it('uses only the last 20 samples (oldest first in, oldest dropped)', () => {
    expect(BASELINE_WINDOW).toBe(20);
    const old = Array.from({ length: 20 }, () => 1_000_000);
    const recent = Array.from({ length: 20 }, () => 10);
    expect(medianOf([...old, ...recent])).toBe(10);
  });
  it('ignores zero, negative and non-finite entries', () => {
    expect(medianOf([0, 0, 0, -5, Number.NaN, 10, 20, 30, 40])).toBeNull();
    expect(medianOf([0, 10, 20, 30, 40, 50])).toBe(30);
  });
  it('even count averages the middle pair', () => {
    expect(medianOf([10, 20, 30, 40, 50, 60])).toBe(35);
  });
});

describe('isAdmissibleSample', () => {
  const usage = { tokens: 1, toolUses: 1, durationMs: 5000 };
  it('admits only completed outcomes with usage and durationMs > 0', () => {
    expect(isAdmissibleSample({ status: 'completed', usage })).toBe(true);
    expect(isAdmissibleSample({ status: 'completed' })).toBe(false);
    expect(isAdmissibleSample({ status: 'completed', usage: { ...usage, durationMs: 0 } })).toBe(false);
    expect(isAdmissibleSample({ status: 'failed', usage })).toBe(false);
    expect(isAdmissibleSample({ status: 'killed', usage })).toBe(false);
    expect(isAdmissibleSample({ status: 'unknown', usage })).toBe(false);
  });
});
