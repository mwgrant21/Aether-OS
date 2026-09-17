import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduleResolverCleanup } from './resolverCleanup';

describe('scheduleResolverCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes the map entry afterMs + 1000ms, not before', () => {
    const map = new Map<string, () => void>();
    map.set('req-1', () => {});
    scheduleResolverCleanup(map, 'req-1', 5_000);

    vi.advanceTimersByTime(5_999);
    expect(map.has('req-1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(map.has('req-1')).toBe(false);
  });

  // The stagger is the point of the +1000ms, so pin it against a cleanup that
  // fires at the server-side timeout itself: that would delete the resolver at
  // the same instant permissionServer.ts is still deciding what to do with it.
  it('stays behind the timeout it is staggered against', () => {
    const map = new Map<string, () => void>();
    map.set('req-1', () => {});
    scheduleResolverCleanup(map, 'req-1', 120_000);

    vi.advanceTimersByTime(120_000);
    expect(map.has('req-1')).toBe(true);

    vi.advanceTimersByTime(1_000);
    expect(map.has('req-1')).toBe(false);
  });
});
