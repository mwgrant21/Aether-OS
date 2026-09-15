import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCodexPtyEnv, buildCodexResolveScript } from './codexPtyManager';
import { getCodexLaunchInfo, runBoundedCommand, shellInvocation } from './codexLaunchInfo';

// One harmless on-disk fixture, laid out like the real failure: a "project"
// copy of the codex shim under node_modules/.bin (what npm injects) and a
// "global" copy in a plain bin dir (what the operator installed). The same
// PATH must resolve to the project copy through Electron's raw env and to the
// global copy through the terminal's filtered launch env -- and the version
// the readout reports must come from the copy that will actually launch.
// The readout is answered by a real shell running the terminal's own
// selection script (profile loading off here, so the test is hermetic).
const win32 = process.platform === 'win32';
const platform = process.platform;
const delimiter = win32 ? ';' : ':';
const RESOLVE = buildCodexResolveScript(platform);
// Just enough PATH for the shell itself to start and run the script (the
// PowerShell dir + System32 for Get-Command; /usr/bin:/bin for sh) -- never
// the developer's real PATH, which has a codex on it and would make the
// not-found case pass or fail for the wrong reason.
const BASE_PATH = win32
  ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'), path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';')
  : '/usr/bin:/bin';

let root: string;
let projectBin: string;
let globalBin: string;

function shimName(): string {
  return win32 ? 'codex.cmd' : 'codex';
}

function writeShim(dir: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, shimName());
  if (win32) fs.writeFileSync(file, `@echo off\r\necho codex-cli ${version}\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return file;
}

// A shim that wedges the way a broken install would: it spawns a long-lived
// grandchild (ping / sleep with a distinctive argument, so it can be found by
// command line afterwards) and writes a marker file first so the test knows
// the grandchild was really launched before the timeout fired.
function writeSlowShim(dir: string, marker: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, shimName());
  if (win32) {
    fs.writeFileSync(file, `@echo off\r\necho started > "${marker}"\r\nping -n 47 127.0.0.1 >nul\r\necho codex-cli 0.0.0\r\n`);
  } else {
    fs.writeFileSync(file, `#!/bin/sh\necho started > "${marker}"\nsleep 47\necho "codex-cli 0.0.0"\n`, { mode: 0o755 });
  }
  return file;
}

function countSlowGrandchildren(): number {
  if (win32) {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object { $_.CommandLine -like '*-n 47 127.0.0.1*' }).Count"],
      { encoding: 'utf8', windowsHide: true },
    );
    return Number(out.trim());
  }
  const out = execFileSync('sh', ['-c', "ps -A -o args= | grep -c '[s]leep 47' || true"], { encoding: 'utf8' });
  return Number(out.trim());
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

function rawEnv(...dirs: string[]): NodeJS.ProcessEnv {
  return { ...process.env, PATH: [...dirs, BASE_PATH].join(delimiter) };
}

// The launch env the real terminal gets: built from a PATH carrying the npm
// markers npm itself sets for a `npm run` launch (package dir = the project).
function launchEnvFor(...dirs: string[]): NodeJS.ProcessEnv {
  return buildCodexPtyEnv(
    { ...rawEnv(...dirs), npm_execpath: 'fake-npm-cli.js', npm_config_local_prefix: path.join(root, 'proj') },
    root,
    platform,
  );
}

function launchInfo(env: NodeJS.ProcessEnv, timeoutMs = 30_000) {
  return getCodexLaunchInfo(env, platform, root, RESOLVE, timeoutMs, false);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-codex-launch-'));
  projectBin = path.join(root, 'proj', 'node_modules', '.bin');
  globalBin = path.join(root, 'global');
  writeShim(projectBin, '0.153.2');
  writeShim(globalBin, '0.154.0');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('shellInvocation', () => {
  it('loads the profile by default and can be told not to, on both platforms', () => {
    expect(shellInvocation('win32', {}, 'S', true)).toEqual(['powershell.exe', ['-NonInteractive', '-Command', 'S']]);
    expect(shellInvocation('win32', {}, 'S', false)).toEqual(['powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', 'S']]);
    expect(shellInvocation('linux', { SHELL: '/bin/zsh' }, 'S', true)).toEqual(['/bin/zsh', ['-ilc', 'S']]);
    expect(shellInvocation('linux', {}, 'S', false)).toEqual(['bash', ['-c', 'S']]);
  });
});

describe('getCodexLaunchInfo', () => {
  it('reports the project shim when the shell runs on the raw npm-injected PATH', async () => {
    const info = await launchInfo(rawEnv(projectBin, globalBin));
    expect(info).toEqual({ executable: path.join(projectBin, shimName()), version: 'codex-cli 0.153.2', error: null });
  }, 30_000);

  it('reports the global copy when the shell runs on the filtered launch env built from the same PATH', async () => {
    const info = await launchInfo(launchEnvFor(projectBin, globalBin));
    expect(info).toEqual({ executable: path.join(globalBin, shimName()), version: 'codex-cli 0.154.0', error: null });
  }, 30_000);

  it('reports a not-found error instead of throwing when the shell finds no codex', async () => {
    const info = await launchInfo({ ...process.env, PATH: [path.join(root, 'empty'), BASE_PATH].join(delimiter) });
    expect(info.executable).toBeNull();
    expect(info.version).toBeNull();
    expect(info.error).toMatch(/not found/i);
  }, 30_000);
});

describe('runBoundedCommand', () => {
  it('rejects at the time bound and kills the whole process tree, not just its head', async () => {
    const marker = path.join(root, 'slow', 'started.txt');
    const exe = writeSlowShim(path.join(root, 'slow'), marker);
    // Run the shim the way the shell would (cmd.exe for a .cmd), so the chain
    // has a head and a grandchild like the real powershell -> cmd -> ping.
    const [file, args] = win32 ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', exe]] : [exe, []];
    const run = runBoundedCommand(file, args, process.env, root, 1500);
    // The shim must have reached its grandchild spawn before the bound fires,
    // otherwise "nothing survived" would be vacuous.
    expect(await waitFor(() => fs.existsSync(marker), 1400)).toBe(true);
    await expect(run).rejects.toThrow(/timed out/);
    // The head died with the timeout; ping/sleep (the grandchild) only dies
    // if the tree kill worked.
    expect(await waitFor(() => countSlowGrandchildren() === 0, 8000)).toBe(true);
  }, 20_000);
});
