import { describe, expect, it } from 'vitest';
import { applyCost, fillDailyGaps, localDay } from './costing';
import { costForEvent } from '../modelPricing';
import { blendedRateForModel } from '../ledgerMath';

const ev = (day: string, model: string | null, i = 1000, o = 500, cw = 0, cr = 0) => ({
  day, model, input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});
const EXACT_COLS = ['day', 'model', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const price = (model: string, i: number, o: number) =>
  costForEvent({ model, usage: { inputTokens: i, outputTokens: o, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } });

describe('applyCost exact', () => {
  it('sums usd per group in first-seen order', () => {
    const r = applyCost(EXACT_COLS, [ev('2026-10-01', 'claude-opus-5-5'), ev('2026-10-02', 'claude-opus-5-5'), ev('2026-10-01', 'claude-sonnet-5-5', 10, 10)], { basis: 'exact', groupBy: 'day' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.columns).toEqual(['day', 'usd']);
    expect(r.rows[0].day).toBe('2026-10-01');
    expect(r.rows[0].usd).toBeCloseTo(price('claude-opus-5-5', 1000, 500) + price('claude-sonnet-5-5', 10, 10), 10);
    expect(r.rows[1].usd).toBeCloseTo(price('claude-opus-5-5', 1000, 500), 10);
    expect(r.unpricedRows).toBe(0);
  });

  it('excludes and counts rows with no model; a group of only those is null, not 0', () => {
    const r = applyCost(EXACT_COLS, [ev('2026-10-01', null), ev('2026-10-02', 'claude-opus-5-5')], { basis: 'exact', groupBy: 'day' });
    expect(r.ok && r.unpricedRows).toBe(1);
    expect(r.ok && r.rows[0].usd).toBeNull();
  });

  it('a model row whose token sums are null is unpriced, not $0', () => {
    const nullSums = { day: '2026-10-01', model: 'claude-opus-5-5', input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null };
    const r = applyCost(EXACT_COLS, [nullSums], { basis: 'exact', groupBy: 'day' });
    expect(r.ok && r.rows[0].usd).toBeNull();
    expect(r.ok && r.unpricedRows).toBe(1);
  });

  it('names missing columns', () => {
    const r = applyCost(['day', 'model'], [], { basis: 'exact', groupBy: 'day' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('input_tokens');
  });
});

describe('applyCost estimated', () => {
  it('prices tokens at the default blended rate into usdApprox; null tokens are unpriced', () => {
    const r = applyCost(['day', 'tokens'], [{ day: 'd1', tokens: 1_000_000 }, { day: 'd1', tokens: null }], { basis: 'estimated', groupBy: 'day' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.columns).toEqual(['day', 'usdApprox']);
    expect(r.rows[0].usdApprox).toBeCloseTo(blendedRateForModel(null), 10);
    expect(r.unpricedRows).toBe(1);
  });
});

describe('fillDailyGaps', () => {
  const now = new Date(2026, 9, 5, 12).getTime(); // 2026-10-05 local noon
  const since = new Date(2026, 9, 3, 12).getTime();

  it('adds null rows for missing days across the range', () => {
    const rows = fillDailyGaps('day', ['usd'], [{ day: '2026-10-04', usd: 1 }], since, now);
    expect(rows).toEqual([
      { day: '2026-10-03', usd: null },
      { day: '2026-10-04', usd: 1 },
      { day: '2026-10-05', usd: null },
    ]);
  });

  it('leaves non-day x values and duplicate days untouched', () => {
    const cats = [{ day: 'Read', usd: 1 }];
    expect(fillDailyGaps('day', ['usd'], cats, since, now)).toBe(cats);
    const dup = [{ day: '2026-10-04', usd: 1 }, { day: '2026-10-04', usd: 2 }];
    expect(fillDailyGaps('day', ['usd'], dup, since, now)).toBe(dup);
  });

  it('an empty result is not gap-filled', () => {
    expect(fillDailyGaps('tool_name', ['calls'], [], since, now)).toEqual([]);
  });

  it('localDay formats local dates', () => {
    expect(localDay(now)).toBe('2026-10-05');
  });
});
