import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// What the Codex terminal is about to run: the executable a bare `codex`
// resolves to on the terminal's OWN launch PATH (buildCodexLaunchEnv, after
// the npm-injected node_modules/.bin entries are stripped), and that file's
// `--version`. Resolving against Electron's raw process.env instead would
// report the project-local shim the filter exists to avoid -- the readout
// must describe the launch selection, not an independent lookup.
//
// Honest limit: the interactive shell sources the operator's profile after
// this env is built, so a profile that prepends its own PATH entry, alias or
// function for `codex` can still change what launches. That is operator
// configuration, not npm contamination, and this readout does not model it.
export interface CodexLaunchInfo {
  executable: string | null;
  version: string | null;
  error: string | null;
}

// npm writes `codex`, `codex.cmd` and `codex.ps1` side by side in every bin
// dir it manages (global and node_modules/.bin alike), so the directory is
// what identifies the install; any of these names in a dir is that install.
// .cmd first: child_process can run it without a PowerShell execution-policy
// dependency, and it is the form PowerShell falls back to when .ps1 is blocked.
const WIN32_NAMES = ['codex.cmd', 'codex.exe', 'codex.bat', 'codex.ps1'];
const POSIX_NAMES = ['codex'];

function pathValue(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] : undefined;
}

export function resolveCodexExecutable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const value = pathValue(env);
  if (!value) return null;
  const win32 = platform === 'win32';
  const names = win32 ? WIN32_NAMES : POSIX_NAMES;
  const mode = win32 ? fs.constants.F_OK : fs.constants.X_OK;
  for (const dir of value.split(win32 ? ';' : ':')) {
    const d = dir.trim();
    if (!d) continue;
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
    execFile(
      file,
      args,
      { env, timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: win32, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err.killed ? new Error(`timed out after ${timeoutMs}ms`) : err);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export async function getCodexLaunchInfo(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 10_000,
): Promise<CodexLaunchInfo> {
  const executable = resolveCodexExecutable(env, platform);
  if (!executable) {
    return { executable: null, version: null, error: 'codex not found on the terminal launch PATH' };
  }
  try {
    return { executable, version: await probeCodexVersion(executable, env, timeoutMs), error: null };
  } catch (err) {
    return { executable, version: null, error: `codex --version failed: ${(err as Error).message}` };
  }
}
