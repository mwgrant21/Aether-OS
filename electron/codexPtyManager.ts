import * as pty from 'node-pty';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexHome } from './crossEngine/acpProcess';
import { resolveCodexExecutable } from './codexLaunchInfo';

// The terminal ALWAYS starts a fresh codex session -- matching ptyManager.ts's
// identical decision for claude: never add resume flags.
//
// Launch the executable resolved on the launch env explicitly rather than a
// bare `codex`: the resolved file is what the header's version readout
// probed (codexLaunchInfo.ts), and a bare name would let PowerShell pick
// codex.ps1 over codex.cmd from the same dir -- which fails outright under a
// restrictive execution policy instead of falling back. Only when nothing
// resolves does the bare name go in, leaving the operator's profile (nvm,
// Homebrew, ~/.local/bin PATH setup) its chance to find one.
export function buildCodexLaunchCommand(executable: string | null, platform: NodeJS.Platform): string {
  if (executable === null) return 'codex\r';
  if (platform === 'win32') return `& '${executable.replace(/'/g, "''")}'\r`;
  return `'${executable.replace(/'/g, "'\\''")}'\r`;
}

// Where the PTY shell starts. Also the base for relative PATH components in
// codexLaunchInfo.ts's resolution, so the readout resolves what the shell
// resolves.
export function codexPtyCwd(): string {
  return os.homedir();
}

// A real interactive terminal cannot structurally prevent the operator from
// typing an API key by hand inside the session -- stripping these from the
// inherited environment closes the "silently inherited from your shell"
// path, the same category of protection ptyManager.ts's buildPtyEnv already
// gives Claude's terminal, and the same limitation it already documents:
// this reduces risk, it does not eliminate manual entry.
//
// Mirrors the real billing/auth-bypass vector list electron/crossEngine/
// acpProcess.ts's buildCodexChildEnv already enumerates for the one-shot
// verifier (see acpProcess.test.ts's BLOCKED list) -- kept a denylist here
// rather than that function's allowlist, because an interactive shell needs
// the operator's real environment (their own PATH, editors, etc.), unlike
// the verifier's fully-synthesized child env.
const BILLING_AUTH_ENV_VARS = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'MODEL_PROVIDER',
  'DEFAULT_AUTH_REQUEST',
  'CODEX_CONFIG',
  'CODEX_PATH',
] as const;

// `npm run electron:dev` (like any `npm exec`/`npm run`) prepends
// `<dir>/node_modules/.bin` for the directory npm was invoked from and every
// ancestor of it to PATH before Electron even starts, and the terminal
// inherits that PATH. So the bare `codex` in CODEX_LAUNCH_COMMAND resolved
// to this project's pinned @openai/codex shim (the cross-check provider's
// tested dependency, see acpProcess.ts) instead of the operator's own
// install -- the terminal ran a stale version that no global update could
// change.
//
// Drop exactly that set and nothing else. npm marks its own launches with
// npm_execpath and exposes the package directory its set-path walks up
// from as npm_config_local_prefix (npm_package_json sits in that same dir),
// so the set is computable rather than guessed: a packaged build (no npm)
// strips nothing, and a node_modules/.bin the operator put on PATH
// themselves (a custom prefix, a direnv PATH_add) is kept -- a suffix-only
// match would have thrown away their real install. Not INIT_CWD: with
// `npm --prefix <dir> run ...` that is the caller's directory, not the
// package's, and the injected entries follow the package. Everything else
// (global npm bin, nvm/Homebrew/system dirs) stays in place and order. The
// shell profile still runs afterwards and may add its own PATH entries;
// that is operator configuration, not npm contamination, and is left alone.
export function npmInjectedBinDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (!env.npm_execpath) return [];
  const p = platform === 'win32' ? path.win32 : path.posix;
  const packageDir = env.npm_config_local_prefix || (env.npm_package_json ? p.dirname(env.npm_package_json) : undefined);
  if (!packageDir) return [];
  const dirs: string[] = [];
  let dir = p.normalize(packageDir);
  for (;;) {
    dirs.push(p.join(dir, 'node_modules', '.bin'));
    const parent = p.dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

export function stripNpmBinPathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const win32 = platform === 'win32';
  const p = win32 ? path.win32 : path.posix;
  // Compare in one canonical form: normalized separators, no trailing
  // separator, and case-folded on Windows to mirror its filesystem.
  const canon = (entry: string): string => {
    const t = p.normalize(entry.trim()).replace(/[\\/]+$/, '');
    return win32 ? t.toLowerCase() : t;
  };
  const injected = new Set(npmInjectedBinDirs(env, platform).map(canon));
  const out = { ...env };
  if (injected.size === 0) return out;
  const delimiter = win32 ? ';' : ':';
  // Windows spells the key `Path` (sometimes `PATH`); Node's process.env
  // proxy hides that, but a spread copy keeps whichever spelling it had.
  // Rewrite that same key -- never introduce a second one.
  for (const key of Object.keys(out)) {
    if (key.toUpperCase() !== 'PATH') continue;
    const value = out[key];
    if (typeof value !== 'string') continue;
    out[key] = value
      .split(delimiter)
      .filter((entry) => !injected.has(canon(entry)))
      .join(delimiter);
  }
  return out;
}

export function buildCodexPtyEnv(
  source: NodeJS.ProcessEnv,
  codexHome: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = stripNpmBinPathEntries(source, platform);
  for (const key of BILLING_AUTH_ENV_VARS) delete env[key];
  // Dedicated, isolated home shared with the cross-engine verifier -- never
  // the operator's global ~/.codex. See electron/crossEngine/acpProcess.ts.
  env.CODEX_HOME = codexHome;
  return env;
}

// The one env the terminal launches with. The version readout (see
// codexLaunchInfo.ts) must resolve `codex` against THIS env, not against
// Electron's raw process.env -- otherwise it would report the very shim the
// filter above exists to avoid.
export function buildCodexLaunchEnv(): NodeJS.ProcessEnv {
  return buildCodexPtyEnv(process.env, resolveCodexHome());
}

// A login/interactive shell sources the operator's own profile (~/.bashrc,
// ~/.zshrc, $PROFILE) after buildCodexPtyEnv() has already sanitized the
// inherited environment -- if that profile re-exports a blocked var (e.g.
// `export OPENAI_API_KEY=...` in ~/.bashrc), it silently restores exactly
// what the strip above removed, before `codex` is ever written to the PTY.
//
// An earlier version of this fix suppressed profile loading outright
// (--norc/-NoProfile/-f), but that also suppresses the PATH setup (nvm,
// pyenv, Homebrew, ~/.local/bin) many operators rely on for `codex` itself
// to be discoverable -- trading a real availability regression for the fix.
// Instead: let the profile run normally, then explicitly unset the blocked
// vars in the live shell session immediately before the launch command --
// this closes the re-export path without touching anything else the
// profile sets up. Matches CODEX_LAUNCH_COMMAND's own trick of writing
// input to the pty immediately after spawn: the shell reads its rc files
// from disk, not from stdin, so queued writes are unaffected by profile
// execution and simply wait until the shell is ready to read them.
export function buildUnsetCommand(platform: NodeJS.Platform, vars: readonly string[]): string {
  if (platform === 'win32') {
    return vars.map((v) => `Remove-Item Env:\\${v} -ErrorAction SilentlyContinue`).join('; ') + '\r';
  }
  return `unset ${vars.join(' ')}\r`;
}

export function spawnCodexPty(cols = 100, rows = 30) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  const env = buildCodexLaunchEnv();
  const cwd = codexPtyCwd();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env,
  });
  ptyProcess.write(buildUnsetCommand(process.platform, BILLING_AUTH_ENV_VARS));
  ptyProcess.write(buildCodexLaunchCommand(resolveCodexExecutable(env, process.platform, cwd), process.platform));
  return ptyProcess;
}
