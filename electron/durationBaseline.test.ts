import { describe, it, expect } from 'vitest';
import { createDurationBaseline, getMedianMs, recordDuration } from './durationBaseline';

describe('durationBaseline', () => {
  it('returns null for a key with no recorded samples yet', () => {
    const baseline = createDurationBaseline();
    expect(getMedianMs(baseline, 'code-reviewer')).toBeNull();
  });

  it('computes the median of recorded durations for a key', () => {
    const baseline = createDurationBaseline();
    recordDuration(baseline, 'code-reviewer', 1000);
    recordDuration(baseline, 'code-reviewer', 2000);
    recordDuration(baseline, 'code-reviewer', 3000);
    expect(getMedianMs(baseline, 'code-reviewer')).toBe(2000);
  });

  it('averages the two middle values for an even sample count', () => {
    const baseline = createDurationBaseline();
    recordDuration(baseline, 'code-reviewer', 1000);
    recordDuration(baseline, 'code-reviewer', 3000);
    expect(getMedianMs(baseline, 'code-reviewer')).toBe(2000);
  });

  it('keeps separate baselines per key', () => {
    const baseline = createDurationBaseline();
    recordDuration(baseline, 'code-reviewer', 1000);
    recordDuration(baseline, 'general-purpose', 9000);
    expect(getMedianMs(baseline, 'code-reviewer')).toBe(1000);
    expect(getMedianMs(baseline, 'general-purpose')).toBe(9000);
  });

  it('caps retained samples at 20, evicting the oldest first', () => {
    const baseline = createDurationBaseline();
    for (let i = 1; i <= 21; i++) recordDuration(baseline, 'k', i * 100);
    // Oldest sample (100) should have been evicted; median of 200..2100 step 100 (20 values) is (1100+1200)/2
    expect(getMedianMs(baseline, 'k')).toBe(1150);
  });

  it('a snapshot taken before recording never includes the run that just finished', () => {
    const baseline = createDurationBaseline();
    recordDuration(baseline, 'k', 1000);
    const before = getMedianMs(baseline, 'k');
    recordDuration(baseline, 'k', 999_999);
    expect(before).toBe(1000);
    expect(getMedianMs(baseline, 'k')).not.toBe(1000);
  });
});
