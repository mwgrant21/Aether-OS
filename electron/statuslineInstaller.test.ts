import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectInstallStatus,
  extractChainedCommand,
  installStatusline,
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
