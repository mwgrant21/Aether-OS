import { describe, expect, it } from 'vitest';
import { fmt, fmtEta, nowLong, nowShort, short, spark } from './format';

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
