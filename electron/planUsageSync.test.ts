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
  it('resets before writing /usage, so a stale buffer/flag from a prior sync never leaks into this one', async () => {
    const clock = makeClock(0);
    const calls: string[] = [];
    const result = await runPlanUsageSync({
      write: (s) => calls.push(`write:${s}`),
      getSnapshot: () => null,
      hasSeenUsagePane: () => false,
      reset: () => calls.push('reset'),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(calls[0]).toBe('reset');
    expect(calls[1]).toBe('write:/usage\r');
    expect(calls.filter((c) => c === 'reset')).toHaveLength(1);
    expect(result).toEqual({ ok: false, error: 'could not read /usage' });
  });

  it('writes /usage, waits for quiescence (>=2000ms with no new capture), then Escapes and returns the settled snapshot', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => ({ tier: 'max' as const, weekModel: { pct: 52 }, capturedAtMs: 250 }),
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

  it('returns ok:false and sends NO Escape when the /usage pane never renders (e.g. no claude session in this pty)', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => null,
      hasSeenUsagePane: () => false,
      reset: () => {},
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ok: false, error: 'could not read /usage' });
    // No Escape written -- the pane never opened, so there is nothing to
    // close, and writing Escape here would interrupt unrelated live work.
    expect(writes).toEqual(['/usage\r']);
    expect(clock.now()).toBe(10000); // ran the full deadline
  });

  it('returns tier: "pro" and DOES send Escape when the pane settles with no model line, but hasSeenUsagePane confirms it opened', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => null, // Pro: scraper never sets a snapshot (no model line ever appears)
      hasSeenUsagePane: () => true, // but "Current session..." did render
      reset: () => {},
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ok: true, tier: 'pro', weekModel: null, capturedAtMs: 10000 });
    expect(writes).toEqual(['/usage\r', '\x1b']);
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

  it('does not throw when the pty exits mid-sync (getSnapshot goes back to null after an earlier real capture) -- returns the last-good reading instead', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    let calls = 0;
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => {
        calls += 1;
        // First poll captures a real Max reading; every poll after that
        // simulates the pty having exited (main.ts's onExit -> reset()),
        // which nulls the scraper's snapshot for the rest of this sync.
        return calls === 1 ? { tier: 'max' as const, weekModel: { pct: 52 }, capturedAtMs: 250 } : null;
      },
      hasSeenUsagePane: () => true,
      reset: () => {},
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(() => result).not.toThrow();
    expect(result).toEqual({ ok: true, tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 250 });
    expect(writes).toEqual(['/usage\r', '\x1b']);
  });
});
