import * as pty from 'node-pty';
import os from 'node:os';

// The terminal ALWAYS starts a fresh claude session -- never add
// resume flags (--continue/--resume/-c/-r) here, matching this app's
// own existing decision (and TokenMonitor's identical one) that the
// terminal never opens on a stale session.
const CLAUDE_LAUNCH_COMMAND = 'claude\r';

export function spawnPty(cols = 100, rows = 30) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd: os.homedir(),
    env: process.env,
  });
  ptyProcess.write(CLAUDE_LAUNCH_COMMAND);
  return ptyProcess;
}
