import { execFile, spawn } from 'node:child_process';

// What the Codex terminal is about to run: the executable the SHELL selects
// for `codex` once the operator's profile has run, and that file's
// `--version`. It is answered by the same shell the terminal uses, with the
// same launch env (buildCodexLaunchEnv, npm-injected node_modules/.bin
// stripped), the same cwd, the profile loaded, and the same resolution
// snippet the terminal itself executes (buildCodexResolveScript /
// buildCodexLaunchCommand in codexPtyManager.ts) -- so the readout and the
// launch are one selection, and a profile that prepends nvm, Homebrew or
// ~/.local/bin to PATH is honoured by both. Resolving in the Electron
// process instead would either report the project-local shim the env filter
// exists to avoid, or (resolved pre-profile) pin a launch the profile can no
// longer redirect.
//
// Token-free: `codex --version` prints one line and exits; nothing here
// contacts a model.
export interface CodexLaunchInfo {
  executable: string | null;
  version: string | null;
  error: string | null;
}

export interface BoundedResult {
  code: number | null;
  stdout: string;
}

// spawn + a time bound that kills the whole process tree. A plain kill of
// the spawned pid reaches only the head of the chain -- on Windows the shim
// is powershell/cmd.exe -> node -> codex.exe, so the wedged tail this bound
// exists for would survive and pile up on every re-probe. taskkill /T on
// Windows, the process group (detached spawn) on POSIX.
export function runBoundedCommand(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<BoundedResult> {
  const win32 = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      cwd,
      windowsHide: true,
      detached: !win32,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      killTree(child.pid, win32);
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout });
    });
  });
}

function killTree(pid: number | undefined, win32: boolean): void {
  if (pid === undefined) return;
  if (win32) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

// The resolve script's "nothing found" exit code -- distinct from a shim
// that was found but failed to run.
export const CODEX_NOT_FOUND_EXIT = 3;

// The shell invocation that runs `script` with the operator's profile loaded
// (the terminal is an interactive shell, so its profile shapes PATH), or
// without it when `loadProfile` is false (hermetic tests). PowerShell
// -Command loads $PROFILE unless told not to; a POSIX shell needs -i (rc
// file) and -l (login profile) to match what the PTY's interactive shell
// sees. Same shell selection as spawnCodexPty.
export function shellInvocation(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  script: string,
  loadProfile: boolean,
): [string, string[]] {
  if (platform === 'win32') {
    return ['powershell.exe', ['-NonInteractive', ...(loadProfile ? [] : ['-NoProfile']), '-Command', script]];
  }
  return [env.SHELL || 'bash', [loadProfile ? '-ilc' : '-c', script]];
}

export async function getCodexLaunchInfo(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
  resolveScript: string,
  timeoutMs = 30_000,
  loadProfile = true,
): Promise<CodexLaunchInfo> {
  const [file, args] = shellInvocation(platform, env, resolveScript, loadProfile);
  try {
    const { code, stdout } = await runBoundedCommand(file, args, env, cwd, timeoutMs);
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (code === CODEX_NOT_FOUND_EXIT) {
      return { executable: null, version: null, error: 'codex not found on the terminal launch PATH (profile included)' };
    }
    const executable = lines[0] ?? null;
    if (code !== 0 || !executable) {
      return { executable, version: null, error: `codex --version failed: exit code ${code}` };
    }
    return { executable, version: lines[1] ?? null, error: lines[1] ? null : 'codex --version printed nothing' };
  } catch (err) {
    return { executable: null, version: null, error: `codex --version failed: ${(err as Error).message}` };
  }
}
