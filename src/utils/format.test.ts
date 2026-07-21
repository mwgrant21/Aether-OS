import { describe, expect, it } from 'vitest';
import { fmt, fmtElapsed, fmtEta, nowLong, nowShort, resolveOperatorName, short, spark } from './format';

describe('fmt', () => {
  it('adds thousands separators to a rounded integer', () => {
    expect(fmt(24391)).toBe('24,391');
    expect(fmt(999.6)).toBe('1,000');
  });
});

describe('short', () => {
  it('abbreviates millions and thousands, leaves small numbers alone', () => {
    expect(short(1_500_000)).toBe('1.50M');
    expect(short(1500)).toBe('1.5K');
    expect(short(500)).toBe('500');
  });
});

describe('fmtEta', () => {
  it('returns n/a for non-finite or non-positive input', () => {
    expect(fmtEta(0)).toBe('n/a');
    expect(fmtEta(-5)).toBe('n/a');
    expect(fmtEta(NaN)).toBe('n/a');
    expect(fmtEta(Infinity)).toBe('n/a');
  });

  it('formats minutes-only when under an hour', () => {
    expect(fmtEta(90)).toBe('1m');
  });

  it('formats hours and minutes when over an hour', () => {
    expect(fmtEta(5400)).toBe('1h 30m');
  });
});

describe('spark', () => {
  it('maps a history array to a 62x20 SVG polyline points string', () => {
    expect(spark([1, 2, 3])).toBe('0.0,18.0 31.0,10.0 62.0,2.0');
  });
});

describe('nowLong/nowShort', () => {
  it('formats as HH:MM:SS and HH:MM', () => {
    expect(nowLong()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(nowShort()).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('resolveOperatorName', () => {
  it('returns the trimmed name when non-blank', () => {
    expect(resolveOperatorName('  Matt  ')).toBe('Matt');
  });

  it('falls back to "Operator" for an empty string', () => {
    expect(resolveOperatorName('')).toBe('Operator');
  });

  it('falls back to "Operator" for a whitespace-only string', () => {
    expect(resolveOperatorName('   ')).toBe('Operator');
  });
});

describe('fmtElapsed', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(fmtElapsed(45_000)).toBe('45s');
  });

  it('formats minute-scale durations as minutes and seconds', () => {
    expect(fmtElapsed(2 * 60_000 + 14_000)).toBe('2m 14s');
  });

  it('formats hour-scale durations as hours and minutes', () => {
    expect(fmtElapsed(90 * 60_000)).toBe('1h 30m');
  });

  it('returns 0s for zero or negative elapsed time', () => {
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(-500)).toBe('0s');
  });
});
