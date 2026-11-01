// Runs fn at most once per minMs: a call inside the window is dropped, not queued. The first call always runs and
// reset() forgets the last run so the next call runs at once.
export function createMinInterval(fn: () => void, minMs: number, now: () => number = Date.now): { run(): void; reset(): void } {
  let last: number | null = null;
  return {
    run() {
      const t = now();
      if (last !== null && t - last < minMs) return;
      last = t;
      fn();
    },
    reset() { last = null; },
  };
}
