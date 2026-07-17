import { describe, expect, it } from 'vitest';
import { advancePhase, computePulseDuration, computeSurge, computeThemeFilter, computeThemeHueDeg } from './reactorMath';

describe('computePulseDuration', () => {
  it('shortens as burn rate rises in live mode', () => {
    const low = computePulseDuration(28000, 'live', 'ok');
    const high = computePulseDuration(168000, 'live', 'ok');
    expect(low).toBeCloseTo(2.9, 5);
    expect(high).toBeCloseTo(0.8, 5);
    expect(high).toBeLessThan(low);
  });

  it('ambient mode ignores rate and stays at 2.4s', () => {
    expect(computePulseDuration(28000, 'ambient', 'ok')).toBe(2.4);
    expect(computePulseDuration(168000, 'ambient', 'ok')).toBe(2.4);
  });

  it('crit alarm clamps duration to at most 1.0s even in ambient mode logic paths', () => {
    expect(computePulseDuration(28000, 'live', 'crit')).toBeLessThanOrEqual(1.0);
  });
});

describe('computeThemeHueDeg', () => {
  it('maps each theme name to its degree offset', () => {
    expect(computeThemeHueDeg('cyan', 'ok')).toBe(0);
    expect(computeThemeHueDeg('blue', 'ok')).toBe(30);
    expect(computeThemeHueDeg('teal', 'ok')).toBe(-25);
    expect(computeThemeHueDeg('violet', 'ok')).toBe(75);
    expect(computeThemeHueDeg('amber', 'ok')).toBe(-150);
    expect(computeThemeHueDeg('red', 'ok')).toBe(165);
  });

  it('alarm level overrides the chosen theme', () => {
    expect(computeThemeHueDeg('cyan', 'warn')).toBe(-150);
    expect(computeThemeHueDeg('violet', 'crit')).toBe(165);
  });
});

describe('computeThemeFilter', () => {
  it('builds a hue-rotate string, appending desaturation when glowFx is off', () => {
    expect(computeThemeFilter('cyan', 'ok', true)).toBe('hue-rotate(0deg)');
    expect(computeThemeFilter('cyan', 'ok', false)).toBe('hue-rotate(0deg) saturate(.75) brightness(.92)');
  });
});

describe('advancePhase', () => {
  it('advances by dt/duration and wraps past 1', () => {
    expect(advancePhase(0, 1, 2)).toBeCloseTo(0.5, 5);
    expect(advancePhase(0.9, 0.5, 1)).toBeCloseTo(0.4, 5);
  });
});

describe('computeSurge', () => {
  it('is 1 at phase 0 and decays monotonically', () => {
    expect(computeSurge(0)).toBe(1);
    expect(computeSurge(0.5)).toBeLessThan(computeSurge(0.1));
    expect(computeSurge(1)).toBeLessThan(computeSurge(0.5));
  });
});
