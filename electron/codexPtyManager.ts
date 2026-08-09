import * as pty from 'node-pty';
import os from 'node:os';
import { resolveCodexHome } from './crossEngine/acpProcess';

// The terminal ALWAYS starts a fresh codex session -- matching ptyManager.ts's
// identical decision for claude: never add resume flags.
const CODEX_LAUNCH_COMMAND = 'codex\r';

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

export function buildCodexPtyEnv(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of BILLING_AUTH_ENV_VARS) delete env[key];
  // Dedicated, isolated home shared with the cross-engine verifier -- never
  // the operator's global ~/.codex. See electron/crossEngine/acpProcess.ts.
  env.CODEX_HOME = codexHome;
  return env;
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
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd: os.homedir(),
    env: buildCodexPtyEnv(process.env, resolveCodexHome()),
  });
  ptyProcess.write(buildUnsetCommand(process.platform, BILLING_AUTH_ENV_VARS));
  ptyProcess.write(CODEX_LAUNCH_COMMAND);
  return ptyProcess;
}
