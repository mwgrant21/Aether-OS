import { promises as fsp, existsSync } from 'fs';
import { writeBackup, writeFileAtomically } from './atomicWrite';
import { dirname } from 'path';

/** Basename of the script this app installs into settings.json. The one marker
 *  that lets a stale command be recognised as OURS rather than a foreign tool. */
export const STATUSLINE_SCRIPT_NAME = 'aether-statusline.mjs';

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

// Backup and atomic-replace live in ./atomicWrite, shared with main.ts and
// mirroring collector/src/hookInstaller.ts (#59, #60): three processes write
// this same settings.json, so they must not drift. The backup marker stays
// 'aetherbak', matching the collector's, since both back up the same file.

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
      backupPath = await writeBackup(settingsPath, raw, 'aetherbak');
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
    await writeFileAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Recognises one of OUR OWN installed commands and pulls it apart, or returns
 * null for anything else. Deliberately strict: it matches only the exact shape
 * statuslineSettingsPatch() writes (`node "<path>"`, optionally followed by
 * `--chain <base64>`) with a path whose basename is STATUSLINE_SCRIPT_NAME.
 *
 * Strictness is the safety property. This is the gate that decides whether the
 * migration below may rewrite a user's settings.json unasked, so anything we
 * are not certain we wrote ourselves must fall through as "not ours" and be
 * left alone -- a hand-edited variant included.
 */
export function parseOwnStatuslineCommand(
  command: string | null
): { scriptPath: string; chain: string | null } | null {
  if (!command) return null;
  // Anchored at BOTH ends, and the only thing allowed after the path is one
  // well-formed --chain argument. A prefix-only match would accept a
  // hand-edited `node "<path>" --custom-flag` or `node "<path>" && other-tool`,
  // call it ours, and then rewrite it from the parsed path and chain alone --
  // silently dropping whatever the user had appended. Migration writes to the
  // user's settings.json unasked, so anything we did not emit verbatim has to
  // fall through as "not ours" and be left for the human to deal with.
  const m = /^node\s+"([^"]+)"(?:\s+--chain\s+([A-Za-z0-9+\/=]+))?$/.exec(command.trim());
  if (!m) return null;
  const scriptPath = m[1];
  // Split on BOTH separators rather than using path.basename(). This parses a
  // string out of a config file, so it must not depend on the host's path
  // semantics: POSIX basename() treats "\" as an ordinary character, so a
  // Windows-shaped path (which is what this Windows-only app always writes)
  // has no separator at all under Linux and basename returns the whole string.
  // That made every migration silently decline on the Linux CI runner while
  // passing on Windows.
  const leaf = scriptPath.split(/[\\/]/).pop() ?? '';
  if (leaf !== STATUSLINE_SCRIPT_NAME) return null;
  // Only decode when the anchored match actually captured a --chain argument,
  // so the chain comes from the validated shape rather than a loose scan of
  // the whole string.
  return { scriptPath, chain: m[2] ? extractChainedCommand(command) : null };
}

export interface StatuslineMigrationResult {
  migrated: boolean;
  /** Why nothing happened, or what moved. One line, for the startup log. */
  reason: string;
  from?: string;
  backupPath?: string | null;
  error?: string;
}

/**
 * Re-points a settings.json statusLine that still names a PREVIOUS install of
 * this app, after that install's directory has gone away.
 *
 * Why this lives in the app and not in NSIS: an update may be installed into a
 * different directory (electron-builder.yml sets
 * allowToChangeInstallationDirectory), and the old uninstaller cannot fix the
 * path because it is never told the new one -- app-builder-lib invokes it as
 * `_?=$installationDir`, which is the OLD directory. There is nothing in
 * customUnInstall to migrate *to*. installer.nsh's own comment already settles
 * where the fix belongs: the backup and atomic-replace rules for this file live
 * in atomicWrite.ts, and a fourth implementation in NSIS script is not a trade
 * worth making. Doing it here also covers every other way the path can go
 * stale -- a repair install, a manual move -- not just the update flow.
 *
 * Four guards, each of which must hold before a single byte is written:
 *   - status must be 'installed-other'. 'installed' already points at us;
 *     'not-installed' has nothing to move; 'unreadable' is a file we could not
 *     parse and therefore must never rewrite.
 *   - the existing command must be recognisably ours (parseOwnStatuslineCommand).
 *     A foreign tool's command is never touched.
 *   - the script it names must NOT exist. A path that still resolves belongs to
 *     a live install -- possibly a second one the user runs deliberately -- and
 *     hijacking it would be the silent clobber this whole module avoids.
 *   - it must not already be us, which the status check implies but is asserted
 *     anyway so a future change to detectInstallStatus cannot make this a
 *     self-rewrite loop.
 *
 * Any chained third-party command is carried across unchanged: the reason the
 * installer chains instead of clobbering is that the user's other statusline
 * tool must survive, and that promise has to survive a directory move too.
 */
export async function migrateStatuslineScriptPath(
  settingsPath: string,
  currentScriptPath: string,
  scriptExists: (p: string) => boolean = existsSync
): Promise<StatuslineMigrationResult> {
  const state = await readInstallState(settingsPath, currentScriptPath);

  if (state.status !== 'installed-other') {
    return { migrated: false, reason: `nothing to migrate (${state.status})` };
  }

  // Mirrors the guard on the statusline:install IPC handler in main.ts: writing
  // `node "<missing path>"` into the user's real settings.json breaks every
  // Claude Code turn, for every project, silently. Migrating to a script this
  // install does not actually have would just swap one dead command for
  // another, so refuse before touching anything.
  if (!scriptExists(currentScriptPath)) {
    return {
      migrated: false,
      reason: `this install's own script is missing at ${currentScriptPath}; refusing to write a dead path`,
    };
  }

  const own = parseOwnStatuslineCommand(state.existingCommand);
  if (!own) {
    return { migrated: false, reason: 'statusLine belongs to another tool; left untouched' };
  }
  if (own.scriptPath === currentScriptPath) {
    return { migrated: false, reason: 'already points at this install' };
  }
  if (scriptExists(own.scriptPath)) {
    return { migrated: false, reason: `previous script still exists at ${own.scriptPath}; left untouched` };
  }

  const existingResult = await readExistingSettings(settingsPath);
  if (!existingResult.ok) {
    return { migrated: false, reason: 'could not read settings.json', error: existingResult.error };
  }
  const { raw, parsed } = existingResult;

  try {
    const backupPath = await writeBackup(settingsPath, raw, 'aetherbak');
    const merged = { ...parsed, ...statuslineSettingsPatch(currentScriptPath, own.chain) };
    await writeFileAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return {
      migrated: true,
      reason: `statusline re-pointed from a removed install to ${currentScriptPath}`,
      from: own.scriptPath,
      backupPath,
    };
  } catch (err: any) {
    return { migrated: false, reason: 'could not write settings.json', error: err?.message ?? String(err) };
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
    const backupPath = await writeBackup(settingsPath, raw, 'aetherbak');
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
    await writeFileAtomically(settingsPath, JSON.stringify(parsed, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
