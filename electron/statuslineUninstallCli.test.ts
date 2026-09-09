import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  STATUSLINE_UNINSTALL_FLAG,
  resolveStatuslineScriptPath,
  runStatuslineUninstall,
} from './statuslineUninstallCli';

const SCRIPT_PATH = 'C:\Program Files\Aether OS\resources\scripts\aether-statusline.mjs';

describe('resolveStatuslineScriptPath', () => {
  it('resolves under resourcesPath when packaged (scripts/ ships unpacked, beside app.asar)', () => {
    expect(
      resolveStatuslineScriptPath({
        isPackaged: true,
        resourcesPath: join('C:', 'app', 'resources'),
        appPath: join('C:', 'app', 'resources', 'app.asar'),
      })
    ).toBe(join('C:', 'app', 'resources', 'scripts', 'aether-statusline.mjs'));
  });

  it('resolves under appPath in dev, where there is no asar and scripts/ sits in the repo', () => {
    expect(
      resolveStatuslineScriptPath({
        isPackaged: false,
        resourcesPath: join('C:', 'ignored'),
        appPath: join('C:', 'repo'),
      })
    ).toBe(join('C:', 'repo', 'scripts', 'aether-statusline.mjs'));
  });
});

describe('runStatuslineUninstall', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-uninstall-cli-test-'));
  const settingsPath = join(dir, 'settings.json');

  const backups = () => readdirSync(dir).filter((f) => f.includes('.aetherbak-'));

  afterEach(() => {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  });

  it('succeeds as a no-op when settings.json does not exist', async () => {
    const result = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
    expect(result.code).toBe(0);
    expect(result.message).toContain('not-installed');
    expect(backups()).toEqual([]);
  });

  it('succeeds as a no-op when settings.json has no statusLine at all', async () => {
    writeFileSync(settingsPath, '{"model":"opus"}');
    const result = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
    expect(result.code).toBe(0);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"model":"opus"}');
    expect(backups()).toEqual([]);
  });

  // The reason this module exists rather than calling uninstallStatusline
  // directly: uninstallStatusline deletes whatever statusLine it finds, which is
  // safe behind the app's UI (it only offers uninstall when the state is
  // 'installed') and would silently delete a stranger's tool here, where the
  // Windows uninstaller calls this unconditionally.
  it('leaves a FOREIGN statusLine command completely untouched', async () => {
    const foreign = '{"statusLine":{"type":"command","command":"npx claude-powerline"}}';
    writeFileSync(settingsPath, foreign);
    const result = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
    expect(result.code).toBe(0);
    expect(result.message).toContain('installed-other');
    expect(readFileSync(settingsPath, 'utf8')).toBe(foreign);
    expect(backups()).toEqual([]);
  });

  it('refuses to rewrite a settings.json it could not parse, and reports it as a FAILURE', async () => {
    // Previously exit 0. That suppressed installer.nsh's manual-fix warning, so
    // the uninstaller deleted the script, left a possibly-live command pointing
    // at it, and told the user the uninstall was clean. We cannot parse the
    // file, so we cannot know the command is gone -- that is a failure to
    // report, not a no-op to swallow.
    const malformed = '{"statusLine": broken';
    writeFileSync(settingsPath, malformed);
    const result = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
    expect(result.code).toBe(1);
    expect(result.message).toContain('unreadable');
    expect(readFileSync(settingsPath, 'utf8')).toBe(malformed);
  });

  it('still reports a clean no-op for the two states it genuinely understands', async () => {
    // The unreadable case above must not drag these with it: both are known
    // states needing no action, and a nonzero exit here would cry wolf on every
    // uninstall of an install that never enabled the statusline.
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));
    const notInstalled = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
    expect(notInstalled.code).toBe(0);

    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'other-tool' } }));
    const other = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
    expect(other.code).toBe(0);
    expect(other.message).toContain('installed-other');
  });

  it('removes our own statusLine, preserves unrelated keys, and backs the file up first', async () => {
    const original = JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: `node "${SCRIPT_PATH}"` } });
    writeFileSync(settingsPath, original);

    const result = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
    expect(result.code).toBe(0);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toBeUndefined();
    expect(written.model).toBe('opus');

    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(dir, backups()[0]), 'utf8')).toBe(original);
  });

  it('restores the chained tool instead of deleting statusLine outright', async () => {
    const chained = 'powershell -File "C:\has spaces\line.ps1"';
    const command = `node "${SCRIPT_PATH}" --chain ${Buffer.from(chained, 'utf8').toString('base64')}`;
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command } }));

    const result = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
    expect(result.code).toBe(0);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toEqual({ type: 'command', command: chained });
  });

  // A non-zero code is what makes build/installer.nsh print its manual-fix
  // instructions instead of reporting a clean uninstall.
  it('reports a non-zero exit code when the write fails, leaving settings.json intact', async () => {
    const original = JSON.stringify({ statusLine: { type: 'command', command: `node "${SCRIPT_PATH}"` } });
    writeFileSync(settingsPath, original);

    const spy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('EACCES: simulated rename failure'));
    try {
      const result = await runStatuslineUninstall(settingsPath, SCRIPT_PATH);
      expect(result.code).toBe(1);
      expect(result.message).toContain('simulated rename failure');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });
});

// The installer and the app agree on this flag by string only -- nothing at
// build time links them. Renaming the constant without updating the NSIS hook
// would leave the uninstaller invoking a flag the app ignores, which boots the
// full app during an uninstall instead of cleaning up.
describe('the NSIS uninstall hook and the app agree on the flag', () => {
  it('build/installer.nsh invokes the executable with STATUSLINE_UNINSTALL_FLAG', () => {
    const nsh = readFileSync(join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
    expect(nsh).toContain('!macro customUnInstall');
    expect(nsh).toContain(STATUSLINE_UNINSTALL_FLAG);
  });

  it('guards the hook on ${isUpdated} so an upgrade does not silently disable the statusline', () => {
    const nsh = readFileSync(join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
    const macro = nsh.slice(nsh.indexOf('!macro customUnInstall'));
    expect(macro).toContain('${ifNot} ${isUpdated}');
  });
});
