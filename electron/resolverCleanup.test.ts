import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduleResolverCleanup } from './resolverCleanup';
import { createWaitClock, beginWait, endWait, activeDurationMs } from '../src/shared/waitClock';

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

  it('does not call onExpire before the cleanup delay elapses', () => {
    const onExpire = vi.fn();
    scheduleResolverCleanup(new Map(), 'req-1', 5_000, onExpire);

    vi.advanceTimersByTime(5_999);
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  // Regression test for the bug found and fixed during Task 13 review: this
  // is the one piece of logic in that fix with no coverage before this test.
  // main.ts's onPermissionRequest/onPostToolUse open a userWaitClock interval
  // when a prompt is shown and rely on `finally { endWait(...) }` to close it
  // once `decision` settles. permissionServer.ts's own timeout resolves its
  // HTTP response WITHOUT ever settling `decision`, so an abandoned prompt
  // never reaches that `finally` -- the ONLY thing that can still close the
  // interval is `onExpire`, fired from this cleanup timer. Delete the
  // `onExpire?.()` call in resolverCleanup.ts (or drop the callback at a call
  // site) and this test goes red: see task-13-fix-report.md for the captured
  // RED run.
  it('REGRESSION: onExpire closes an abandoned wait so it does not stay open forever', () => {
    const clock = createWaitClock();
    const timeoutMs = 120_000; // mirrors permissionServerOptions.timeoutMs

    beginWait(clock, 'req-1', Date.now());
    scheduleResolverCleanup(new Map(), 'req-1', timeoutMs, () => endWait(clock, 'req-1', Date.now()));

    // The operator never answers. Advance past the server-side timeout plus
    // this module's own +1000ms stagger.
    vi.advanceTimersByTime(timeoutMs + 1_000);

    // Fact of closure.
    expect(clock.open.has('req-1')).toBe(false);

    // The closing TIMESTAMP, not just the fact of closure: a cleanup that
    // closed the interval at the wrong instant would still read as "closed"
    // here but would subtract the wrong amount of time from every dispatch
    // that overlaps it.
    const closed = clock.intervals.find((iv) => iv.startMs === 0);
    expect(closed?.endMs).toBe(timeoutMs + 1_000);

    // The actual consequence this guards against: a dispatch that starts
    // well after the abandoned prompt must not have its duration dragged
    // toward zero by an interval that (without the fix) would still read as
    // open, and so still "waiting" through `nowMs`, forever.
    const laterStart = timeoutMs + 1_000 + 60_000;
    const laterWallDuration = 30_000;
    const measured = activeDurationMs(clock, laterStart, laterWallDuration, laterStart + laterWallDuration);
    expect(measured).toBe(laterWallDuration);
  });
});
