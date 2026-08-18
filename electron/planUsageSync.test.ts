import { describe, expect, it } from 'vitest';
import { runPlanUsageSync } from './planUsageSync';

function makeClock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('runPlanUsageSync', () => {
  it('writes /usage, waits for quiescence (>=2000ms with no new capture), then Escapes and returns the settled snapshot', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    let calls = 0;
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => {
        calls += 1;
        // First call computes `before` -- must be null so a later capture reads as fresh.
        return calls === 1 ? null : { tier: 'max' as const, weekModel: { pct: 52 }, capturedAtMs: 250 };
      },
      hasSeenUsagePane: () => true,
      reset: () => {},
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(writes).toEqual(['/usage\r', '\x1b']);
    expect(result).toEqual({ ok: true, tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 250 });
    // 9 polls of 250ms to accumulate 2000ms of no-change after the capture lands at t=250.
    expect(clock.now()).toBe(2250);
  });

  it('returns ok:false when the /usage pane never renders (e.g. no claude session in this pty)', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    let resetCalled = false;
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => null,
      hasSeenUsagePane: () => false,
      reset: () => {
        resetCalled = true;
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ok: false, error: 'could not read /usage' });
    expect(writes).toEqual(['/usage\r', '\x1b']);
    expect(resetCalled).toBe(true);
    expect(clock.now()).toBe(10000); // ran the full deadline
  });

  it('returns tier: "pro" when the pane settles with no model line, but hasSeenUsagePane confirms it opened', async () => {
    const clock = makeClock(0);
    let resetCalled = false;
    const result = await runPlanUsageSync({
      write: () => {},
      getSnapshot: () => null, // Pro: scraper never sets a snapshot (no model line ever appears)
      hasSeenUsagePane: () => true, // but "Current session..." did render
      reset: () => {
        resetCalled = true;
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ok: true, tier: 'pro', weekModel: null, capturedAtMs: 10000 });
    expect(resetCalled).toBe(true);
  });

  it('returns the last-captured snapshot at the 10s deadline when quiescence is never reached (value keeps changing)', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => ({ tier: 'max' as const, weekModel: { pct: 10 }, capturedAtMs: clock.now() }),
      hasSeenUsagePane: () => true,
      reset: () => {},
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ok: true, tier: 'max', weekModel: { pct: 10 }, capturedAtMs: 10000 });
    expect(writes).toEqual(['/usage\r', '\x1b']);
  });
});
