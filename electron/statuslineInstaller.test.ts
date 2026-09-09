import { describe, expect, it, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  detectInstallStatus,
  extractChainedCommand,
  installStatusline,
  migrateStatuslineScriptPath,
  parseOwnStatuslineCommand,
  readInstallState,
  statuslineSettingsPatch,
  uninstallStatusline,
} from './statuslineInstaller';

const SCRIPT_PATH = 'C:\\Users\\test\\.aether-os\\aether-statusline.mjs';

describe('statuslineSettingsPatch', () => {
  it('produces a command-type statusLine patch referencing the script path', () => {
    const patch = statuslineSettingsPatch(SCRIPT_PATH);
    expect(patch.statusLine.type).toBe('command');
    expect(patch.statusLine.command).toContain(SCRIPT_PATH);
  });

  it('embeds no --chain argument when chainCommand is omitted or null', () => {
    expect(statuslineSettingsPatch(SCRIPT_PATH).statusLine.command).not.toContain('--chain');
    expect(statuslineSettingsPatch(SCRIPT_PATH, null).statusLine.command).not.toContain('--chain');
  });

  it('embeds chainCommand as a base64 --chain argument, round-trippable via extractChainedCommand', () => {
    const foreignCommand = 'powershell -File "C:\\has spaces\\script.ps1" -Arg "quoted value"';
    const patch = statuslineSettingsPatch(SCRIPT_PATH, foreignCommand);
    expect(patch.statusLine.command).toContain(SCRIPT_PATH);
    expect(patch.statusLine.command).toContain('--chain ');
    expect(extractChainedCommand(patch.statusLine.command)).toBe(foreignCommand);
  });
});

describe('extractChainedCommand', () => {
  it('returns null for a plain (unchained) command', () => {
    expect(extractChainedCommand(`node "${SCRIPT_PATH}"`)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractChainedCommand(null)).toBeNull();
  });

  it('returns null for a malformed --chain argument (not valid base64-decodable content)', () => {
    // Buffer.from(..., 'base64') never throws on arbitrary text -- it just
    // decodes best-effort. An empty decode result is what must map to null.
    expect(extractChainedCommand(`node "${SCRIPT_PATH}" --chain`)).toBeNull();
  });

  it('decodes a real --chain argument back to the original command', () => {
    const original = 'npx claude-powerline';
    const command = `node "${SCRIPT_PATH}" --chain ${Buffer.from(original, 'utf8').toString('base64')}`;
    expect(extractChainedCommand(command)).toBe(original);
  });
});

describe('detectInstallStatus', () => {
  it('is not-installed when the key is absent', () => {
    expect(detectInstallStatus({}, SCRIPT_PATH)).toEqual({ status: 'not-installed', existingCommand: null });
  });

  it('is installed when the configured command references scriptPath', () => {
    const settings = { statusLine: { type: 'command', command: `node "${SCRIPT_PATH}"` } };
    expect(detectInstallStatus(settings, SCRIPT_PATH)).toEqual({
      status: 'installed',
      existingCommand: `node "${SCRIPT_PATH}"`,
    });
  });

  it('is installed-other when statusLine points somewhere else', () => {
    const settings = { statusLine: { type: 'command', command: 'npx claude-powerline' } };
    expect(detectInstallStatus(settings, SCRIPT_PATH)).toEqual({
      status: 'installed-other',
      existingCommand: 'npx claude-powerline',
    });
  });

  it('is installed-other when statusLine has an unrecognized shape', () => {
    const settings = { statusLine: { type: 'command' } };
    expect(detectInstallStatus(settings, SCRIPT_PATH)).toEqual({
      status: 'installed-other',
      existingCommand: null,
    });
  });

  it('is unreadable when the parsed settings are not a non-null object', () => {
    expect(detectInstallStatus(null, SCRIPT_PATH).status).toBe('unreadable');
    expect(detectInstallStatus('nope', SCRIPT_PATH).status).toBe('unreadable');
    expect(detectInstallStatus(42, SCRIPT_PATH).status).toBe('unreadable');
  });

  it('is unreadable for a top-level array, matching the write-side guard', () => {
    // typeof [] === 'object' in JS, so this must be excluded explicitly --
    // otherwise it would misclassify as 'not-installed' here while
    // installStatusline/uninstallStatusline (which do exclude arrays) abort,
    // leaving a caller that trusted readInstallState surprised.
    expect(detectInstallStatus([1, 2, 3], SCRIPT_PATH)).toEqual({ status: 'unreadable', existingCommand: null });
  });
});

describe('readInstallState / installStatusline / uninstallStatusline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-installer-test-'));
  const settingsPath = join(dir, 'settings.json');

  afterEach(() => {
    rmSync(settingsPath, { force: true });
  });

  it('installs into a missing settings file', async () => {
    const result = await installStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeNull();

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine.command).toContain(SCRIPT_PATH);
  });

  it('installs into an existing file, preserving unrelated keys verbatim', async () => {
    const original = { sentinel: 'keep-me', nested: { untouched: true } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const result = await installStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.sentinel).toBe('keep-me');
    expect(written.nested).toEqual({ untouched: true });
    expect(written.statusLine.command).toContain(SCRIPT_PATH);

    rmSync(result.backupPath!, { force: true });
  });

  it('creates a backup file containing the original content before installing', async () => {
    const original = { sentinel: 'original-bytes' };
    const originalRaw = JSON.stringify(original, null, 2);
    writeFileSync(settingsPath, originalRaw, 'utf8');

    const result = await installStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();

    const backupRaw = readFileSync(result.backupPath!, 'utf8');
    expect(backupRaw).toBe(originalRaw);

    rmSync(result.backupPath!, { force: true });
  });

  it('surfaces installed-other via readInstallState instead of silently overwriting', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'npx claude-powerline' } }),
      'utf8'
    );

    const state = await readInstallState(settingsPath, SCRIPT_PATH);
    expect(state.status).toBe('installed-other');
    expect(state.existingCommand).toBe('npx claude-powerline');

    // The settings file itself must be untouched by merely reading state.
    const stillThere = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(stillThere.statusLine.command).toBe('npx claude-powerline');
  });

  it('aborts on malformed JSON, leaving the original file completely untouched', async () => {
    const original = '{ "sentinel": "keep-me", not valid json here';
    writeFileSync(settingsPath, original, 'utf8');

    const result = await installStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    // Assert the exact original bytes, not just "some content" -- no backup,
    // no partial write, nothing.
    const afterBytes = readFileSync(settingsPath, 'utf8');
    expect(afterBytes).toBe(original);
  });

  it.each([
    ['a top-level array', '[1,2,3]'],
    ['a top-level string', '"hello"'],
    ['a top-level number', '42'],
  ])('aborts installStatusline on valid but non-object JSON (%s), leaving the file untouched', async (_label, original) => {
    writeFileSync(settingsPath, original, 'utf8');

    const result = await installStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const afterBytes = readFileSync(settingsPath, 'utf8');
    expect(afterBytes).toBe(original);
  });

  it.each([
    ['a top-level array', '[1,2,3]'],
    ['a top-level string', '"hello"'],
    ['a top-level number', '42'],
  ])('aborts uninstallStatusline on valid but non-object JSON (%s), leaving the file untouched', async (_label, original) => {
    writeFileSync(settingsPath, original, 'utf8');

    const result = await uninstallStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const afterBytes = readFileSync(settingsPath, 'utf8');
    expect(afterBytes).toBe(original);
  });

  it('installStatusline chains an installed-other statusLine rather than discarding it, backing up the original config', async () => {
    const original = {
      sentinel: 'keep-me',
      statusLine: { type: 'command', command: 'npx claude-powerline' },
    };
    const originalRaw = JSON.stringify(original, null, 2);
    writeFileSync(settingsPath, originalRaw, 'utf8');

    const result = await installStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine.command).toContain(SCRIPT_PATH);
    expect(written.sentinel).toBe('keep-me');
    // The foreign command isn't lost -- it's embedded as a --chain argument,
    // decodable back to the exact original string.
    expect(extractChainedCommand(written.statusLine.command)).toBe('npx claude-powerline');

    const backupRaw = readFileSync(result.backupPath!, 'utf8');
    expect(backupRaw).toBe(originalRaw);
    expect(JSON.parse(backupRaw).statusLine.command).toBe('npx claude-powerline');

    rmSync(result.backupPath!, { force: true });
  });

  it('re-installing over an existing Aether chain carries the chain forward unchanged', async () => {
    const chained = `node "${SCRIPT_PATH}" --chain ${Buffer.from('npx claude-powerline', 'utf8').toString('base64')}`;
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: chained } }), 'utf8');

    const result = await installStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(extractChainedCommand(written.statusLine.command)).toBe('npx claude-powerline');

    rmSync(result.backupPath!, { force: true });
  });

  it('uninstall with no chain removes only the statusLine key', async () => {
    const original = { sentinel: 'keep-me', statusLine: { type: 'command', command: `node "${SCRIPT_PATH}"` } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const result = await uninstallStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toBeUndefined();
    expect(written.sentinel).toBe('keep-me');

    rmSync(result.backupPath!, { force: true });
  });

  it('uninstall with a chain restores the chained command instead of deleting statusLine', async () => {
    const chained = `node "${SCRIPT_PATH}" --chain ${Buffer.from('npx claude-powerline', 'utf8').toString('base64')}`;
    const original = { sentinel: 'keep-me', statusLine: { type: 'command', command: chained } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const result = await uninstallStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toEqual({ type: 'command', command: 'npx claude-powerline' });
    expect(written.sentinel).toBe('keep-me');

    rmSync(result.backupPath!, { force: true });
  });

  it('uninstall on a file with no statusLine succeeds as a no-op (no backup written)', async () => {
    const original = { sentinel: 'keep-me' };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const result = await uninstallStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeNull();

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written).toEqual(original);
  });

  it('uninstall on a missing file succeeds as a no-op', async () => {
    const result = await uninstallStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeNull();
  });

  it('uninstall aborts on malformed JSON, leaving the original file untouched', async () => {
    const original = '{ broken';
    writeFileSync(settingsPath, original, 'utf8');

    const result = await uninstallStatusline(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const afterBytes = readFileSync(settingsPath, 'utf8');
    expect(afterBytes).toBe(original);
  });
});

// Same write-path guarantees as collector/src/hookInstaller.ts (#59, #60):
// this installer writes the same ~/.claude/settings.json from a different
// process, so it must not collide with, or clean up after, the other writers.
describe('statuslineInstaller write path (#59, #60)', () => {
  const freshSettings = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'statusline-installer-writepath-'));
    const p = join(dir, 'settings.json');
    writeFileSync(p, content, 'utf8');
    return p;
  };
  const siblings = (p: string, marker: string) => readdirSync(dirname(p)).filter((f) => f.includes(marker));

  it('keeps both backups when two writes share the same millisecond', async () => {
    const original = '{"sentinel":"pristine"}';
    const settingsPath = freshSettings(original);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1700000000000));
    try {
      const first = await installStatusline(settingsPath, SCRIPT_PATH);
      const afterFirst = readFileSync(settingsPath, 'utf8');
      const second = await uninstallStatusline(settingsPath, SCRIPT_PATH);
      expect(first.ok && second.ok).toBe(true);
      expect(first.backupPath).toBeTruthy();
      expect(second.backupPath).toBeTruthy();
      expect(first.backupPath).not.toBe(second.backupPath);
      expect(readFileSync(first.backupPath!, 'utf8')).toBe(original);
      expect(readFileSync(second.backupPath!, 'utf8')).toBe(afterFirst);
      expect(siblings(settingsPath, '.aetherbak-')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports failure, leaves settings.json byte-identical, and leaves no temp file when the rename fails', async () => {
    const settingsPath = freshSettings('{"sentinel":"keep"}');
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('EACCES: simulated rename failure'));
    try {
      const result = await installStatusline(settingsPath, SCRIPT_PATH);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('simulated rename failure');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"sentinel":"keep"}');
    expect(siblings(settingsPath, '.aethertmp-')).toEqual([]);
  });

  it('leaves another writer\'s temp file alone when exclusive creation loses the name (EEXIST)', async () => {
    const settingsPath = freshSettings('{}');
    const realWriteFile = fsp.writeFile.bind(fsp);
    let contested = '';
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      if (String(file).includes('.aethertmp-')) {
        contested = String(file);
        await realWriteFile(file, '{"other":"writer"}', 'utf8');
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      }
      return realWriteFile(file, data, options);
    });
    try {
      expect((await installStatusline(settingsPath, SCRIPT_PATH)).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(contested).not.toBe('');
    expect(readFileSync(contested, 'utf8')).toBe('{"other":"writer"}');
  });
});

describe('parseOwnStatuslineCommand', () => {
  it('recognises our own command and its chain', () => {
    const chained = 'powershell -File "C:\\other\\tool.ps1"';
    const cmd = statuslineSettingsPatch(SCRIPT_PATH, chained).statusLine.command;
    expect(parseOwnStatuslineCommand(cmd)).toEqual({ scriptPath: SCRIPT_PATH, chain: chained });
    expect(parseOwnStatuslineCommand(`node "${SCRIPT_PATH}"`)).toEqual({ scriptPath: SCRIPT_PATH, chain: null });
  });

  it('recognises the path shape regardless of the HOST platform', () => {
    // This parses a string out of a config file, so it must not depend on the
    // separator semantics of whatever machine happens to be running. Using
    // path.basename() here passed on Windows and failed on the Linux CI runner:
    // POSIX basename() treats "\" as an ordinary character, so a Windows path
    // has no separator at all and the whole string comes back as the leaf.
    // Both shapes must parse on both platforms.
    const windows = 'C:\\Program Files\\Aether OS\\resources\\scripts\\aether-statusline.mjs';
    const posix = '/opt/aether-os/resources/scripts/aether-statusline.mjs';
    expect(parseOwnStatuslineCommand(`node "${windows}"`)?.scriptPath).toBe(windows);
    expect(parseOwnStatuslineCommand(`node "${posix}"`)?.scriptPath).toBe(posix);
    // ...and a same-shaped path to somebody else's script still must not match.
    expect(parseOwnStatuslineCommand('node "C:\\tools\\their-statusline.mjs"')).toBeNull();
    expect(parseOwnStatuslineCommand('node "/opt/tools/their-statusline.mjs"')).toBeNull();
  });

  it('refuses anything it cannot prove it wrote itself', () => {
    // This is the gate on rewriting a user's settings.json unasked, so each of
    // these must fall through as "not ours" rather than be leniently accepted.
    expect(parseOwnStatuslineCommand(null)).toBeNull();
    expect(parseOwnStatuslineCommand('powershell -File "C:\\other\\tool.ps1"')).toBeNull();
    expect(parseOwnStatuslineCommand('node "C:\\somewhere\\other-script.mjs"')).toBeNull();
    // Right basename, but not the shape we write -- unquoted, so a path with
    // spaces would already be mis-parsed. Not ours to touch.
    expect(parseOwnStatuslineCommand(`node ${SCRIPT_PATH}`)).toBeNull();
    // A different tool that merely mentions our script name in an argument.
    expect(parseOwnStatuslineCommand(`wrapper --run "aether-statusline.mjs"`)).toBeNull();
  });

  it('refuses a command carrying anything we did not emit after the path', () => {
    // A prefix-only match would call these ours and then rewrite them from the
    // parsed path and chain alone, silently dropping the trailing flag or the
    // second command. Migration edits settings.json unasked, so a hand-edited
    // command must be left for the human instead.
    expect(parseOwnStatuslineCommand(`node "${SCRIPT_PATH}" --custom-flag`)).toBeNull();
    expect(parseOwnStatuslineCommand(`node "${SCRIPT_PATH}" && other-tool`)).toBeNull();
    expect(parseOwnStatuslineCommand(`node "${SCRIPT_PATH}" | tee log.txt`)).toBeNull();
    expect(parseOwnStatuslineCommand(`node "${SCRIPT_PATH}" --chain abc123 --extra`)).toBeNull();
    // Not base64 in the chain slot -- not a shape we emit either.
    expect(parseOwnStatuslineCommand(`node "${SCRIPT_PATH}" --chain "quoted thing"`)).toBeNull();
  });

  it('still accepts exactly what statuslineSettingsPatch emits, chained or not', () => {
    // The anchoring above must not become so strict that it stops recognising
    // our own output -- that would silently disable migration entirely.
    const plain = statuslineSettingsPatch(SCRIPT_PATH).statusLine.command;
    const chainedCmd = statuslineSettingsPatch(SCRIPT_PATH, 'npx claude-powerline').statusLine.command;
    expect(parseOwnStatuslineCommand(plain)).toEqual({ scriptPath: SCRIPT_PATH, chain: null });
    expect(parseOwnStatuslineCommand(chainedCmd)).toEqual({
      scriptPath: SCRIPT_PATH,
      chain: 'npx claude-powerline',
    });
  });
});

describe('migrateStatuslineScriptPath', () => {
  const fresh = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'statusline-migrate-'));
    const p = join(dir, 'settings.json');
    writeFileSync(p, content, 'utf8');
    return p;
  };
  const NEW_SCRIPT = 'C:\\Program Files\\Aether OS v2\\resources\\scripts\\aether-statusline.mjs';
  const OLD_SCRIPT = 'C:\\Program Files\\Aether OS\\resources\\scripts\\aether-statusline.mjs';
  // The old install's script is gone; THIS install's script is present. A blanket
  // `() => false` would also claim our own script is missing, which the
  // dead-path guard correctly refuses to migrate to.
  const gone = (p: string) => p === NEW_SCRIPT;
  const stillThere = () => true;

  it('re-points a command left behind by an install that no longer exists', async () => {
    const settingsPath = fresh(JSON.stringify({ model: 'opus', ...statuslineSettingsPatch(OLD_SCRIPT) }));
    const result = await migrateStatuslineScriptPath(settingsPath, NEW_SCRIPT, gone);

    expect(result.migrated).toBe(true);
    expect(result.from).toBe(OLD_SCRIPT);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(after.statusLine.command).toContain(NEW_SCRIPT);
    expect(after.statusLine.command).not.toContain(OLD_SCRIPT);
    expect(after.model, 'unrelated keys must survive').toBe('opus');
    expect(result.backupPath, 'the original bytes must be recoverable').toBeTruthy();
  });

  it('carries a chained third-party tool across the move', async () => {
    // The installer chains rather than clobbers so the user's other statusline
    // tool keeps working. That promise has to survive a directory change too.
    const chained = 'powershell -File "C:\\has spaces\\theirs.ps1"';
    const settingsPath = fresh(JSON.stringify(statuslineSettingsPatch(OLD_SCRIPT, chained)));
    const result = await migrateStatuslineScriptPath(settingsPath, NEW_SCRIPT, gone);

    expect(result.migrated).toBe(true);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(extractChainedCommand(after.statusLine.command)).toBe(chained);
  });

  it('leaves a previous install alone while its script still exists', async () => {
    // A resolvable path is a live install -- possibly a second one the user
    // runs deliberately. Hijacking it would be the silent clobber this module
    // exists to avoid.
    const original = JSON.stringify(statuslineSettingsPatch(OLD_SCRIPT));
    const settingsPath = fresh(original);
    const result = await migrateStatuslineScriptPath(settingsPath, NEW_SCRIPT, stillThere);

    expect(result.migrated).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('never touches a foreign statusLine, even when its script is missing', async () => {
    const original = JSON.stringify({ statusLine: { type: 'command', command: 'their-tool --flag' } });
    const settingsPath = fresh(original);
    const result = await migrateStatuslineScriptPath(settingsPath, NEW_SCRIPT, gone);

    expect(result.migrated).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('never rewrites a settings.json it could not parse', async () => {
    const malformed = '{"statusLine": broken';
    const settingsPath = fresh(malformed);
    const result = await migrateStatuslineScriptPath(settingsPath, NEW_SCRIPT, gone);

    expect(result.migrated).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(malformed);
  });

  it('is a no-op when already pointing at this install, and when there is no statusLine', async () => {
    const current = JSON.stringify(statuslineSettingsPatch(NEW_SCRIPT));
    const a = fresh(current);
    expect((await migrateStatuslineScriptPath(a, NEW_SCRIPT, gone)).migrated).toBe(false);
    expect(readFileSync(a, 'utf8')).toBe(current);

    const none = JSON.stringify({ model: 'opus' });
    const b = fresh(none);
    expect((await migrateStatuslineScriptPath(b, NEW_SCRIPT, gone)).migrated).toBe(false);
    expect(readFileSync(b, 'utf8')).toBe(none);
  });

  it("refuses to migrate to a script THIS install does not have", async () => {
    // Mirrors the statusline:install guard in main.ts. Swapping a dangling
    // command for a different dangling command is not a repair -- it would
    // still break every Claude Code turn, just pointing somewhere new.
    const original = JSON.stringify(statuslineSettingsPatch(OLD_SCRIPT));
    const settingsPath = fresh(original);
    const nothingExists = () => false;
    const result = await migrateStatuslineScriptPath(settingsPath, NEW_SCRIPT, nothingExists);

    expect(result.migrated).toBe(false);
    expect(result.reason).toContain('refusing to write a dead path');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('leaves the file intact when the settings file does not exist at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'statusline-migrate-absent-'));
    const settingsPath = join(dir, 'settings.json');
    const result = await migrateStatuslineScriptPath(settingsPath, NEW_SCRIPT, gone);
    expect(result.migrated).toBe(false);
    expect(existsSync(settingsPath), 'must not create a settings.json that was not there').toBe(false);
  });
});
