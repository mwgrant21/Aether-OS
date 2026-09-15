import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCodexPtyEnv } from './codexPtyManager';
import { resolveCodexExecutable, probeCodexVersion, getCodexLaunchInfo } from './codexLaunchInfo';

// One harmless on-disk fixture, laid out like the real failure: a "project"
// copy of the codex shim under node_modules/.bin (what npm injects) and a
// "global" copy in a plain bin dir (what the operator installed). The same
// PATH must resolve to the project copy through Electron's raw env and to the
// global copy through the terminal's filtered launch env -- and the version
// the readout reports must come from the copy that will actually launch.
const win32 = process.platform === 'win32';
const platform = process.platform;
const delimiter = win32 ? ';' : ':';

let root: string;
let projectBin: string;
let globalBin: string;

function writeShim(dir: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true });
  if (win32) {
    const file = path.join(dir, 'codex.cmd');
    fs.writeFileSync(file, `@echo off\r\necho codex-cli ${version}\r\n`);
    return file;
  }
  const file = path.join(dir, 'codex');
  fs.writeFileSync(file, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return file;
}

// A shim that wedges the way a broken install would: it spawns a long-lived
// grandchild (ping / sleep with a distinctive argument, so it can be found by
// command line afterwards) and writes a marker file first so the test knows
// the grandchild was really launched before the timeout fired.
const SLOW_MARK = 'aether-probe-47';
function writeSlowShim(dir: string, marker: string): string {
  fs.mkdirSync(dir, { recursive: true });
  if (win32) {
    const file = path.join(dir, 'codex.cmd');
    fs.writeFileSync(file, `@echo off\r\necho started > "${marker}"\r\nping -n 47 127.0.0.1 >nul\r\necho codex-cli 0.0.0\r\n`);
    return file;
  }
  const file = path.join(dir, 'codex');
  fs.writeFileSync(file, `#!/bin/sh\necho started > "${marker}"\nsleep 47\necho "codex-cli 0.0.0"\n`, { mode: 0o755 });
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

// The launch env the real terminal gets: built from a PATH carrying the npm
// markers npm itself sets for a `npm run` launch (package dir = the project).
function launchEnvFor(pathValue: string): NodeJS.ProcessEnv {
  return buildCodexPtyEnv(
    { PATH: pathValue, npm_execpath: 'fake-npm-cli.js', npm_config_local_prefix: path.join(root, 'proj') },
    root,
    platform,
  );
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

describe('resolveCodexExecutable', () => {
  it('returns the project shim from the raw npm-injected PATH', () => {
    const env = { PATH: [projectBin, globalBin].join(delimiter) };
    expect(resolveCodexExecutable(env, platform)).toBe(path.join(projectBin, win32 ? 'codex.cmd' : 'codex'));
  });

  it('returns the global copy from the filtered launch env built from the same PATH', () => {
    const env = launchEnvFor([projectBin, globalBin].join(delimiter));
    expect(resolveCodexExecutable(env, platform)).toBe(path.join(globalBin, win32 ? 'codex.cmd' : 'codex'));
  });

  it('returns null when no PATH entry holds a codex executable', () => {
    expect(resolveCodexExecutable({ PATH: path.join(root, 'empty') }, platform)).toBeNull();
    expect(resolveCodexExecutable({}, platform)).toBeNull();
  });
});

describe('probeCodexVersion', () => {
  it('returns the trimmed --version output of the given executable', async () => {
    const exe = path.join(globalBin, win32 ? 'codex.cmd' : 'codex');
    await expect(probeCodexVersion(exe, process.env, 10_000)).resolves.toBe('codex-cli 0.154.0');
  });

  it('rejects at the time bound and kills the whole probe process tree, not just its head', async () => {
    const marker = path.join(root, 'slow', 'started.txt');
    const exe = writeSlowShim(path.join(root, 'slow'), marker);
    const probe = probeCodexVersion(exe, process.env, 1500);
    // The shim must have reached its grandchild spawn before the bound fires,
    // otherwise "nothing survived" would be vacuous.
    expect(await waitFor(() => fs.existsSync(marker), 1400)).toBe(true);
    await expect(probe).rejects.toThrow(/timed out/);
    // cmd.exe/sh (the head) died with the timeout; ping/sleep (the
    // grandchild) only dies if the tree kill worked.
    expect(await waitFor(() => countSlowGrandchildren() === 0, 8000)).toBe(true);
  }, 20_000);
});

describe('getCodexLaunchInfo', () => {
  it('reports the executable and version the filtered launch env will actually run', async () => {
    const env = launchEnvFor([projectBin, globalBin].join(delimiter));
    const info = await getCodexLaunchInfo(env, platform);
    expect(info).toEqual({
      executable: path.join(globalBin, win32 ? 'codex.cmd' : 'codex'),
      version: 'codex-cli 0.154.0',
      error: null,
    });
  });

  it('reports a not-found error instead of throwing when codex is absent', async () => {
    const info = await getCodexLaunchInfo({ PATH: path.join(root, 'empty') }, platform);
    expect(info.executable).toBeNull();
    expect(info.version).toBeNull();
    expect(info.error).toMatch(/not found/i);
  });
});
