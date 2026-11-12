import * as pty from 'node-pty';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deleteEnvKeysIgnoreCase } from './envScrub';

// The terminal ALWAYS starts a fresh claude session -- never add
// resume flags (--continue/--resume/-c/-r) here, matching this app's
// own existing decision (and TokenMonitor's identical one) that the
// terminal never opens on a stale session. --session-id with a fresh uuid
// still starts a new session; it only fixes the transcript's file name so the
// pinned terminal's tracker can find it exactly (see liveAgentTracker.ts).
//
// exitWithClaude (opt-in, default off): append `; exit` so the shell ends when
// claude does; the pty lifecycle's exit event fires only on shell exit.
export function buildClaudeLaunchCommand(sessionId?: string, exitWithClaude = false): string {
  const base = sessionId ? `claude --session-id ${sessionId}` : 'claude';
  return exitWithClaude ? `${base}; exit\r` : `${base}\r`;
}

// Env vars that, if inherited from the operator's shell, would let the
// auto-launched `claude` session below bill against a paid API key without
// the user ever choosing that -- the mechanism the 2026-08-04 $10.76/day
// incident (docs/roadmap.md SS3.4/3.5) traced back to. This is the one place
// Aether is causally upstream of a paid model call, so strip them here even
// though Aether's own code never reads or sends them.
const API_KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const;

export function buildPtyEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  deleteEnvKeysIgnoreCase(env, API_KEY_ENV_VARS);
  // Drop a stale identity inherited from Aether's own parent shell; the real one
  // comes from terminalIdentityEnv (explicit identity wins over inherited env).
  delete env.AETHER_TERMINAL;
  delete env.AETHER_BOARD_CLI;
  // The renderer is xterm.js, which handles 24-bit color; advertise it so TUIs emit truecolor.
  env.COLORTERM = 'truecolor';
  return env;
}

// A login/interactive shell sources the operator's own profile (~/.bashrc,
// ~/.zshrc, $PROFILE) after buildPtyEnv() has already sanitized the
// inherited environment -- if that profile re-exports a blocked var (e.g.
// `export ANTHROPIC_API_KEY=...` in ~/.bashrc), it silently restores exactly
// what the strip above removed, before `claude` is ever written to the PTY.
//
// An earlier version of this fix suppressed profile loading outright
// (--norc/-NoProfile/-f), but that also suppresses the PATH setup (nvm,
// pyenv, Homebrew, ~/.local/bin) many operators rely on for `claude` itself
// to be discoverable -- trading a real availability regression for the fix.
// Instead: let the profile run normally, then explicitly unset the blocked
// vars in the live shell session immediately before the launch command --
// this closes the re-export path without touching anything else the
// profile sets up. Matches buildClaudeLaunchCommand's own trick of writing
// input to the pty immediately after spawn: the shell reads its rc files
// from disk, not from stdin, so queued writes are unaffected by profile
// execution and simply wait until the shell is ready to read them.
export function buildUnsetCommand(platform: NodeJS.Platform, vars: readonly string[]): string {
  if (platform === 'win32') {
    return vars.map((v) => `Remove-Item Env:\\${v} -ErrorAction SilentlyContinue`).join('; ') + '\r';
  }
  return `unset ${vars.join(' ')}\r`;
}

// The one launch-line decision, pulled out of spawnPty (not unit-testable: node-pty).
// With no override this is exactly buildClaudeLaunchCommand. An override is
// returned verbatim -- the caller's builder owns the trailing carriage return; nothing is appended.
export function launchLine(sessionId?: string, launchCommand?: string): string {
  return launchCommand ?? buildClaudeLaunchCommand(sessionId);
}

export interface BridgePtyLaunch { scriptPath: string; env: NodeJS.ProcessEnv }

// Marks a terminal's claude as unmonitored for scripts/aether-statusline.mjs,
// which then renders its line but never writes the shared statusline.json.
export const UNMONITORED_TERMINAL_ENV: NodeJS.ProcessEnv = { AETHER_STATUSLINE_NO_PERSIST: '1' };

// Tells a CLI/skill running inside an Aether terminal which one it is. Spread
// after buildPtyEnv (which strips any inherited AETHER_TERMINAL and
// AETHER_BOARD_CLI), so it always wins. boardCliPath is a path only; when
// undefined the AETHER_BOARD_CLI key is absent, not empty.
export function terminalIdentityEnv(slot: 'claude' | 'terminal2', boardCliPath?: string): NodeJS.ProcessEnv {
  return {
    AETHER_TERMINAL: slot === 'claude' ? 'alpha' : 'beta',
    ...(boardCliPath ? { AETHER_BOARD_CLI: boardCliPath } : {}),
  };
}

// Absolute path to scripts/aether-board.mjs for AETHER_BOARD_CLI, or undefined
// when the file is missing. Same rule as resolveStatuslineScriptPath
// (electron/statuslineUninstallCli.ts): packaged builds ship it under
// resources/scripts, dev runs read it from the repo.
export function resolveBoardCliPath(
  opts: { isPackaged: boolean; resourcesPath: string; appPath: string },
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const p = opts.isPackaged
    ? join(opts.resourcesPath, 'scripts', 'aether-board.mjs')
    : join(opts.appPath, 'scripts', 'aether-board.mjs');
  return exists(p) ? p : undefined;
}

// Everything spawnPty hands to node-pty plus the two post-spawn writes, as plain
// data. Main sends this to the pty-owner helper, which never reads Aether's env
// builders. ELECTRON_RUN_AS_NODE is stripped so a shell never passes it on to
// electron-based tools it runs.
export interface PtyLaunchSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  writes: string[];
}

export function buildPtyLaunchSpec(cols = 100, rows = 30, bridge?: BridgePtyLaunch, sessionId?: string, extraEnv?: NodeJS.ProcessEnv, launchCommand?: string, cwd?: string): PtyLaunchSpec {
  if (bridge && process.platform !== 'win32') throw new Error('BRIDGE_LAUNCH_PLATFORM_UNSUPPORTED');
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  const env = bridge ? { ...bridge.env } : { ...buildPtyEnv(), ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    file: shell,
    args: bridge ? ['-NoExit', '-File', bridge.scriptPath] : [],
    cwd: cwd ?? os.homedir(),
    env,
    cols,
    rows,
    writes: bridge ? [] : [buildUnsetCommand(process.platform, API_KEY_ENV_VARS), launchLine(sessionId, launchCommand)],
  };
}

export function spawnPty(cols = 100, rows = 30, bridge?: BridgePtyLaunch, sessionId?: string, extraEnv?: NodeJS.ProcessEnv, launchCommand?: string, cwd?: string) {
  const spec = buildPtyLaunchSpec(cols, rows, bridge, sessionId, extraEnv, launchCommand, cwd);
  const ptyProcess = pty.spawn(spec.file, spec.args, {
    name: 'xterm-color',
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: spec.env,
  });
  for (const w of spec.writes) ptyProcess.write(w);
  return ptyProcess;
}
