import { describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
  promises as fsp,
} from 'fs';
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
    // #59: the failed rename must not leave its temp file beside the real settings.json.
    expect(readdirSync(dirname(settingsPath)).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
  });

  it.each(allFns)('%s reports failure and leaves no temp file when writing the temp file fails mid-write', async (_name, fn) => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH);
    const snapshot = readFileSync(settingsPath, 'utf8');
    const realWriteFile = fsp.writeFile.bind(fsp);
    // Simulate ENOSPC the way it really happens: the file is created, then the write fails.
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      if (String(file).includes('.aethertmp-')) {
        await realWriteFile(file, '', 'utf8');
        throw new Error('ENOSPC: simulated write failure');
      }
      return realWriteFile(file, data, options);
    });
    try {
      const result = await fn(settingsPath);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('simulated write failure');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(snapshot);
    expect(readdirSync(dirname(settingsPath)).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
  });

  it('uses a distinct temp file for each write even when two writes share the same millisecond', async () => {
    const settingsPath = tempSettingsPath('{}');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('1700000000000' as unknown as number));
    const realWriteFile = fsp.writeFile.bind(fsp);
    const tempPaths: string[] = [];
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      if (String(file).includes('.aethertmp-')) tempPaths.push(String(file));
      return realWriteFile(file, data, options);
    });
    try {
      expect((await installHooks(settingsPath, SCRIPT_PATH)).ok).toBe(true);
      expect((await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH)).ok).toBe(true);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
    expect(tempPaths).toHaveLength(2);
    expect(tempPaths[0]).not.toBe(tempPaths[1]);
    expect(readdirSync(dirname(settingsPath)).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
  });

  it('leaves another writer\'s temp file alone when exclusive creation loses the name (EEXIST)', async () => {
    const settingsPath = tempSettingsPath('{}');
    const realWriteFile = fsp.writeFile.bind(fsp);
    let contested = '';
    // Simulate losing the race: the other writer already owns this exact path.
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      if (String(file).includes('.aethertmp-')) {
        contested = String(file);
        await realWriteFile(file, '{"other":"writer"}', 'utf8');
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      }
      return realWriteFile(file, data, options);
    });
    try {
      const result = await installHooks(settingsPath, SCRIPT_PATH);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('EEXIST');
    } finally {
      spy.mockRestore();
    }
    expect(contested).not.toBe('');
    expect(existsSync(contested)).toBe(true);
    expect(readFileSync(contested, 'utf8')).toBe('{"other":"writer"}');
    expect(readFileSync(settingsPath, 'utf8')).toBe('{}');
  });

  it('still removes its own temp file when the rename (not the create) fails with EEXIST', async () => {
    const settingsPath = tempSettingsPath('{}');
    const spy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('EEXIST: destination exists'), { code: 'EEXIST' }));
    try {
      const result = await installHooks(settingsPath, SCRIPT_PATH);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('EEXIST');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe('{}');
    expect(readdirSync(dirname(settingsPath)).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
  });

  it('keeps both backups when two writes share the same millisecond (#60)', async () => {
    const original = '{"model":"opus"}';
    const settingsPath = tempSettingsPath(original);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1700000000000));
    let first: string | null | undefined;
    let second: string | null | undefined;
    try {
      first = (await installHooks(settingsPath, SCRIPT_PATH)).backupPath;
      const afterFirst = readFileSync(settingsPath, 'utf8');
      second = (await installPermissionHooks(settingsPath, PERMISSION_SCRIPT_PATH)).backupPath;
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(first).not.toBe(second);
      // The first backup is the user's pristine file and must survive the second write.
      expect(readFileSync(first!, 'utf8')).toBe(original);
      expect(readFileSync(second!, 'utf8')).toBe(afterFirst);
      expect(backupsBeside(settingsPath)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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

// Creating a symlink needs privilege on Windows; probe once so these cases skip
// locally and still run on the Linux CI lanes where they matter.
const symlinkSupported = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'aether-collector-hook-symlink-probe-'));
    writeFileSync(join(d, 'real'), 'x', 'utf8');
    symlinkSync(join(d, 'real'), join(d, 'link'));
    return true;
  } catch {
    return false;
  }
})();

const siblingsBeside = (p: string, marker: string) =>
  readdirSync(dirname(p)).filter((f) => f.includes(`.${marker}-`));

describe('hookInstaller: symlinked and read-only settings.json (#73)', () => {
  it.skipIf(!symlinkSupported)('writes through a symlinked settings.json and keeps the link', async () => {
    const realPath = tempSettingsPath('{"model":"opus"}');
    const linkDir = mkdtempSync(join(tmpdir(), 'aether-collector-hook-link-'));
    const link = join(linkDir, 'settings.json');
    symlinkSync(realPath, link);

    const result = await installHooks(link, SCRIPT_PATH);

    expect(result.ok).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const written = JSON.parse(readFileSync(realPath, 'utf8'));
    expect(written.model).toBe('opus');
    for (const eventName of MANAGED_HOOK_EVENTS) {
      expect(written.hooks[eventName][0].hooks[0].command).toContain(SCRIPT_PATH);
    }
    // Not asserting WHERE the backup lands (hookInstaller backs up beside the
    // link path; guidanceWriter beside the real path), only that it holds the
    // original bytes.
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe('{"model":"opus"}');
    expect(siblingsBeside(realPath, 'aethertmp')).toEqual([]);
    expect(siblingsBeside(link, 'aethertmp')).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('reports the exact EACCES text for a read-only settings.json', async () => {
    const settingsPath = tempSettingsPath('{}');
    chmodSync(settingsPath, 0o444);
    try {
      const result = await installHooks(settingsPath, SCRIPT_PATH);
      // Exact on purpose: no `Error: ` prefix, no backupPath key. The Go
      // collector pins the same string byte for byte.
      expect(result).toEqual({
        ok: false,
        error: `EACCES: permission denied, write '${await fsp.realpath(settingsPath)}'`,
      });
      expect(readFileSync(settingsPath, 'utf8')).toBe('{}');
    } finally {
      chmodSync(settingsPath, 0o644);
    }
  });

  // Extra, beyond #73's stated list: the end-to-end result of #72 and #67.
  // 34 links is above the 32-hop cap and below both Linux's limit of 40 and
  // Windows' 63, so readFile sees a plain missing file on every platform. The
  // chain never existed as a file, so no backup is taken.
  it.skipIf(!symlinkSupported)('reports ELOOP for a symlink chain deeper than the cap and touches nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collector-hook-chain-'));
    const missing = join(dir, 'missing.json');
    const links = Array.from({ length: 34 }, (_, i) => join(dir, i === 0 ? 'settings.json' : `c${i}`));
    const targets = links.map((_, i) => (i === links.length - 1 ? missing : links[i + 1]));
    links.forEach((l, i) => symlinkSync(targets[i], l));

    const result = await installHooks(links[0], SCRIPT_PATH);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^ELOOP: too many levels of symbolic links, resolve '/);
    links.forEach((l, i) => {
      expect(lstatSync(l).isSymbolicLink()).toBe(true);
      expect(readlinkSync(l)).toBe(targets[i]);
    });
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('.aethertmp-') || f.includes('.aetherbak-'))).toEqual([]);
  });

  // Extra, beyond #73's stated list.
  it('reports a backup that fails mid-write as could-not-write-backup and leaves nothing behind', async () => {
    const settingsPath = tempSettingsPath('{"model":"opus"}');
    const realWriteFile = fsp.writeFile.bind(fsp);
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      if (String(file).includes('.aetherbak-')) {
        await realWriteFile(file, '', 'utf8');
        throw new Error('ENOSPC: simulated write failure');
      }
      return realWriteFile(file, data, options);
    });
    try {
      const result = await installHooks(settingsPath, SCRIPT_PATH);
      expect(result).toEqual({ ok: false, error: 'could not write backup: ENOSPC: simulated write failure' });
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"model":"opus"}');
    expect(siblingsBeside(settingsPath, 'aetherbak')).toEqual([]);
    expect(siblingsBeside(settingsPath, 'aethertmp')).toEqual([]);
  });
});
