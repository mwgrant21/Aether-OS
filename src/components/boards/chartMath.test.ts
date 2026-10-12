import { describe, expect, it } from 'vitest';
import { linePaths, niceMax, seriesFrom } from './chartMath';

describe('chartMath', () => {
  it('niceMax rounds up to 1/2/5 × 10^n and is 1 for empty data', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(0.032)).toBeCloseTo(0.05);
    expect(niceMax(120)).toBe(200);
  });
  it('linePaths breaks at null so missing days show as gaps', () => {
    expect(linePaths([1, null, 2, 3], 30, 10, 4)).toEqual(['M0.0 7.5', 'M20.0 5.0 L30.0 2.5']);
  });
  it('seriesFrom turns non-numbers into null', () => {
    expect(seriesFrom([{ d: 'a', v: 1 }, { d: 'b', v: null }], 'd', ['v'])).toEqual({ labels: ['a', 'b'], series: [{ column: 'v', values: [1, null] }] });
  });
});
