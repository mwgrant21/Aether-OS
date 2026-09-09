import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  STATUSLINE_UNINSTALL_FLAG,
  resolveStatuslineScriptPath,
  runStatuslineUninstall,
} from './statuslineUninstallCli';

// String.raw, NOT a plain quoted string. Written as '...\Program Files\Aether
// OS\resources\...' this consumed \P \A \r \s \a as JS escapes and produced a
// path with a carriage return in it and not one backslash -- so every test
// below ran against a string no Windows install could ever produce, and the
// strict command parser rightly refused to recognise it as ours.
const SCRIPT_PATH = String.raw`C:\Program Files\Aether OS\resources\scripts\aether-statusline.mjs`;

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

// Both cases below come from readInstallState's status being a SUBSTRING test
// (`existingCommand.includes(scriptPath)`), which is too weak to gate a
// destructive write. runStatuslineUninstall re-checks with the strict
// full-command parser migration already uses.
describe('runStatuslineUninstall ownership guard (strict parse, not status alone)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-uninstall-guard-test-'));
  const settingsPath = join(dir, 'settings.json');

  // String.raw so these are literal Windows paths. Two DIFFERENT install
  // directories, which is the whole point: electron-builder.yml sets
  // allowToChangeInstallationDirectory, so an update can land elsewhere.
  const CURRENT = String.raw`C:\Program Files\Aether OS\resources\scripts\aether-statusline.mjs`;
  const PREVIOUS = String.raw`C:\Program Files\Aether OS 0.9\resources\scripts\aether-statusline.mjs`;

  const backups = () => readdirSync(dir).filter((f) => f.includes('.aetherbak-'));
  const write = (command: string) =>
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command } }));

  afterEach(() => {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  });

  // status is 'installed' (the command DOES contain our script path), but the
  // user appended their own tool. Deleting the entry -- or restoring only the
  // loosely-scanned --chain -- would discard that during an unattended
  // uninstall nobody is watching.
  it('refuses to rewrite a CUSTOMISED command that references our script, and reports it', async () => {
    const chained = Buffer.from('other-tool', 'utf8').toString('base64');
    const command = `node "${CURRENT}" --chain ${chained} && my-own-tool`;
    write(command);
    const original = readFileSync(settingsPath, 'utf8');

    const result = await runStatuslineUninstall(settingsPath, CURRENT, () => true);

    expect(result.code).toBe(1);
    expect(result.message).toContain('modified');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(backups()).toEqual([]);
  });

  it('refuses a bare extra argument too, not just a chained second command', async () => {
    write(`node "${CURRENT}" --verbose`);
    const original = readFileSync(settingsPath, 'utf8');

    const result = await runStatuslineUninstall(settingsPath, CURRENT, () => true);

    expect(result.code).toBe(1);
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  // The update-to-a-new-directory case: the command is ours verbatim but names
  // the PREVIOUS install, so status comes back 'installed-other'. Exiting 0
  // there suppressed installer.nsh's warning and left the dead command behind.
  it('cleans up our OWN stale command from a previous install whose script is gone', async () => {
    const chained = 'powershell -File "C:\\tools\\line.ps1"';
    const command = `node "${PREVIOUS}" --chain ${Buffer.from(chained, 'utf8').toString('base64')}`;
    write(command);

    const result = await runStatuslineUninstall(settingsPath, CURRENT, () => false);

    expect(result.code).toBe(0);
    expect(result.message).toContain('stale statusline from a previous install');

    // The chained third-party tool survives, exactly as it does on a normal
    // uninstall -- that promise has to hold across a directory move too.
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toEqual({ type: 'command', command: chained });
    expect(written.model).toBe('opus');
    expect(backups()).toHaveLength(1);
  });

  it('deletes statusLine outright when the stale command carried no chain', async () => {
    write(`node "${PREVIOUS}"`);

    const result = await runStatuslineUninstall(settingsPath, CURRENT, () => false);

    expect(result.code).toBe(0);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toBeUndefined();
    expect(written.model).toBe('opus');
  });

  // The guard on the guard: "ours by shape" is not enough to delete it. A
  // second install that is still on disk may be one the user runs on purpose.
  it('leaves our own command alone when the install it names still exists', async () => {
    write(`node "${PREVIOUS}"`);
    const original = readFileSync(settingsPath, 'utf8');

    const result = await runStatuslineUninstall(settingsPath, CURRENT, (p) => p === PREVIOUS);

    expect(result.code).toBe(0);
    expect(result.message).toContain('another install');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(backups()).toEqual([]);
  });

  // A stranger's tool must still be a silent, clean no-op -- the stale-cleanup
  // path above must not widen into deleting things we never wrote.
  it('still leaves a foreign command untouched even though its script is missing', async () => {
    write('npx claude-powerline');
    const original = readFileSync(settingsPath, 'utf8');

    const result = await runStatuslineUninstall(settingsPath, CURRENT, () => false);

    expect(result.code).toBe(0);
    expect(result.message).toContain('installed-other');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(backups()).toEqual([]);
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
