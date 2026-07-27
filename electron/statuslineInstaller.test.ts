import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectInstallStatus,
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

  it('uninstall removes only the statusLine key', async () => {
    const original = { sentinel: 'keep-me', statusLine: { type: 'command', command: 'node x.mjs' } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const result = await uninstallStatusline(settingsPath);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.statusLine).toBeUndefined();
    expect(written.sentinel).toBe('keep-me');

    rmSync(result.backupPath!, { force: true });
  });

  it('uninstall on a file with no statusLine succeeds as a no-op (no backup written)', async () => {
    const original = { sentinel: 'keep-me' };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const result = await uninstallStatusline(settingsPath);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeNull();

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written).toEqual(original);
  });

  it('uninstall on a missing file succeeds as a no-op', async () => {
    const result = await uninstallStatusline(settingsPath);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeNull();
  });

  it('uninstall aborts on malformed JSON, leaving the original file untouched', async () => {
    const original = '{ broken';
    writeFileSync(settingsPath, original, 'utf8');

    const result = await uninstallStatusline(settingsPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const afterBytes = readFileSync(settingsPath, 'utf8');
    expect(afterBytes).toBe(original);
  });
});
