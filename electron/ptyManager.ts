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

export function spawnPty(cols = 100, rows = 30) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd: os.homedir(),
    env: buildPtyEnv(),
  });
  ptyProcess.write(CLAUDE_LAUNCH_COMMAND);
  return ptyProcess;
}
