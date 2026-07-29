import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

export const MANAGED_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'] as const;

// Stage 6's PermissionRequest/PostToolUse hook group is installed and
// uninstalled independently of MANAGED_HOOK_EVENTS above (a distinct script
// path/marker, a distinct event list). PostToolUse is shared with the
// existing aether-hook-emit.mjs group -- installPermissionHooks appends a
// second, separately-marked group to that same array rather than replacing
// it; see isOurGroup's scriptPath parameterization below.
const PERMISSION_HOOK_EVENTS = ['PermissionRequest', 'PostToolUse'] as const;
const PERMISSION_HOOK_MARKER = 'aether-permission-hook.mjs';

export interface HookInstallState {
  installedEvents: string[];
  settingsPath: string;
  scriptPath: string;
}

interface HookGroup {
  hooks?: { type?: string; command?: string }[];
}

function isOurGroup(group: unknown, scriptPath: string): boolean {
  if (typeof group !== 'object' || group === null) return false;
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => typeof h?.command === 'string' && h.command.includes(scriptPath));
}

function ourGroup(scriptPath: string): HookGroup {
  return { hooks: [{ type: 'command', command: `node "${scriptPath}"` }] };
}

async function readSettings(
  settingsPath: string
): Promise<
  | { ok: true; fileExisted: boolean; raw: string; parsed: Record<string, unknown> }
  | { ok: false; error: string }
> {
  let raw = '';
  let fileExisted = true;
  try {
    raw = await fsp.readFile(settingsPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { ok: true, fileExisted: false, raw: '', parsed: {} };
    return { ok: false, error: err?.message ?? String(err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'existing settings.json is not a JSON object; refusing to overwrite' };
    }
    return { ok: true, fileExisted, raw, parsed: parsed as Record<string, unknown> };
  } catch (err: any) {
    return { ok: false, error: `could not parse existing settings.json: ${err?.message ?? String(err)}` };
  }
}

async function writeBackup(settingsPath: string, raw: string): Promise<string> {
  const backupPath = `${settingsPath}.aetherbak-${Date.now()}`;
  await fsp.writeFile(backupPath, raw, 'utf8');
  return backupPath;
}

async function writeSettingsAtomically(settingsPath: string, content: string): Promise<void> {
  const tmpPath = `${settingsPath}.aethertmp-${Date.now()}`;
  await fsp.writeFile(tmpPath, content, 'utf8');
  await fsp.rename(tmpPath, settingsPath);
}

export async function readHookInstallState(settingsPath: string, scriptPath: string): Promise<HookInstallState> {
  const result = await readSettings(settingsPath);
  const installedEvents: string[] = [];
  if (result.ok) {
    const hooks = (result.parsed.hooks && typeof result.parsed.hooks === 'object' ? result.parsed.hooks : {}) as Record<
      string,
      unknown
    >;
    for (const eventName of MANAGED_HOOK_EVENTS) {
      const groups = hooks[eventName];
      if (Array.isArray(groups) && groups.some((g) => isOurGroup(g, scriptPath))) {
        installedEvents.push(eventName);
      }
    }
  }
  return { installedEvents, settingsPath, scriptPath };
}

export async function installHooks(
  settingsPath: string,
  scriptPath: string
): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> {
  const result = await readSettings(settingsPath);
  if (!result.ok) return { ok: false, error: result.error };
  const { fileExisted, raw, parsed } = result;

  try {
    let backupPath: string | null = null;
    if (fileExisted) backupPath = await writeBackup(settingsPath, raw);

    const hooks = (parsed.hooks && typeof parsed.hooks === 'object' ? { ...(parsed.hooks as Record<string, unknown>) } : {}) as Record<
      string,
      unknown
    >;
    for (const eventName of MANAGED_HOOK_EVENTS) {
      const current = hooks[eventName];
      if (current !== undefined && !Array.isArray(current)) {
        // Unrecognized shape for this event (not an array) -- we don't know how
        // to safely merge into it, so leave it exactly as-is rather than risk
        // discarding the user's data. Skip only this event; keep processing others.
        continue;
      }
      const existingGroups = Array.isArray(current) ? current : [];
      const alreadyInstalled = existingGroups.some((g) => isOurGroup(g, scriptPath));
      hooks[eventName] = alreadyInstalled ? existingGroups : [...existingGroups, ourGroup(scriptPath)];
    }

    const merged = { ...parsed, hooks };
    await fsp.mkdir(dirname(settingsPath), { recursive: true });
    await writeSettingsAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function installPermissionHooks(
  settingsPath: string,
  scriptPath: string
): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> {
  const result = await readSettings(settingsPath);
  if (!result.ok) return { ok: false, error: result.error };
  const { fileExisted, raw, parsed } = result;

  try {
    let backupPath: string | null = null;
    if (fileExisted) backupPath = await writeBackup(settingsPath, raw);

    const hooks = (parsed.hooks && typeof parsed.hooks === 'object' ? { ...(parsed.hooks as Record<string, unknown>) } : {}) as Record<
      string,
      unknown
    >;
    for (const eventName of PERMISSION_HOOK_EVENTS) {
      const current = hooks[eventName];
      if (current !== undefined && !Array.isArray(current)) {
        // Same discipline as installHooks: don't touch an unrecognized shape.
        continue;
      }
      const existingGroups = Array.isArray(current) ? current : [];
      const alreadyInstalled = existingGroups.some((g) => isOurGroup(g, scriptPath));
      hooks[eventName] = alreadyInstalled ? existingGroups : [...existingGroups, ourGroup(scriptPath)];
    }

    const merged = { ...parsed, hooks };
    await fsp.mkdir(dirname(settingsPath), { recursive: true });
    await writeSettingsAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function uninstallPermissionHooks(
  settingsPath: string
): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> {
  const result = await readSettings(settingsPath);
  if (!result.ok) return { ok: false, error: result.error };
  const { fileExisted, raw, parsed } = result;

  if (!fileExisted || typeof parsed.hooks !== 'object' || parsed.hooks === null) {
    return { ok: true, backupPath: null };
  }

  try {
    const backupPath = await writeBackup(settingsPath, raw);
    const hooks = { ...(parsed.hooks as Record<string, unknown>) };
    for (const eventName of PERMISSION_HOOK_EVENTS) {
      const current = hooks[eventName];
      if (current !== undefined && !Array.isArray(current)) {
        continue;
      }
      const groups = Array.isArray(current) ? current : [];
      // Same per-group-hooks-level filtering as uninstallHooks, keyed on our
      // own marker so the coexisting aether-hook-emit.mjs group under
      // PostToolUse is left completely untouched.
      const filtered = groups
        .map((g) => {
          if (!isOurGroup(g, PERMISSION_HOOK_MARKER)) return g;
          const groupHooks = (g as HookGroup).hooks;
          if (!Array.isArray(groupHooks)) return g;
          const remainingHooks = groupHooks.filter(
            (h) => !(typeof h?.command === 'string' && h.command.includes(PERMISSION_HOOK_MARKER))
          );
          return { ...(g as HookGroup), hooks: remainingHooks };
        })
        .filter((g) => {
          const groupHooks = (g as HookGroup).hooks;
          return !Array.isArray(groupHooks) || groupHooks.length > 0;
        });
      if (filtered.length > 0) {
        hooks[eventName] = filtered;
      } else {
        delete hooks[eventName];
      }
    }

    const merged = { ...parsed, hooks };
    await writeSettingsAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function uninstallHooks(
  settingsPath: string
): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> {
  const result = await readSettings(settingsPath);
  if (!result.ok) return { ok: false, error: result.error };
  const { fileExisted, raw, parsed } = result;

  if (!fileExisted || typeof parsed.hooks !== 'object' || parsed.hooks === null) {
    return { ok: true, backupPath: null };
  }

  try {
    const backupPath = await writeBackup(settingsPath, raw);
    const hooks = { ...(parsed.hooks as Record<string, unknown>) };
    // scriptPath is not known at uninstall time in general (the caller may not
    // have it handy) -- but every MANAGED_HOOK_EVENTS entry we would have added
    // has a command containing the literal substring "aether-hook-emit.mjs",
    // which is a stable, sufficiently specific marker for "ours" without
    // requiring the caller to pass scriptPath through this call.
    const marker = 'aether-hook-emit.mjs';
    for (const eventName of MANAGED_HOOK_EVENTS) {
      const current = hooks[eventName];
      if (current !== undefined && !Array.isArray(current)) {
        // Unrecognized shape -- leave untouched rather than risk deleting the
        // user's data outright.
        continue;
      }
      const groups = Array.isArray(current) ? current : [];
      // Filter at the level of each group's own .hooks entries, not the whole
      // group: a group may (in principle) contain both our marker entry and an
      // unrelated command packed into the same group object. Only drop the
      // group entirely if removing our entries leaves it with none left.
      const filtered = groups
        .map((g) => {
          if (!isOurGroup(g, marker)) return g;
          const groupHooks = (g as HookGroup).hooks;
          if (!Array.isArray(groupHooks)) return g;
          const remainingHooks = groupHooks.filter(
            (h) => !(typeof h?.command === 'string' && h.command.includes(marker))
          );
          return { ...(g as HookGroup), hooks: remainingHooks };
        })
        .filter((g) => {
          const groupHooks = (g as HookGroup).hooks;
          return !Array.isArray(groupHooks) || groupHooks.length > 0;
        });
      if (filtered.length > 0) {
        hooks[eventName] = filtered;
      } else {
        delete hooks[eventName];
      }
    }

    const merged = { ...parsed, hooks };
    await writeSettingsAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
