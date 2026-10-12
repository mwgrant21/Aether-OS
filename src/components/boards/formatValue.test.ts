import { describe, expect, it } from 'vitest';
import { formatLabel, formatValue, NO_DATA } from './formatValue';

describe('formatValue', () => {
  it('null is "no data", never $0.00', () => {
    expect(formatValue('usd', null)).toBe(NO_DATA);
    expect(formatValue('usdApprox', undefined)).toBe(NO_DATA);
  });
  it('usd has no tilde; usdApprox always does', () => {
    expect(formatValue('usd', 1.234)).toBe('$1.23');
    expect(formatValue('usd', 0.001)).toBe('<$0.01');
    expect(formatValue('usdApprox', 1.234)).toBe('~$1.23');
    expect(formatValue('usdApprox', 0.001)).toBe('~<$0.01');
  });
  it('*_rate is a percent; integers get separators', () => {
    expect(formatValue('hit_rate', 0.4567)).toBe('45.7%');
    expect(formatValue('calls', 12345)).toBe('12,345');
  });
  it('labels show (none) for null', () => {
    expect(formatLabel(null)).toBe('(none)');
    expect(formatLabel('Read')).toBe('Read');
  });
});
