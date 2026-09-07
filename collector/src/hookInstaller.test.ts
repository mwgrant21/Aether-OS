import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  readHookInstallState,
  installHooks,
  uninstallHooks,
  installPermissionHooks,
  uninstallPermissionHooks,
  MANAGED_HOOK_EVENTS,
} from './hookInstaller.js';

const SCRIPT_PATH = 'C:\\Users\\test\\.aether-os\\aether-hook-emit.mjs';
const PERMISSION_SCRIPT_PATH = 'C:\\Users\\test\\.aether-os\\aether-permission-hook.mjs';

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

describe('installPermissionHooks / uninstallPermissionHooks', () => {
  it('installPermissionHooks adds PermissionRequest, PostToolUse, and Notification groups', async () => {
    const settingsPath = tempSettingsPath('{}');
    const result = await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PermissionRequest).toHaveLength(1);
    expect(written.hooks.PermissionRequest[0].hooks[0].command).toContain(PERMISSION_SCRIPT_PATH);
    expect(written.hooks.PostToolUse).toHaveLength(1);
    expect(written.hooks.PostToolUse[0].hooks[0].command).toContain(PERMISSION_SCRIPT_PATH);
    expect(written.hooks.Notification).toHaveLength(1);
    expect(written.hooks.Notification[0].hooks[0].command).toContain(PERMISSION_SCRIPT_PATH);
  });

  it('installPermissionHooks coexists with a pre-existing aether-hook-emit.mjs group already occupying PostToolUse and Notification', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH); // installs the unrelated spool-ingestion group first
    const result = await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PostToolUse).toHaveLength(2);
    expect(written.hooks.PostToolUse[0].hooks[0].command).toContain(SCRIPT_PATH);
    expect(written.hooks.PostToolUse[1].hooks[0].command).toContain(PERMISSION_SCRIPT_PATH);
    expect(written.hooks.Notification).toHaveLength(2);
    expect(written.hooks.Notification[0].hooks[0].command).toContain(SCRIPT_PATH);
    expect(written.hooks.Notification[1].hooks[0].command).toContain(PERMISSION_SCRIPT_PATH);
    // The unrelated group's other managed events (Stop etc.) are untouched.
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.Stop[0].hooks[0].command).toContain(SCRIPT_PATH);
    // installPermissionHooks must not itself have added a Stop group.
    expect(written.hooks.PermissionRequest).toHaveLength(1);
  });

  it('installPermissionHooks is idempotent -- installing twice does not duplicate our own entry', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);
    await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PostToolUse).toHaveLength(2);
    expect(written.hooks.Notification).toHaveLength(2);
    expect(written.hooks.PermissionRequest).toHaveLength(1);
  });

  it('uninstallPermissionHooks removes only its own entries, leaving the aether-hook-emit.mjs PostToolUse and Notification groups intact', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);

    const result = await uninstallPermissionHooks(settingsPath);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PostToolUse).toHaveLength(1);
    expect(written.hooks.PostToolUse[0].hooks[0].command).toContain(SCRIPT_PATH);
    expect(written.hooks.Notification).toHaveLength(1);
    expect(written.hooks.Notification[0].hooks[0].command).toContain(SCRIPT_PATH);
    expect(written.hooks.PermissionRequest).toBeUndefined();
    // Unrelated managed-event groups from installHooks remain untouched.
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.Stop[0].hooks[0].command).toContain(SCRIPT_PATH);
  });

  it('readHookInstallState (using MANAGED_HOOK_EVENTS) does not report PermissionRequest as an event it manages', () => {
    expect(MANAGED_HOOK_EVENTS).not.toContain('PermissionRequest');
  });
});

// Added 2026-09-07 after a Stryker run (collector, run 2: 59.7% on this file)
// showed the error, backup, no-op and malformed-shape paths were unguarded.
// See .superpowers/stryker-collector-survivors.md for the mutants these kill.
describe('hookInstaller: error, backup and malformed-shape guards', () => {
  const ourEmitGroup = { hooks: [{ type: 'command', command: `node "${SCRIPT_PATH}"` }] };
  const ourPermGroup = { hooks: [{ type: 'command', command: `node "${PERMISSION_SCRIPT_PATH}"` }] };
  const junkGroups = [null, 'junk', { hooks: 'nope' }, { hooks: [null, { type: 'command' }] }];
  const backupsBeside = (settingsPath: string) =>
    readdirSync(dirname(settingsPath)).filter((f) => f.includes('.aetherbak-'));

  type Outcome = { ok: boolean; backupPath?: string | null; error?: string };
  const installers: [string, (p: string) => Promise<Outcome>][] = [
    ['installHooks', (p) => installHooks(p, SCRIPT_PATH)],
    ['installPermissionHooks', (p) => installPermissionHooks(p, PERMISSION_SCRIPT_PATH)],
  ];
  const uninstallers: [string, (p: string) => Promise<Outcome>][] = [
    ['uninstallHooks', (p) => uninstallHooks(p)],
    ['uninstallPermissionHooks', (p) => uninstallPermissionHooks(p)],
  ];
  const allFns = [...installers, ...uninstallers];

  it.each(installers)('%s on a missing settings.json creates it, reports ok, and writes no backup', async (_name, fn) => {
    const settingsPath = tempSettingsPath();
    const result = await fn(settingsPath);
    expect(result).toEqual({ ok: true, backupPath: null });
    expect(existsSync(settingsPath)).toBe(true);
    expect(backupsBeside(settingsPath)).toEqual([]);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(Object.keys(written.hooks).length).toBeGreaterThan(0);
  });

  it.each(installers)('%s on an existing settings.json writes exactly one backup holding the original bytes and keeps unrelated keys', async (_name, fn) => {
    const original = '{"permissions":{"allow":["Bash(ls:*)"]},"model":"opus"}';
    const settingsPath = tempSettingsPath(original);
    const result = await fn(settingsPath);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
    expect(backupsBeside(settingsPath)).toHaveLength(1);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(written.model).toBe('opus');
  });

  it.each([['[]'], ['null'], ['"hello"'], ['42']])(
    'refuses a settings.json whose top level is %s and leaves the file and directory untouched',
    async (content) => {
      const settingsPath = tempSettingsPath(content);
      const result = await installHooks(settingsPath, SCRIPT_PATH);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not a JSON object');
      expect(readFileSync(settingsPath, 'utf8')).toBe(content);
      expect(backupsBeside(settingsPath)).toEqual([]);
    }
  );

  it.each(allFns)('%s reports a parse error on an empty settings.json and leaves it untouched', async (_name, fn) => {
    const settingsPath = tempSettingsPath('');
    const result = await fn(settingsPath);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not parse existing settings\.json/);
    expect(readFileSync(settingsPath, 'utf8')).toBe('');
    expect(backupsBeside(settingsPath)).toEqual([]);
  });

  it('surfaces a non-ENOENT read failure instead of treating the file as absent', async () => {
    const dirAsSettings = mkdtempSync(join(tmpdir(), 'aether-collector-hookinstaller-dir-'));
    const result = await installHooks(dirAsSettings, SCRIPT_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/EISDIR/);
  });

  it.each(allFns)('%s reports failure and leaves settings.json byte-identical when the atomic rename fails', async (_name, fn) => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);
    const snapshot = readFileSync(settingsPath, 'utf8');
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('EACCES: simulated rename failure'));
    try {
      const result = await fn(settingsPath);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('simulated rename failure');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(snapshot);
  });

  it('readHookInstallState reports nothing installed and does not throw on a malformed settings.json', async () => {
    const settingsPath = tempSettingsPath('not valid json {{');
    await expect(readHookInstallState(settingsPath, SCRIPT_PATH)).resolves.toEqual({
      installedEvents: [],
      settingsPath,
      scriptPath: SCRIPT_PATH,
    });
  });

  it('readHookInstallState reports an event installed when our group sits behind an unrelated one', async () => {
    const existing = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'powershell -File other.ps1' }] }, ourEmitGroup] },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    const state = await readHookInstallState(settingsPath, SCRIPT_PATH);
    expect(state.installedEvents).toEqual(['Stop']);
  });

  it('readHookInstallState ignores null, string, hooks-less and command-less group entries without throwing', async () => {
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { Stop: junkGroups } }));
    const state = await readHookInstallState(settingsPath, SCRIPT_PATH);
    expect(state.installedEvents).toEqual([]);
  });

  it('installHooks appends our group after junk entries instead of failing or treating them as ours', async () => {
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { Stop: junkGroups } }));
    const result = await installHooks(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toHaveLength(junkGroups.length + 1);
    expect(written.hooks.Stop.slice(0, junkGroups.length)).toEqual(junkGroups);
    expect(written.hooks.Stop[junkGroups.length]).toEqual(ourEmitGroup);
  });

  it('installPermissionHooks appends its group after junk entries instead of failing or treating them as ours', async () => {
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { PermissionRequest: junkGroups } }));
    const result = await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PermissionRequest).toHaveLength(junkGroups.length + 1);
    expect(written.hooks.PermissionRequest.slice(0, junkGroups.length)).toEqual(junkGroups);
    expect(written.hooks.PermissionRequest[junkGroups.length]).toEqual(ourPermGroup);
  });

  it('installHooks writes hook entries of type "command"', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop[0].hooks[0].type).toBe('command');
  });

  it('installPermissionHooks leaves a non-array hooks[event] untouched and still installs the other events', async () => {
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { PermissionRequest: { someWeirdShape: true } } }));
    const result = await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PermissionRequest).toEqual({ someWeirdShape: true });
    expect(written.hooks.PostToolUse).toEqual([ourPermGroup]);
    expect(written.hooks.Notification).toEqual([ourPermGroup]);
  });

  it('uninstallPermissionHooks leaves a non-array hooks[event] untouched while still removing its other entries', async () => {
    const existing = { hooks: { PermissionRequest: { someWeirdShape: true }, Notification: [ourPermGroup] } };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    const result = await uninstallPermissionHooks(settingsPath);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks).toEqual({ PermissionRequest: { someWeirdShape: true } });
  });

  it('uninstallPermissionHooks removes only its own entry from a mixed group, leaving the unrelated entry and the group intact', async () => {
    const existing = {
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              { type: 'command', command: 'powershell -File some-other-script.ps1' },
              { type: 'command', command: `node "${PERMISSION_SCRIPT_PATH}"` },
            ],
          },
        ],
      },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    const result = await uninstallPermissionHooks(settingsPath);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PermissionRequest).toEqual([
      { hooks: [{ type: 'command', command: 'powershell -File some-other-script.ps1' }] },
    ]);
  });

  it.each(uninstallers)('%s on a missing settings.json is a no-op: ok, no backup, no file created', async (_name, fn) => {
    const settingsPath = tempSettingsPath();
    const result = await fn(settingsPath);
    expect(result).toEqual({ ok: true, backupPath: null });
    expect(existsSync(settingsPath)).toBe(false);
    expect(backupsBeside(settingsPath)).toEqual([]);
  });

  const noHooksShapes: [string, string][] = [
    ['no hooks key', '{"model":"opus"}'],
    ['hooks: null', '{"hooks":null}'],
  ];
  for (const [label, content] of noHooksShapes) {
    it.each(uninstallers)(`%s with ${label} is a no-op: ok, no backup, bytes unchanged`, async (_name, fn) => {
      const settingsPath = tempSettingsPath(content);
      const result = await fn(settingsPath);
      expect(result).toEqual({ ok: true, backupPath: null });
      expect(readFileSync(settingsPath, 'utf8')).toBe(content);
      expect(backupsBeside(settingsPath)).toEqual([]);
    });
  }

  it('uninstallHooks deletes an emptied event key and does not invent keys for events that were absent', async () => {
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { Stop: [ourEmitGroup] } }));
    const result = await uninstallHooks(settingsPath);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks).toEqual({});
  });

  it('uninstallPermissionHooks deletes an emptied event key and does not invent keys for events that were absent', async () => {
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { PermissionRequest: [ourPermGroup] } }));
    const result = await uninstallPermissionHooks(settingsPath);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks).toEqual({});
  });

  it('uninstallHooks preserves junk group entries and still removes ours', async () => {
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { Stop: [...junkGroups, ourEmitGroup] } }));
    const result = await uninstallHooks(settingsPath);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toEqual(junkGroups);
  });

  it('uninstallPermissionHooks preserves junk group entries and still removes ours', async () => {
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { PermissionRequest: [...junkGroups, ourPermGroup] } }));
    const result = await uninstallPermissionHooks(settingsPath);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PermissionRequest).toEqual(junkGroups);
  });
});

describe('hookInstaller: junk siblings inside our own group', () => {
  it('uninstallHooks drops only our entry from a group that also holds null and command-less entries', async () => {
    const group = { hooks: [null, { type: 'command' }, { type: 'command', command: `node "${SCRIPT_PATH}"` }] };
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { Stop: [group] } }));
    const result = await uninstallHooks(settingsPath);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toEqual([{ hooks: [null, { type: 'command' }] }]);
  });

  it('uninstallPermissionHooks drops only its entry from a group that also holds null and command-less entries', async () => {
    const group = { hooks: [null, { type: 'command' }, { type: 'command', command: `node "${PERMISSION_SCRIPT_PATH}"` }] };
    const settingsPath = tempSettingsPath(JSON.stringify({ hooks: { PermissionRequest: [group] } }));
    const result = await uninstallPermissionHooks(settingsPath);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PermissionRequest).toEqual([{ hooks: [null, { type: 'command' }] }]);
  });
});

// Issue #58: a top-level `hooks` that is an array or a primitive is not a
// shape we know how to merge into. Installers must refuse (the user would
// otherwise get ok:true and a rewritten config); uninstallers have nothing of
// ours to remove there and must no-op without touching the file.
describe('hookInstaller: top-level hooks that is not a plain object (#58)', () => {
  type Outcome = { ok: boolean; backupPath?: string | null; error?: string };
  const backupsBeside = (settingsPath: string) =>
    readdirSync(dirname(settingsPath)).filter((f) => f.includes('.aetherbak-'));
  const installers: [string, (p: string) => Promise<Outcome>][] = [
    ['installHooks', (p) => installHooks(p, SCRIPT_PATH)],
    ['installPermissionHooks', (p) => installPermissionHooks(p, PERMISSION_SCRIPT_PATH)],
  ];
  const uninstallers: [string, (p: string) => Promise<Outcome>][] = [
    ['uninstallHooks', (p) => uninstallHooks(p)],
    ['uninstallPermissionHooks', (p) => uninstallPermissionHooks(p)],
  ];
  const malformed: [string, string][] = [
    ['an empty array', '{"hooks":[],"model":"opus"}'],
    ['an array of groups', '{"hooks":[{"hooks":[{"type":"command","command":"other.ps1"}]}],"model":"opus"}'],
    ['a string', '{"hooks":"user-string","model":"opus"}'],
    ['a number', '{"hooks":42,"model":"opus"}'],
    ['a boolean', '{"hooks":true,"model":"opus"}'],
  ];

  for (const [label, content] of malformed) {
    it.each(installers)(`%s refuses when hooks is ${label}: ok:false, bytes unchanged, no backup`, async (_name, fn) => {
      const settingsPath = tempSettingsPath(content);
      const result = await fn(settingsPath);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not an object');
      expect(readFileSync(settingsPath, 'utf8')).toBe(content);
      expect(backupsBeside(settingsPath)).toEqual([]);
    });

    it.each(uninstallers)(`%s no-ops when hooks is ${label}: ok:true, no backup, bytes unchanged`, async (_name, fn) => {
      const settingsPath = tempSettingsPath(content);
      const result = await fn(settingsPath);
      expect(result).toEqual({ ok: true, backupPath: null });
      expect(readFileSync(settingsPath, 'utf8')).toBe(content);
      expect(backupsBeside(settingsPath)).toEqual([]);
    });
  }

  it('readHookInstallState reports nothing installed when hooks is an array, without throwing', async () => {
    const settingsPath = tempSettingsPath('{"hooks":[{"hooks":[{"type":"command","command":"other.ps1"}]}]}');
    const state = await readHookInstallState(settingsPath, SCRIPT_PATH);
    expect(state.installedEvents).toEqual([]);
  });

  it('installHooks still treats hooks: null as absent and installs into a fresh object', async () => {
    const settingsPath = tempSettingsPath('{"hooks":null,"model":"opus"}');
    const result = await installHooks(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.model).toBe('opus');
    for (const eventName of MANAGED_HOOK_EVENTS) expect(written.hooks[eventName]).toHaveLength(1);
  });
});
