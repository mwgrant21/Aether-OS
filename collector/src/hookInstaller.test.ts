import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readHookInstallState, installHooks, uninstallHooks, MANAGED_HOOK_EVENTS } from './hookInstaller.js';

const SCRIPT_PATH = 'C:\\Users\\test\\.aether-os\\aether-hook-emit.mjs';

function tempSettingsPath(initialContent?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-hookinstaller-'));
  const p = join(dir, 'settings.json');
  if (initialContent !== undefined) writeFileSync(p, initialContent, 'utf8');
  return p;
}

describe('hookInstaller', () => {
  it('readHookInstallState reports no managed events installed when settings.json does not exist', async () => {
    const settingsPath = tempSettingsPath();
    const state = await readHookInstallState(settingsPath, SCRIPT_PATH);
    expect(state.installedEvents).toEqual([]);
  });

  it('installHooks adds an entry to every managed event, creating the hooks object if absent', async () => {
    const settingsPath = tempSettingsPath('{}');
    const result = await installHooks(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const eventName of MANAGED_HOOK_EVENTS) {
      expect(written.hooks[eventName]).toHaveLength(1);
      expect(written.hooks[eventName][0].hooks[0].command).toContain(SCRIPT_PATH);
    }
  });

  it('installHooks preserves an existing unrelated hook entry for a managed event', async () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'powershell -File some-other-script.ps1' }] }],
      },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    await installHooks(settingsPath, SCRIPT_PATH);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.Stop[0].hooks[0].command).toContain('some-other-script.ps1');
    expect(written.hooks.Stop[1].hooks[0].command).toContain(SCRIPT_PATH);
  });

  it('installHooks is idempotent -- installing twice does not duplicate our own entry', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    await installHooks(settingsPath, SCRIPT_PATH);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toHaveLength(1);
  });

  it('readHookInstallState reports all managed events installed after installHooks', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    const state = await readHookInstallState(settingsPath, SCRIPT_PATH);
    expect(state.installedEvents.sort()).toEqual([...MANAGED_HOOK_EVENTS].sort());
  });

  it('uninstallHooks removes only our own entry, leaving an unrelated Stop hook intact', async () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'powershell -File some-other-script.ps1' }] }],
      },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    await installHooks(settingsPath, SCRIPT_PATH);
    const result = await uninstallHooks(settingsPath);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.Stop[0].hooks[0].command).toContain('some-other-script.ps1');
  });

  it('uninstallHooks writes a timestamped backup before modifying settings.json', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    const result = await uninstallHooks(settingsPath);
    expect(result.backupPath).toBeTruthy();
    // Note: raw-text substring search doesn't work here -- JSON.stringify escapes
    // backslashes in Windows paths (single "\" becomes "\\" on disk), so a literal
    // Windows SCRIPT_PATH never appears unescaped in the raw file bytes. Parse and
    // check the decoded value instead, consistent with the other tests in this file.
    const backedUp = JSON.parse(readFileSync(result.backupPath!, 'utf8'));
    expect(backedUp.hooks.Stop.some((g: any) => g.hooks[0].command.includes(SCRIPT_PATH))).toBe(true);
  });

  it('refuses to overwrite an unparseable settings.json', async () => {
    const settingsPath = tempSettingsPath('not valid json {{');
    const result = await installHooks(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(false);
  });

  it('installHooks leaves a non-array hooks[event] untouched and still installs the other managed events', async () => {
    const existing = {
      hooks: {
        Stop: { someWeirdShape: true },
      },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    const result = await installHooks(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toEqual({ someWeirdShape: true });
    for (const eventName of MANAGED_HOOK_EVENTS) {
      if (eventName === 'Stop') continue;
      expect(written.hooks[eventName]).toHaveLength(1);
      expect(written.hooks[eventName][0].hooks[0].command).toContain(SCRIPT_PATH);
    }
  });

  it('uninstallHooks leaves a non-array hooks[event] completely untouched', async () => {
    const existing = {
      hooks: {
        Stop: { someWeirdShape: true },
      },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    const result = await uninstallHooks(settingsPath);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toEqual({ someWeirdShape: true });
  });

  it('uninstallHooks removes only our entry from a mixed group, leaving the unrelated entry and the group intact', async () => {
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'powershell -File some-other-script.ps1' },
              { type: 'command', command: `node "${SCRIPT_PATH}" # aether-hook-emit.mjs marker` },
            ],
          },
        ],
      },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    const result = await uninstallHooks(settingsPath);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.Stop[0].hooks).toHaveLength(1);
    expect(written.hooks.Stop[0].hooks[0].command).toContain('some-other-script.ps1');
  });
});
