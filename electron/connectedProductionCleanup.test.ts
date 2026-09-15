import { describe, expect, it, vi } from 'vitest';
import { cleanupConnectedProduction, ConnectedCleanupError, guardConnectedSetup } from '../e2e/connectedProductionCleanup';

describe('connected production cleanup sequencing', () => {
  it('continues through exit, close and PID verification after diagnostics fail', async () => {
    const events: string[] = [];
    const action = cleanupConnectedProduction({
      writeDiagnostics: () => { events.push('diagnostics'); throw new Error('disk full'); },
      requestExit: () => { events.push('exit'); },
      closeApp: async () => { events.push('close'); },
      forceCloseApp: () => { events.push('force-close'); },
      ownedPids: [41], isAlive: () => false,
      terminatePid: () => { events.push('terminate'); },
      waitForOwnedExit: async () => { events.push('verify'); },
    });
    await expect(action).rejects.toBeInstanceOf(ConnectedCleanupError);
    expect(events).toEqual(['diagnostics', 'exit', 'close', 'verify']);
  });

  it('bounds a hung close, then force-closes and terminates only live owned PIDs before rechecking', async () => {
    const events: string[] = [];
    const alive = new Set([42]);
    const never = new Promise<void>(() => {});
    const action = cleanupConnectedProduction({
      writeDiagnostics: () => { events.push('diagnostics'); },
      requestExit: () => { events.push('exit'); }, closeApp: () => { events.push('close'); return never; },
      forceCloseApp: () => { events.push('force-close'); }, ownedPids: [41, 42], isAlive: pid => alive.has(pid),
      terminatePid: pid => { events.push(`terminate-${pid}`); alive.delete(pid); },
      waitForOwnedExit: async () => { events.push('verify'); expect(alive.size).toBe(0); }, closeTimeoutMs: 1,
    });
    await expect(action).rejects.toBeInstanceOf(ConnectedCleanupError);
    expect(events).toEqual(['diagnostics', 'exit', 'close', 'force-close', 'terminate-42', 'verify']);
  });

  it('closes an allocated app when first-window setup fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const force = vi.fn();
    const setupFailure = new Error('first window failed');
    await expect(guardConnectedSetup(async () => { throw setupFailure; }, close, force, 5)).rejects.toBe(setupFailure);
    expect(close).toHaveBeenCalledOnce();
    expect(force).not.toHaveBeenCalled();
  });

  it('bounds first-window setup and closes the allocated app', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const force = vi.fn();
    const never = new Promise<never>(() => {});
    await expect(guardConnectedSetup(() => never, close, force, 1, 5)).rejects.toThrow('setup timed out');
    expect(close).toHaveBeenCalledOnce();
    expect(force).not.toHaveBeenCalled();
  });
});
