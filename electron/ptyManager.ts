import * as pty from 'node-pty';
import os from 'node:os';

// The terminal ALWAYS starts a fresh claude session -- never add
// resume flags (--continue/--resume/-c/-r) here, matching this app's
// own existing decision (and TokenMonitor's identical one) that the
// terminal never opens on a stale session.
const CLAUDE_LAUNCH_COMMAND = 'claude\r';

// Env vars that, if inherited from the operator's shell, would let the
// auto-launched `claude` session below bill against a paid API key without
// the user ever choosing that -- the mechanism the 2026-08-04 $10.76/day
// incident (docs/roadmap.md SS3.4/3.5) traced back to. This is the one place
// Aether is causally upstream of a paid model call, so strip them here even
// though Aether's own code never reads or sends them.
const API_KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const;

export function buildPtyEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of API_KEY_ENV_VARS) delete env[key];
  return env;
}

// A login/interactive shell sources the operator's own profile (~/.bashrc,
// ~/.zshrc, $PROFILE) after buildPtyEnv() has already sanitized the
// inherited environment -- if that profile re-exports a blocked var (e.g.
// `export ANTHROPIC_API_KEY=...` in ~/.bashrc), it silently restores exactly
// what the strip above removed, before `claude` is ever written to the PTY.
// Suppressing profile-loading closes that path. An unrecognized $SHELL (not
// bash/zsh, e.g. fish) is spawned with no suppression flag rather than
// guessing one -- best effort, not a regression from the prior behavior.
export function resolveShellInvocation(
  platform: NodeJS.Platform,
  shellEnv: string | undefined,
): { shell: string; args: string[] } {
  if (platform === 'win32') return { shell: 'powershell.exe', args: ['-NoProfile'] };
  const shell = shellEnv || 'bash';
  const shellName = shell.split(/[\\/]/).pop() ?? shell;
  if (shellName === 'bash') return { shell, args: ['--norc', '--noprofile'] };
  if (shellName === 'zsh') return { shell, args: ['-f'] };
  return { shell, args: [] };
}

export function spawnPty(cols = 100, rows = 30) {
  const { shell, args } = resolveShellInvocation(process.platform, process.env.SHELL);
  const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd: os.homedir(),
    env: buildPtyEnv(),
  });
  ptyProcess.write(CLAUDE_LAUNCH_COMMAND);
  return ptyProcess;
}
