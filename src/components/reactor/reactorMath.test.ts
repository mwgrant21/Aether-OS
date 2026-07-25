import { describe, expect, it } from 'vitest';
import { advancePhase, computeDispatchIntensity, computePulseDuration, computeRateFromUsage, computeSurge, computeThemeFilter, computeThemeHueDeg } from './reactorMath';

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

  it('overload adds a hue shift on top of the base theme', () => {
    const base = computeThemeHueDeg('cyan', 'ok', false);
    const overloaded = computeThemeHueDeg('cyan', 'ok', true);
    expect(overloaded).not.toBe(base);
  });

  it('overload layers on top of an active alarm level rather than being overridden by it', () => {
    const warnOnly = computeThemeHueDeg('cyan', 'warn', false);
    const warnAndOverload = computeThemeHueDeg('cyan', 'warn', true);
    expect(warnAndOverload).not.toBe(warnOnly);
  });

  it('defaults to no overload shift when the parameter is omitted', () => {
    expect(computeThemeHueDeg('cyan', 'ok')).toBe(computeThemeHueDeg('cyan', 'ok', false));
  });
});

describe('computeThemeFilter', () => {
  it('builds a hue-rotate string, appending desaturation when glowFx is off', () => {
    expect(computeThemeFilter('cyan', 'ok', true)).toBe('hue-rotate(0deg)');
    expect(computeThemeFilter('cyan', 'ok', false)).toBe('hue-rotate(0deg) saturate(.75) brightness(.92)');
  });

  it('overload changes the filter string even when alarmLevel and glowFx are unchanged', () => {
    const base = computeThemeFilter('cyan', 'ok', true, false);
    const overloaded = computeThemeFilter('cyan', 'ok', true, true);
    expect(overloaded).not.toBe(base);
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

describe('computeRateFromUsage', () => {
  it('falls back to the idle baseline when burn rate is zero', () => {
    expect(computeRateFromUsage(0)).toBe(92000);
  });

  it('falls back to the idle baseline for a negative burn rate', () => {
    expect(computeRateFromUsage(-500)).toBe(92000);
  });

  it('passes through a burn rate already inside the visual range', () => {
    expect(computeRateFromUsage(92000)).toBe(92000);
    expect(computeRateFromUsage(50000)).toBe(50000);
  });

  it('clamps a burn rate below the visual floor', () => {
    expect(computeRateFromUsage(5000)).toBe(20000);
  });

  it('clamps a burn rate above the visual ceiling', () => {
    expect(computeRateFromUsage(400000)).toBe(168000);
  });
});

describe('computeDispatchIntensity', () => {
  it('is neither overdrive nor overload with 0 or 1 concurrent dispatches', () => {
    expect(computeDispatchIntensity(0)).toEqual({ overdrive: false, overload: false, glowMultiplier: 1 });
    expect(computeDispatchIntensity(1)).toEqual({ overdrive: false, overload: false, glowMultiplier: 1 });
  });

  it('is overdrive but not overload at exactly 2 concurrent dispatches', () => {
    expect(computeDispatchIntensity(2)).toEqual({ overdrive: true, overload: false, glowMultiplier: 1 });
  });

  it('is both overdrive and overload at 3 or more concurrent dispatches', () => {
    expect(computeDispatchIntensity(3)).toEqual({ overdrive: true, overload: true, glowMultiplier: 1.25 });
    expect(computeDispatchIntensity(9)).toEqual({ overdrive: true, overload: true, glowMultiplier: 1.25 });
  });
});
