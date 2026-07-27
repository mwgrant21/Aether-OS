import { promises as fsp } from 'fs';
import { dirname } from 'path';

export type InstallStatus = 'installed' | 'installed-other' | 'not-installed' | 'unreadable';

export interface StatuslineInstallState {
  status: InstallStatus;
  /** The currently configured statusLine command, if any — shown to the user before we overwrite it. */
  existingCommand: string | null;
  settingsPath: string;
  scriptPath: string;
}

/**
 * The patch merged into settings.json. `command` invokes the script directly
 * with `node` -- quoted so paths containing spaces (very common on Windows,
 * e.g. "C:\Users\Jane Doe\...") survive Claude Code's shell invocation.
 */
export function statuslineSettingsPatch(scriptPath: string): { statusLine: { type: 'command'; command: string } } {
  return { statusLine: { type: 'command', command: `node "${scriptPath}"` } };
}

/**
 * Pure classification of an already-parsed settings.json body. Never reads
 * or writes anything -- callers hand it whatever `JSON.parse` produced.
 */
export function detectInstallStatus(
  settingsJson: unknown,
  scriptPath: string
): { status: InstallStatus; existingCommand: string | null } {
  if (typeof settingsJson !== 'object' || settingsJson === null || Array.isArray(settingsJson)) {
    return { status: 'unreadable', existingCommand: null };
  }

  const statusLine = (settingsJson as Record<string, unknown>).statusLine;
  if (statusLine === undefined) {
    return { status: 'not-installed', existingCommand: null };
  }

  let existingCommand: string | null = null;
  if (typeof statusLine === 'string') {
    existingCommand = statusLine;
  } else if (typeof statusLine === 'object' && statusLine !== null) {
    const command = (statusLine as Record<string, unknown>).command;
    if (typeof command === 'string') {
      existingCommand = command;
    }
  }

  if (existingCommand !== null && existingCommand.includes(scriptPath)) {
    return { status: 'installed', existingCommand };
  }
  // The key is present but either doesn't reference our script, or has some
  // shape we don't recognize (e.g. no `command` string at all) -- either way
  // it is NOT ours, so it must be surfaced rather than silently overwritten.
  return { status: 'installed-other', existingCommand };
}

/**
 * Reads settings.json (if present) and classifies the current install state.
 * Never throws: a missing file is 'not-installed', a file that exists but
 * cannot be parsed or isn't a JSON object is 'unreadable'.
 */
export async function readInstallState(settingsPath: string, scriptPath: string): Promise<StatuslineInstallState> {
  let raw: string;
  try {
    raw = await fsp.readFile(settingsPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { status: 'not-installed', existingCommand: null, settingsPath, scriptPath };
    }
    return { status: 'unreadable', existingCommand: null, settingsPath, scriptPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unreadable', existingCommand: null, settingsPath, scriptPath };
  }

  const { status, existingCommand } = detectInstallStatus(parsed, scriptPath);
  return { status, existingCommand, settingsPath, scriptPath };
}

/**
 * Reads settings.json, JSON.parses it, and returns the parsed object plus the
 * raw bytes -- or an error result when the read/parse should abort the
 * caller. `fileExisted: false` means ENOENT (treat as `{}`); a parse failure
 * on a file that DOES exist is always an abort, never a `{}` fallback --
 * overwriting a settings file we could not read back is destructive.
 */
async function readExistingSettings(
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
    if (err?.code === 'ENOENT') {
      return { ok: true, fileExisted: false, raw: '', parsed: {} };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }

  // NOTE ON A DELIBERATE DEVIATION from optimizeActions.ts's byte-preservation
  // discipline: that module (CLAUDE.md) treats its target as opaque text and
  // splices a managed block into it so everything outside the block survives
  // byte-for-byte, untouched by any re-serialization. We do NOT do that here.
  // settings.json is JSON, not Markdown -- a text-level insert cannot safely
  // handle nested objects, trailing commas, key reordering by the user's
  // editor, etc. The only correct way to merge one key into it is to parse,
  // structurally merge, and re-serialize with `JSON.stringify(..., null, 2)`.
  // That re-serialization can reformat whitespace/key order the user had, but
  // it can never lose or corrupt data -- and the timestamped backup written
  // below (of the exact original bytes) is what makes this acceptable: the
  // user's prior file is always one `mv` away from being restored verbatim.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    // Parse failure ABORTS. We could not read this file, so we must not
    // write anything -- not a backup, not a merge. Proceeding here is exactly
    // the kind of "helpful" overwrite that destroys a user's real config.
    return { ok: false, error: `could not parse existing settings.json: ${err?.message ?? String(err)}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'existing settings.json is not a JSON object; refusing to overwrite' };
  }

  return { ok: true, fileExisted, raw, parsed: parsed as Record<string, unknown> };
}

async function writeBackup(settingsPath: string, raw: string): Promise<string> {
  const backupPath = `${settingsPath}.aetherbak-${Date.now()}`;
  await fsp.writeFile(backupPath, raw, 'utf8');
  return backupPath;
}

export async function installStatusline(
  settingsPath: string,
  scriptPath: string
): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> {
  const existingResult = await readExistingSettings(settingsPath);
  if (!existingResult.ok) {
    return { ok: false, error: existingResult.error };
  }
  const { fileExisted, raw, parsed } = existingResult;

  try {
    let backupPath: string | null = null;
    if (fileExisted) {
      backupPath = await writeBackup(settingsPath, raw);
    }

    const patch = statuslineSettingsPatch(scriptPath);
    const merged = { ...parsed, ...patch };
    await fsp.mkdir(dirname(settingsPath), { recursive: true });
    await fsp.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function uninstallStatusline(
  settingsPath: string
): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> {
  const existingResult = await readExistingSettings(settingsPath);
  if (!existingResult.ok) {
    return { ok: false, error: existingResult.error };
  }
  const { fileExisted, raw, parsed } = existingResult;

  if (!fileExisted || !('statusLine' in parsed)) {
    // Nothing to remove -- a successful no-op, not an error.
    return { ok: true, backupPath: null };
  }

  try {
    const backupPath = await writeBackup(settingsPath, raw);
    delete parsed.statusLine;
    await fsp.writeFile(settingsPath, JSON.stringify(parsed, null, 2), 'utf8');
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
