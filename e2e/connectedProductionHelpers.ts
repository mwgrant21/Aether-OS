import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export async function launchConnectedProduction(): Promise<{
  app: ElectronApplication; window: Page; root: string; command(value: string): void;
}> {
  if (process.platform !== 'win32') throw new Error('Native fixture requires Windows');
  const root = mkdtempSync(join(tmpdir(), 'aether-connected-production-'));
  const bin = join(root, 'bin'); mkdirSync(bin); mkdirSync(join(root, 'profile'));
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const executable = join(bin, 'claude.exe');
  execFileSync(join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:exe', `/out:${executable}`, resolve('e2e/fixtures/connected-client.cs')], { windowsHide: true });
  const capture = JSON.parse(readFileSync(resolve('electron/__fixtures__/trust-prompt-capture.json'), 'utf8'));
  writeFileSync(join(bin, 'prompt.txt'), capture.chunks.map((chunk: { data: string }) => chunk.data).join(''));
  writeFileSync(join(bin, 'control'), '0:clear');
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, { USERPROFILE: root, HOME: root, APPDATA: join(root, 'AppData/Roaming'),
    LOCALAPPDATA: join(root, 'AppData/Local'), CODEX_HOME: join(root, '.codex'),
    PATH: [bin, join(windows, 'System32/WindowsPowerShell/v1.0'), join(windows, 'System32'), windows].join(';') });
  const entry = join(root, 'bootstrap.cjs');
  writeFileSync(entry, `
const { app, dialog } = require('electron');
const os = require('node:os');
os.homedir = () => ${JSON.stringify(root)};
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))});
// Only the owned harmless native fixture is authorized by this test dialog.
dialog.showMessageBox = async (options) => {
  if (options.title !== 'Start connected Claude?') throw new Error('Unexpected confirmation');
  return { response: 1, checkboxChecked: false };
};
const cp = require('node:child_process');
const originalSpawn = cp.spawn;
cp.spawn = (file, args = [], options) => {
  const fixtureVersion = file === ${JSON.stringify(executable)} && args.length === 1 && args[0] === '--version';
  if (!fixtureVersion && (file === process.execPath || /claude|codex|codex-acp/i.test(file)))
    throw new Error('Model process forbidden in connected fixture');
  return originalSpawn(file, args, options);
};
require('node:module').syncBuiltinESMExports();
global.__connectedEvidence = { writes: [], resizes: [], pids: [], output: [] };
app.__connectedEvidence = global.__connectedEvidence;
const pty = require(${JSON.stringify(resolve('node_modules/node-pty'))});
const originalPtySpawn = pty.spawn;
pty.spawn = (file, args, options) => {
  if (file !== 'powershell.exe' || !args.includes('-File')) throw new Error('Only connected native shell allowed');
  const child = originalPtySpawn(file, ['-NoProfile', ...args], options);
  global.__connectedEvidence.pids.push(child.pid);
  child.onData(data => global.__connectedEvidence.output.push(data));
  const write = child.write.bind(child), resize = child.resize.bind(child);
  child.write = input => { global.__connectedEvidence.writes.push(input); return write(input); };
  child.resize = (cols, rows) => { global.__connectedEvidence.resizes.push([cols, rows]); return resize(cols, rows); };
  return child;
};
import(${JSON.stringify(new URL('../out/main/main.js', import.meta.url).href)});
`);
  const app = await electron.launch({ args: [entry, ...(process.env.CI || process.env.E2E_DISABLE_GPU ? ['--disable-gpu'] : [])], env });
  const window = await app.firstWindow(); await window.waitForLoadState('domcontentloaded');
  let sequence = 0;
  return { app, window, root, command: value => writeFileSync(join(bin, 'control'), `${++sequence}:${value}`) };
}
