// electron/flushQuitGate.ts
// Holds Electron's first quit once so a pending write (the persisted duration
// baseline) can land, bounded so a hung or failing flush can never block exit.
// The second quit (the one this gate issues itself) proceeds untouched.

export type FlushResult = 'flushed' | 'timeout' | 'failed';

export function flushBounded(flush: () => Promise<void>, timeoutMs: number): Promise<FlushResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FlushResult>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  let started: Promise<void>;
  try {
    started = Promise.resolve(flush());
  } catch (err) {
    started = Promise.reject(err);
  }
  const flushed = started.then(
    (): FlushResult => 'flushed',
    (): FlushResult => 'failed',
  );
  return Promise.race([flushed, timeout]).finally(() => clearTimeout(timer));
}

export function createFlushQuitGate(flush: () => Promise<void>, quit: () => void, timeoutMs: number) {
  let started = false;
  let done = false;
  return (event: { preventDefault(): void }): boolean => {
    if (done) return true;
    event.preventDefault();
    if (!started) {
      started = true;
      void flushBounded(flush, timeoutMs).then(() => {
        done = true;
        quit();
      });
    }
    return false;
  };
}
