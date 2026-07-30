import { describe, expect, it } from 'vitest';
import {
  advancePhase,
  computeCacheClarity,
  computeConcurrencyTurbulence,
  computeDispatchIntensity,
  computeModelHueShift,
  computeMomentum,
  computePulseDuration,
  computeSurge,
  computeThemeFilter,
  computeThemeHueDeg,
  dominantModel,
} from './reactorMath';

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

  it('the 4-arg call form is unchanged (modelHueShift defaults to 0)', () => {
    expect(computeThemeFilter('cyan', 'ok', true)).toBe('hue-rotate(0deg)');
    expect(computeThemeFilter('violet', 'warn', false, true)).toBe(
      computeThemeFilter('violet', 'warn', false, true, 0)
    );
  });

  it('a 5th-arg modelHueShift shifts the hue on top of the existing shifts', () => {
    expect(computeThemeFilter('cyan', 'ok', true, false, -60)).toBe('hue-rotate(-60deg)');
    expect(computeThemeFilter('cyan', 'ok', true, true, 90)).toBe('hue-rotate(130deg) brightness(1.15)');
  });
});

describe('computeCacheClarity', () => {
  it('maps 0 to the clarity floor and 1 to full clarity', () => {
    expect(computeCacheClarity(0)).toBe(0.6);
    expect(computeCacheClarity(1)).toBe(1);
  });

  it('clamps out-of-range inputs', () => {
    expect(computeCacheClarity(-1)).toBe(0.6);
    expect(computeCacheClarity(2)).toBe(1);
  });

  it('maps the midpoint linearly', () => {
    expect(computeCacheClarity(0.5)).toBeCloseTo(0.8, 5);
  });
});

describe('computeConcurrencyTurbulence', () => {
  it('is 0 with no real agents', () => {
    expect(computeConcurrencyTurbulence(0)).toBe(0);
  });

  it('saturates at 1 once realAgentCount reaches 4', () => {
    expect(computeConcurrencyTurbulence(4)).toBe(1);
    expect(computeConcurrencyTurbulence(9)).toBe(1);
  });

  it('scales linearly below the saturation point', () => {
    expect(computeConcurrencyTurbulence(2)).toBeCloseTo(0.5, 5);
  });
});

describe('dominantModel', () => {
  it('returns null for an empty list', () => {
    expect(dominantModel([])).toBeNull();
  });

  it('ignores null models', () => {
    expect(dominantModel([{ model: null }, { model: null }])).toBeNull();
  });

  it('picks the majority model in a 3-vs-1 split', () => {
    const agents = [
      { model: 'claude-sonnet-5' },
      { model: 'claude-sonnet-5' },
      { model: 'claude-sonnet-5' },
      { model: 'claude-haiku-4-5' },
    ];
    expect(dominantModel(agents)).toBe('claude-sonnet-5');
  });
});

describe('computeModelHueShift', () => {
  it('shifts haiku cool and opus warm', () => {
    expect(computeModelHueShift('claude-haiku-4-5-x')).toBe(-60);
    expect(computeModelHueShift('claude-opus-4-5')).toBe(90);
  });

  it('shifts fable and leaves sonnet unshifted', () => {
    expect(computeModelHueShift('claude-fable-1')).toBe(200);
    expect(computeModelHueShift('claude-sonnet-5')).toBe(0);
  });

  it('returns 0 for null or unrecognized models', () => {
    expect(computeModelHueShift(null)).toBe(0);
    expect(computeModelHueShift('some-other-model')).toBe(0);
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

describe('computeMomentum', () => {
  it('reads as the idle baseline with zero samples', () => {
    expect(computeMomentum([])).toBe(92000);
  });

  it('reads as the idle baseline with fewer than 3 samples (insufficient history)', () => {
    expect(computeMomentum([{ burnRatePerMin: 9000, atMs: 1 }, { burnRatePerMin: 100, atMs: 2 }])).toBe(92000);
  });

  it('reads as the idle baseline when burn rate is flat across the window', () => {
    const history = [
      { burnRatePerMin: 4000, atMs: 1 },
      { burnRatePerMin: 4000, atMs: 2 },
      { burnRatePerMin: 4000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(92000);
  });

  it('rises toward the visual ceiling as burn rate climbs across the window', () => {
    const history = [
      { burnRatePerMin: 1000, atMs: 1 },
      { burnRatePerMin: 4000, atMs: 2 },
      { burnRatePerMin: 7000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(168000);
  });

  it('falls toward the visual floor as burn rate drops across the window', () => {
    const history = [
      { burnRatePerMin: 7000, atMs: 1 },
      { burnRatePerMin: 4000, atMs: 2 },
      { burnRatePerMin: 1000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(20000);
  });

  it('clamps a rise steeper than the momentum range to the visual ceiling', () => {
    const history = [
      { burnRatePerMin: 0, atMs: 1 },
      { burnRatePerMin: 50000, atMs: 2 },
      { burnRatePerMin: 100000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(168000);
  });

  it('only considers the most recent 3 samples when more are present', () => {
    const history = [
      { burnRatePerMin: 9000, atMs: 0 }, // older sample outside the window, must be ignored
      { burnRatePerMin: 1000, atMs: 1 },
      { burnRatePerMin: 4000, atMs: 2 },
      { burnRatePerMin: 7000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(168000);
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
