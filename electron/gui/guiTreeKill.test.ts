// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { formatTreeKillFailure, makeGuiKillTree } from './guiTreeKill';

function setup(cb?: (done: (err: unknown) => void) => void, over?: { platform?: string; throws?: boolean }) {
  const log = vi.fn();
  const execFile = vi.fn((_f: string, _a: string[], _o: unknown, done: (err: unknown) => void) => {
    if (over?.throws) throw new Error('C:/secret/path spawn exploded');
    cb?.(done);
  });
  let t = 0;
  const kill = makeGuiKillTree({ execFile, taskkillPath: 'tk.exe', platform: over?.platform ?? 'win32', log, now: () => (t += 250), selfPid: 99 });
  return { kill, log, execFile };
}

describe('makeGuiKillTree', () => {
  it('logs code, killed=false and elapsed ms for a non-zero exit, and resolves', async () => {
    const { kill, log } = setup((done) => done(Object.assign(new Error('stderr: C:/x'), { code: 128 })));
    await expect(kill(123)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('gui session: tree kill failed');
    expect(log.mock.calls[0][0]).toContain('code=128');
    expect(log.mock.calls[0][0]).toContain('killed=false');
    expect(log.mock.calls[0][0]).toContain('ms=250');
    expect(log.mock.calls[0][0]).not.toContain('stderr');
  });

  it('logs killed=true and the signal for a real timeout', async () => {
    const { kill, log } = setup((done) => done({ killed: true, signal: 'SIGTERM', code: null }));
    await kill(123);
    expect(log.mock.calls[0][0]).toContain('killed=true');
    expect(log.mock.calls[0][0]).toContain('signal=SIGTERM');
  });

  it('logs nothing on success', async () => {
    const { kill, log } = setup((done) => done(null));
    await kill(123);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs once and resolves when execFile throws synchronously, without the message', async () => {
    const { kill, log } = setup(undefined, { throws: true });
    await expect(kill(123)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).not.toContain('secret');
  });

  it('does not call execFile for an invalid pid, our own pid, or a non-win32 platform', async () => {
    const a = setup((d) => d(null));
    for (const p of [0, 4, -1, 1.5, 99, NaN]) await a.kill(p);
    const b = setup((d) => d(null), { platform: 'linux' });
    await b.kill(123);
    expect(a.execFile).not.toHaveBeenCalled();
    expect(b.execFile).not.toHaveBeenCalled();
  });

  it('runs taskkill with exactly /pid <pid> /T /F, a 1000 ms timeout and a hidden window', async () => {
    const { kill, execFile } = setup((d) => d(null));
    await kill(123);
    expect(execFile).toHaveBeenCalledWith('tk.exe', ['/pid', '123', '/T', '/F'], { windowsHide: true, timeout: 1000 }, expect.any(Function));
  });
});

describe('formatTreeKillFailure', () => {
  it('reads a sync-throw status and omits ms when not given', () => {
    expect(formatTreeKillFailure({ status: 255 })).toBe('gui session: tree kill failed code=255 killed=false signal=none');
    expect(formatTreeKillFailure(undefined)).toBe('gui session: tree kill failed code=none killed=false signal=none');
  });
});
