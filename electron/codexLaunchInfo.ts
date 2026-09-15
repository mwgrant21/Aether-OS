import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

// What the Codex terminal is about to run: the executable found for `codex`
// on the terminal's OWN launch PATH (buildCodexLaunchEnv, after the
// npm-injected node_modules/.bin entries are stripped), and that file's
// `--version`. spawnCodexPty launches exactly this file when one resolves
// (see buildCodexLaunchCommand), so the readout and the launch are the same
// selection by construction -- not a probe of one shim while the shell
// picks another (PowerShell prefers codex.ps1 over codex.cmd for a bare
// `codex`, and does not fall back when execution policy blocks it).
// Resolving against Electron's raw process.env instead would report the
// project-local shim the filter exists to avoid.
//
// Honest limit: when nothing resolves here, the terminal falls back to a
// bare `codex` after the operator's profile has run, and a profile that adds
// its own PATH entry, alias or function for `codex` decides what launches.
// That is operator configuration, and this readout does not model it.
export interface CodexLaunchInfo {
  executable: string | null;
  version: string | null;
  error: string | null;
}

// npm writes `codex`, `codex.cmd` and `codex.ps1` side by side in every bin
// dir it manages (global and node_modules/.bin alike), so the directory is
// what identifies the install; any of these names in a dir is that install.
// .cmd first: the terminal launches the file we pick, and a .cmd shim runs
// without a PowerShell execution-policy dependency.
const WIN32_NAMES = ['codex.cmd', 'codex.exe', 'codex.bat', 'codex.ps1'];
const POSIX_NAMES = ['codex'];

function pathValue(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] : undefined;
}

// `cwd` is the directory the PTY shell starts in (spawnCodexPty's cwd), not
// Electron's own: a relative PATH component (`bin`, `.`) and, on POSIX, an
// empty one (which POSIX defines as the current directory) resolve from
// there, exactly as the shell will resolve them.
export function resolveCodexExecutable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, cwd: string): string | null {
  const value = pathValue(env);
  if (!value) return null;
  const win32 = platform === 'win32';
  const names = win32 ? WIN32_NAMES : POSIX_NAMES;
  const mode = win32 ? fs.constants.F_OK : fs.constants.X_OK;
  for (const dir of value.split(win32 ? ';' : ':')) {
    const entry = dir.trim();
    if (!entry && win32) continue; // Windows ignores empty PATH components
    const d = path.resolve(cwd, entry || '.');
    for (const name of names) {
      const candidate = path.join(d, name);
      try {
        fs.accessSync(candidate, mode);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here -- keep walking PATH in order, exactly as the shell would
      }
    }
  }
  return null;
}

// Bounded and token-free: `codex --version` prints one line and exits; it
// never contacts a model. The time bound is the only protection against a
// wedged shim, so callers must always pass one.
export function probeCodexVersion(executable: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  const win32 = process.platform === 'win32';
  // A .cmd shim only runs through cmd.exe. Spawn it explicitly rather than
  // via shell:true (Node DEP0190 warns about args under shell mode): with
  // /s cmd strips the outer quote pair, leaving the quoted path intact even
  // when it contains spaces -- the same wrapping Node's shell mode applies.
  const [file, args] = win32
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${executable}" --version"`]]
    : [executable, ['--version']];
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      windowsHide: true,
      windowsVerbatimArguments: win32,
      // POSIX: own process group, so the timeout can kill the whole tree.
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`exited with code ${code}`));
    });
  });
}

// A plain kill of the spawned pid reaches only the head of the chain. On
// Windows the shim is cmd.exe -> node -> codex.exe, so the wedged tail this
// timeout exists for would survive and pile up on every re-probe. Take the
// whole tree: taskkill /T on Windows, the process group on POSIX.
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

export async function getCodexLaunchInfo(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
  timeoutMs = 10_000,
): Promise<CodexLaunchInfo> {
  const executable = resolveCodexExecutable(env, platform, cwd);
  if (!executable) {
    return {
      executable: null,
      version: null,
      error: 'codex not found on the terminal launch PATH; the shell will try a bare `codex` after its profile runs',
    };
  }
  try {
    return { executable, version: await probeCodexVersion(executable, env, timeoutMs), error: null };
  } catch (err) {
    return { executable, version: null, error: `codex --version failed: ${(err as Error).message}` };
  }
}
