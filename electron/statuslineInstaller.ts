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
 *
 * When `chainCommand` is given (there was already a statusLine command
 * configured -- another tool, or a prior Aether install's own chain), it is
 * base64-encoded into a `--chain` argument rather than embedded as literal
 * text: the chained command is itself an arbitrary shell command that may
 * contain its own quotes (e.g. `powershell ... -File "C:\...\script.ps1"`),
 * and nesting those inside settings.json's own command string would be a
 * quoting hazard. Base64 sidesteps that entirely -- see
 * scripts/aether-statusline.mjs's `parseChainArg` for the decode side.
 */
export function statuslineSettingsPatch(
  scriptPath: string,
  chainCommand?: string | null
): { statusLine: { type: 'command'; command: string } } {
  const base = `node "${scriptPath}"`;
  const command = chainCommand
    ? `${base} --chain ${Buffer.from(chainCommand, 'utf8').toString('base64')}`
    : base;
  return { statusLine: { type: 'command', command } };
}

/**
 * Pulls the previously-chained command back out of one of Aether's own
 * installed commands (`node "<script>" --chain <base64>`), or null if the
 * given command isn't ours / carries no chain. Used by installStatusline (to
 * carry a chain forward across a re-install) and uninstallStatusline (to
 * restore the chained tool instead of deleting statusLine outright).
 */
export function extractChainedCommand(command: string | null): string | null {
  if (!command) return null;
  const m = /--chain\s+(\S+)/.exec(command);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
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

// A crash, power loss, or ENOSPC mid-write directly to settings.json would
// leave the user's REAL Claude Code config truncated -- the backup only
// helps once the user notices and understands the problem. Write-tmp-then-
// rename means the target is never observably partial. Mirrors the pattern
// scripts/aether-statusline.mjs already uses for its own, lower-stakes cache
// file.
async function writeSettingsAtomically(settingsPath: string, content: string): Promise<void> {
  const tmpPath = `${settingsPath}.aethertmp-${Date.now()}`;
  await fsp.writeFile(tmpPath, content, 'utf8');
  await fsp.rename(tmpPath, settingsPath);
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

    // Chain rather than clobber: a foreign command (installed-other) is
    // preserved as the thing we chain to, so its output keeps rendering
    // through Aether's wrapper. A prior Aether install's own chain is
    // carried forward unchanged across a re-install rather than being
    // silently dropped back to no-chain.
    const { status, existingCommand } = detectInstallStatus(parsed, scriptPath);
    const chainCommand =
      status === 'installed-other' ? existingCommand : status === 'installed' ? extractChainedCommand(existingCommand) : null;

    const patch = statuslineSettingsPatch(scriptPath, chainCommand);
    const merged = { ...parsed, ...patch };
    await fsp.mkdir(dirname(settingsPath), { recursive: true });
    await writeSettingsAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function uninstallStatusline(
  settingsPath: string,
  scriptPath: string
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
    const { existingCommand } = detectInstallStatus(parsed, scriptPath);
    const chained = extractChainedCommand(existingCommand);
    if (chained) {
      // Restore the tool Aether was chained through, rather than deleting
      // statusLine outright -- the whole point of chaining instead of
      // replacing is that uninstalling Aether must not also silently kill
      // whatever other statusLine command the user had running before.
      (parsed as Record<string, unknown>).statusLine = { type: 'command', command: chained };
    } else {
      delete parsed.statusLine;
    }
    await writeSettingsAtomically(settingsPath, JSON.stringify(parsed, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
