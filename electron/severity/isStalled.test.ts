import { describe, it, expect } from 'vitest';
import { isStalled, STALL_MS } from './isStalled';

describe('isStalled', () => {
  it('STALL_MS is 30 minutes', () => {
    expect(STALL_MS).toBe(30 * 60 * 1000);
  });
  it('a fresh dispatch is not stalled', () => {
    expect(isStalled({ lastProgressMs: 1_000, sessionEnded: false }, 1_000 + 60_000)).toBe(false);
  });
  it('inactivity threshold: exactly STALL_MS is not stalled, one ms more is', () => {
    expect(isStalled({ lastProgressMs: 0, sessionEnded: false }, STALL_MS)).toBe(false);
    expect(isStalled({ lastProgressMs: 0, sessionEnded: false }, STALL_MS + 1)).toBe(true);
  });
  it('an ended session stalls an open dispatch immediately', () => {
    expect(isStalled({ lastProgressMs: 1_000, sessionEnded: true }, 1_001)).toBe(true);
  });
  it('non-finite progress is never an inactivity stall', () => {
    expect(isStalled({ lastProgressMs: Number.NaN, sessionEnded: false }, 1e15)).toBe(false);
  });
});
