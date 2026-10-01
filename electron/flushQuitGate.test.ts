import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFlushQuitGate, flushBounded } from './flushQuitGate';

afterEach(() => {
  vi.useRealTimers();
});

describe('flushBounded', () => {
  it('resolves "flushed" when the flush settles in time', async () => {
    await expect(flushBounded(() => Promise.resolve(), 500)).resolves.toBe('flushed');
  });

  it('a hung flush resolves "timeout" at the timeout', async () => {
    vi.useFakeTimers();
    let settled: string | null = null;
    void flushBounded(() => new Promise<void>(() => {}), 500).then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('timeout');
  });

  it('a rejecting flush still resolves ("failed")', async () => {
    await expect(flushBounded(() => Promise.reject(new Error('EACCES')), 500)).resolves.toBe('failed');
  });

  it('a flush that throws synchronously still resolves ("failed")', async () => {
    await expect(
      flushBounded(() => {
        throw new Error('boom');
      }, 500),
    ).resolves.toBe('failed');
  });
});

describe('createFlushQuitGate', () => {
  it('holds the first quit once, flushes, then quits; the second quit proceeds untouched', async () => {
    const flush = vi.fn(() => Promise.resolve());
    const quit = vi.fn();
    const gate = createFlushQuitGate(flush, quit, 500);
    const first = { preventDefault: vi.fn() };
    expect(gate(first)).toBe(false);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    const second = { preventDefault: vi.fn() };
    expect(gate(second)).toBe(true);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('a hung flush cannot block exit: quit fires at the timeout', async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const gate = createFlushQuitGate(() => new Promise<void>(() => {}), quit, 500);
    gate({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(499);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('a failing flush cannot block exit', async () => {
    const quit = vi.fn();
    const gate = createFlushQuitGate(() => Promise.reject(new Error('x')), quit, 500);
    gate({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });

  it('a second quit while the flush is still pending is held again but does not flush twice', () => {
    const flush = vi.fn(() => new Promise<void>(() => {}));
    const gate = createFlushQuitGate(flush, vi.fn(), 500);
    gate({ preventDefault: vi.fn() });
    const again = { preventDefault: vi.fn() };
    expect(gate(again)).toBe(false);
    expect(again.preventDefault).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
