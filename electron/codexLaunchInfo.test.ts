import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function writeSlowShim(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  if (win32) {
    const file = path.join(dir, 'codex.cmd');
    fs.writeFileSync(file, `@echo off\r\nping -n 6 127.0.0.1 >nul\r\necho codex-cli 0.0.0\r\n`);
    return file;
  }
  const file = path.join(dir, 'codex');
  fs.writeFileSync(file, `#!/bin/sh\nsleep 5\necho "codex-cli 0.0.0"\n`, { mode: 0o755 });
  return file;
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
    const env = buildCodexPtyEnv({ PATH: [projectBin, globalBin].join(delimiter) }, root, platform);
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

  it('rejects when the executable exceeds the time bound', async () => {
    const exe = writeSlowShim(path.join(root, 'slow'));
    await expect(probeCodexVersion(exe, process.env, 300)).rejects.toThrow();
  });
});

describe('getCodexLaunchInfo', () => {
  it('reports the executable and version the filtered launch env will actually run', async () => {
    const env = buildCodexPtyEnv({ PATH: [projectBin, globalBin].join(delimiter) }, root, platform);
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
