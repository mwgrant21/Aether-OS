import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadyGate } from './readyGate';

const schedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function make() {
  const onReady = vi.fn();
  const gate = createReadyGate({ quietMs: 1500, ceilingMs: 8000, schedule, onReady });
  return { gate, onReady };
}

describe('createReadyGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is never ready with zero chunks', () => {
    const { onReady } = make();
    vi.advanceTimersByTime(600_000);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('is ready exactly once after quiet', () => {
    const { gate, onReady } = make();
    gate.feed();
    vi.advanceTimersByTime(1499);
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith('quiet');
    gate.feed();
    vi.advanceTimersByTime(60_000);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('postpones quiet while chunks keep arriving, but ceilingMs after the first chunk wins', () => {
    const { gate, onReady } = make();
    gate.feed();
    for (let t = 0; t < 7000; t += 1000) {
      vi.advanceTimersByTime(1000);
      gate.feed();
    }
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith('ceiling');
    vi.advanceTimersByTime(60_000);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('reset allows a second ready', () => {
    const { gate, onReady } = make();
    gate.feed();
    vi.advanceTimersByTime(1500);
    expect(onReady).toHaveBeenCalledTimes(1);
    gate.reset();
    gate.feed();
    vi.advanceTimersByTime(1500);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('dispose cancels both timers', () => {
    const { gate, onReady } = make();
    gate.feed();
    gate.dispose();
    vi.advanceTimersByTime(60_000);
    expect(onReady).not.toHaveBeenCalled();
  });
});
