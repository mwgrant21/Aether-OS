import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApp, type ClosableApp } from '../e2e/closeApp';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function fakeApp(
  close: () => Promise<void>,
  child: { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null } = {},
): ClosableApp {
  return {
    close,
    process: () => ({ pid: 4242, exitCode: null, signalCode: null, ...child }),
  };
}

describe('closeApp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', realPlatform);
  });

  it('on a hung close, logs, kills exactly the launched pid, and throws naming the label', async () => {
    const kill = vi.fn();
    const log = vi.fn();
    const p = closeApp(fakeApp(() => new Promise<void>(() => {})), 'lbl', { kill, log });
    const assertion = expect(p).rejects.toThrow(/app\.close\(\) did not exit within 10s.*lbl/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(4242);
    expect(log).toHaveBeenCalledWith('[e2e-close-hang] lbl ms=10000');
  });

  it('resolves on a fast close without killing, logging, or leaving a timer', async () => {
    const kill = vi.fn();
    const log = vi.fn();
    await closeApp(fakeApp(() => Promise.resolve()), 'lbl', { kill, log });
    expect(kill).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not kill when the pid is undefined', async () => {
    const kill = vi.fn();
    const p = closeApp(fakeApp(() => new Promise<void>(() => {}), { pid: undefined }), 'lbl', { kill, log: vi.fn() });
    const assertion = expect(p).rejects.toThrow('app.close() did not exit within 10s');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not kill when the process already exited', async () => {
    const kill = vi.fn();
    const p = closeApp(fakeApp(() => new Promise<void>(() => {}), { exitCode: 0 }), 'lbl', { kill, log: vi.fn() });
    const assertion = expect(p).rejects.toThrow('app.close() did not exit within 10s');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not kill when the process already exited via a signal', async () => {
    const kill = vi.fn();
    const log = vi.fn();
    const p = closeApp(fakeApp(() => new Promise<void>(() => {}), { signalCode: 'SIGTERM' }), 'lbl', { kill, log });
    const assertion = expect(p).rejects.toThrow('app.close() did not exit within 10s');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(kill).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[e2e-close-kill] lbl skipped: process already exited');
  });

  it('does not kill on a non-win32 platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const kill = vi.fn();
    const log = vi.fn();
    const p = closeApp(fakeApp(() => new Promise<void>(() => {})), 'lbl', { kill, log });
    const assertion = expect(p).rejects.toThrow('app.close() did not exit within 10s');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(kill).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[e2e-close-kill] lbl skipped: not win32');
  });

  it('propagates a fast close rejection unchanged without killing', async () => {
    const kill = vi.fn();
    const boom = new Error('close blew up');
    await expect(closeApp(fakeApp(() => Promise.reject(boom)), 'lbl', { kill, log: vi.fn() })).rejects.toBe(boom);
    expect(kill).not.toHaveBeenCalled();
  });

  it('still throws the timeout error when kill throws, and logs the failure', async () => {
    const kill = vi.fn(() => {
      throw new Error('taskkill failed');
    });
    const log = vi.fn();
    const p = closeApp(fakeApp(() => new Promise<void>(() => {})), 'lbl', { kill, log });
    const assertion = expect(p).rejects.toThrow('app.close() did not exit within 10s');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(log).toHaveBeenCalledWith('[e2e-close-kill] lbl pid=4242 failed: taskkill failed');
  });

  it('honors a custom timeoutMs in the message', async () => {
    const p = closeApp(fakeApp(() => new Promise<void>(() => {})), 'lbl', { kill: vi.fn(), log: vi.fn(), timeoutMs: 6_000 });
    const assertion = expect(p).rejects.toThrow('app.close() did not exit within 6s [lbl]');
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
  });
});
