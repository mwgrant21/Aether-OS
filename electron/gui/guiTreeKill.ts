import type { ExecFileException } from 'node:child_process';

// Fields only, never err.message or stderr (they can carry a path or command line): code/killed/signal tell a taskkill
// non-zero exit (128/255, usually a tree that was already gone or churning) from a real timeout (killed=true) or a spawn failure (string code).
export function formatTreeKillFailure(err?: unknown, ms?: number): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Partial<ExecFileException> & { status?: number | null };
  const code = e.code ?? e.status;
  const parts = [`code=${code === undefined || code === null ? 'none' : String(code)}`, `killed=${e.killed === true}`, `signal=${e.signal ?? 'none'}`];
  if (ms !== undefined) parts.push(`ms=${Math.round(ms)}`);
  return `gui session: tree kill failed ${parts.join(' ')}`;
}

type ExecFileFn = (file: string, args: string[], opts: { windowsHide: boolean; timeout: number }, cb: (err: unknown) => void) => unknown;

export interface GuiTreeKillDeps {
  execFile: ExecFileFn;
  taskkillPath: string;
  platform: string;
  log: (line: string) => void;
  now?: () => number;
  selfPid?: number;
}

export const guiTreePidOk = (pid: unknown, selfPid?: number): pid is number =>
  typeof pid === 'number' && Number.isInteger(pid) && pid > 4 && pid !== selfPid;

// win32 only; the pid must come from the GUI-owned pty. Always resolves, never rejects. A failure is logged as fixed fields only.
export function makeGuiKillTree(d: GuiTreeKillDeps): (pid: number) => Promise<void> {
  const now = d.now ?? Date.now;
  return (pid) => new Promise<void>((resolve) => {
    if (d.platform !== 'win32' || !guiTreePidOk(pid, d.selfPid)) { resolve(); return; }
    const t0 = now();
    try {
      d.execFile(d.taskkillPath, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 1000 }, (err) => {
        if (err) d.log(formatTreeKillFailure(err, now() - t0));
        resolve();
      });
    } catch (e) { d.log(formatTreeKillFailure(e, now() - t0)); resolve(); }
  });
}
