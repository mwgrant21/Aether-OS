import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface LaunchedApp { app: ElectronApplication; window: Page }

/** Actual built main/preload/renderer, isolated from operator data and model CLIs.
 * Windows native PTY remains real; only shell profile loading is suppressed.
 * Temporary profiles remain available for diagnosing a failed run.
 */
export async function launchApp(): Promise<LaunchedApp> {
  if (process.platform !== 'win32') throw new Error('Isolated PTY smoke currently requires Windows');
  const root = mkdtempSync(join(tmpdir(), 'aether-e2e-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'profile'));
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\necho AETHER_E2E_${name.toUpperCase()}_FIXTURE_REAL_PTY_NO_MODEL\r\n`);
  }
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  env.USERPROFILE = root;
  env.HOME = root;
  env.APPDATA = join(root, 'AppData', 'Roaming');
  env.LOCALAPPDATA = join(root, 'AppData', 'Local');
  env.CLAUDE_CONFIG_DIR = join(root, '.claude');
  env.CODEX_HOME = join(root, '.codex');
  const windows = process.env.SystemRoot || 'C:\\Windows';
  env.PATH = [bin, join(windows, 'System32', 'WindowsPowerShell', 'v1.0'), join(windows, 'System32'), windows].join(';');
  const entry = join(root, 'bootstrap.cjs');
  // Resolve the same native PTY module used by the bundled production main.
  writeFileSync(entry, `
const { app } = require('electron');
const os = require('node:os');
os.homedir = () => ${JSON.stringify(root)};
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))});
const pty = require(${JSON.stringify(resolve('node_modules/node-pty'))});
// Embedded adapters use child_process rather than PTY/PATH. Fail closed if a smoke
// test ever reaches one of those model-starting actions.
const cp = require('node:child_process');
const originalChildSpawn = cp.spawn;
cp.spawn = (file, args = [], options) => {
  if (file === process.execPath || /claude|codex|codex-acp/i.test([file, ...args].join(' '))) {
    throw new Error('Model process forbidden in isolated smoke');
  }
  return originalChildSpawn(file, args, options);
};
require('node:module').syncBuiltinESMExports();
const originalSpawn = pty.spawn;
pty.spawn = (file, args, options) => {
  if (file !== 'powershell.exe') throw new Error('Unexpected PTY executable in isolated smoke');
  return originalSpawn(file, ['-NoProfile', ...args], options);
};
import(${JSON.stringify(new URL('../out/main/main.js', import.meta.url).href)});
`);
  const extraArgs = process.env.CI || process.env.E2E_DISABLE_GPU ? ['--disable-gpu'] : [];
  const app = await electron.launch({ args: [entry, ...extraArgs], env });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
