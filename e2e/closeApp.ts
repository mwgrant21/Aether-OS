import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Structural subset of Playwright's ElectronApplication. Type-only so vitest never loads @playwright/test. */
export interface ClosableApp {
  close(): Promise<void>;
  process(): { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null };
}

export interface CloseAppOptions {
  timeoutMs?: number;
  kill?: (pid: number) => void | Promise<void>;
  log?: (line: string) => void;
}

const execFileAsync = promisify(execFile);

async function killTree(pid: number): Promise<void> {
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 });
}

/**
 * app.close() bounded by a timeout. On a hang it logs, kills ONLY the process tree of the pid
 * Playwright launched (taken from app.process() before close, still alive), then throws an
 * error naming the label so the first failure line attributes the hang.
 */
export async function closeApp(app: ClosableApp, label: string, opts: CloseAppOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const kill = opts.kill ?? killTree;
  const log = opts.log ?? ((line: string) => console.error(line));
  const child = app.process();
  const start = Date.now();
  const closing = Promise.resolve(app.close());
  closing.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([closing.then(() => 'closed' as const), timedOut]);
    if (result === 'closed') return;
  } finally {
    clearTimeout(timer);
  }
  log(`[e2e-close-hang] ${label} ms=${Date.now() - start}`);
  const pid = child.pid;
  let skip: string | undefined;
  if (process.platform !== 'win32') skip = 'not win32';
  else if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) skip = 'no valid pid';
  else if (child.exitCode !== null || child.signalCode !== null) skip = 'process already exited';
  if (skip !== undefined || pid === undefined) {
    log(`[e2e-close-kill] ${label} skipped: ${skip}`);
  } else {
    try {
      await kill(pid);
      log(`[e2e-close-kill] ${label} pid=${pid} killed`);
    } catch (err) {
      log(`[e2e-close-kill] ${label} pid=${pid} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`app.close() did not exit within ${timeoutMs / 1000}s [${label}]`);
}
