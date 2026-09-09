import { existsSync } from 'fs';
import { join } from 'path';
import {
  isSameWindowsPath,
  parseOwnStatuslineCommand,
  readInstallState,
  uninstallStatusline,
} from './statuslineInstaller';

/**
 * The CLI flag the NSIS uninstaller passes to the packaged executable. Lives
 * here rather than as a literal in main.ts so build/installer.nsh has exactly
 * one name to match, and a rename cannot leave the installer calling a flag
 * the app no longer answers to.
 */
export const STATUSLINE_UNINSTALL_FLAG = '--uninstall-statusline';

/**
 * Where the statusline script really is at runtime.
 *
 * The script is spawned by Claude Code -- an EXTERNAL process with no asar
 * support -- from a path written into ~/.claude/settings.json, so it has to
 * live on the real filesystem: the packaged build ships scripts/ via
 * electron-builder's extraResources (unpacked, beside app.asar) and resolves
 * it from process.resourcesPath. In dev there is no asar and app.getAppPath()
 * is the project root, where scripts/ already sits.
 *
 * Extracted from main.ts because the uninstall path has to resolve the exact
 * same file the install path wrote into settings.json. Two copies of this rule
 * would mean an uninstall that silently repairs nothing -- it would look for a
 * path that was never configured, find no match, and report success.
 */
export function resolveStatuslineScriptPath(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  const scriptsDir = opts.isPackaged
    ? join(opts.resourcesPath, 'scripts')
    : join(opts.appPath, 'scripts');
  return join(scriptsDir, 'aether-statusline.mjs');
}

export interface StatuslineUninstallResult {
  /** Process exit code. 0 = settings.json is in a good state; 1 = it may not be. */
  code: 0 | 1;
  /** One line for the NSIS install log (DetailPrint) and the dev console. */
  message: string;
}

/**
 * Removes Aether's statusline from the user's settings.json on behalf of the
 * Windows uninstaller, which runs the packaged executable with
 * STATUSLINE_UNINSTALL_FLAG before it deletes the install directory.
 *
 * Reuses uninstallStatusline (and through it electron/atomicWrite.ts) rather
 * than reimplementing the repair in a standalone script: three processes
 * already write this same settings.json under one set of backup and
 * atomic-replace rules (#59, #60, #63), and a fourth copy of those rules --
 * one that only ever runs during an uninstall, where nobody would notice it
 * had drifted -- is exactly the divergence atomicWrite.parity.test.ts exists
 * to prevent.
 *
 * The ownership guard is this function's own contribution. uninstallStatusline
 * deletes whatever `statusLine` it finds; that is safe behind the app's UI,
 * which only offers uninstall when the state is already 'installed', and is
 * NOT safe here, where the uninstaller calls this unconditionally. A user who
 * configured some other statusline tool and never enabled Aether's would
 * otherwise have that tool silently deleted by uninstalling this app.
 *
 * That guard is parseOwnStatuslineCommand -- the SAME strict full-command
 * parser migrateStatuslineScriptPath() uses -- not readInstallState's status
 * alone. detectInstallStatus() classifies by `existingCommand.includes(
 * scriptPath)`, and a substring test is too weak to gate a destructive write
 * in either direction:
 *
 *   - It says 'installed' for a command the user has customised (`node
 *     "<script>" --chain <b64> && my-tool`, or an extra flag). uninstall-
 *     Statusline would then delete the whole entry, or restore only the
 *     loosely-scanned `--chain`, discarding the user's additions during an
 *     unattended NSIS uninstall. Anything we did not emit verbatim is not
 *     ours to rewrite, so it is reported for a manual fix instead.
 *
 *   - It says 'installed-other' for one of OUR OWN commands that names a
 *     PREVIOUS install directory. That is the update-to-a-new-directory case:
 *     electron-builder.yml allows changing the install directory, and if the
 *     new build is never launched, main.ts never gets to migrate the path. A
 *     bare status check would call that a stranger's tool, exit 0, suppress
 *     installer.nsh's warning, and leave a dead command behind. When the
 *     command parses as ours AND the script it names is gone, it is our own
 *     litter: clean it up, restoring any chained tool.
 *
 * A strictly-ours command whose script still EXISTS is left alone -- that is a
 * second live install, possibly one the user runs deliberately.
 *
 * scriptExists is injected for tests only; the signature is otherwise
 * unchanged, so main.ts's call site keeps the real existsSync.
 */
export async function runStatuslineUninstall(
  settingsPath: string,
  scriptPath: string,
  scriptExists: (p: string) => boolean = existsSync
): Promise<StatuslineUninstallResult> {
  let state;
  try {
    state = await readInstallState(settingsPath, scriptPath);
  } catch (err: any) {
    return { code: 1, message: `could not read ${settingsPath}: ${err?.message ?? String(err)}` };
  }

  if (state.status === 'unreadable') {
    // NOT a clean no-op, and separated from the two below for that reason.
    // readInstallState() reports 'unreadable' rather than throwing (see
    // statuslineInstaller.ts), so this arrives looking like an ordinary
    // non-'installed' state -- but we could not parse settings.json, which
    // means we do not know whether it still invokes our statusline, and the
    // uninstaller is about to delete the script it would point at.
    //
    // Exiting 0 here would tell NSIS the cleanup succeeded, suppress the
    // manual-fix warning in installer.nsh, and leave the user with a dead
    // command and no indication anything went wrong -- a silent failure inside
    // the very code path added to prevent one. Report it so the uninstaller
    // prints the file to fix by hand. Still no rewrite: a file we cannot parse
    // is a file we must not write.
    return {
      code: 1,
      message: `could not parse ${settingsPath} (unreadable); it may still invoke the removed statusline script`,
    };
  }

  if (state.status === 'not-installed') {
    // A genuine clean no-op: we know the state, and it needs no action.
    return { code: 0, message: 'no Aether statusline to remove (not-installed)' };
  }

  // 'installed' or 'installed-other' from here -- there IS a command, and the
  // strict parser, not the status, decides whether it is ours to touch.
  const own = parseOwnStatuslineCommand(state.existingCommand);

  if (!own) {
    if (state.status === 'installed') {
      // Names our script, but is not a command we emitted verbatim: the user
      // appended to it. Removing the entry or restoring a loosely-scanned
      // --chain would silently drop those additions, and this runs unattended
      // during an uninstall where nobody would see it happen. Report it so
      // installer.nsh prints the manual-fix instructions.
      return {
        code: 1,
        message: `statusLine in ${settingsPath} references the removed script but was modified; left untouched -- remove it by hand`,
      };
    }
    // Somebody else's statusLine entirely; not ours to remove.
    return { code: 0, message: 'no Aether statusline to remove (installed-other)' };
  }

  // 'installed-other' is not proof the command names a DIFFERENT install.
  // detectInstallStatus compares with a case-sensitive includes(), so a
  // statusline enabled from `c:\apps\aether` lands here against a stored
  // `C:\Apps\Aether` -- the same file by every rule Windows applies. Left to
  // the branch below it would be read as somebody else's live install and
  // skipped, and NSIS would then delete the script out from under a command it
  // reported as fine.
  const isCurrentInstall =
    state.status === 'installed' || isSameWindowsPath(own.scriptPath, scriptPath);

  if (!isCurrentInstall && scriptExists(own.scriptPath)) {
    // Ours by shape, names a genuinely different path, and that script is still
    // on disk -- a second live install. Deleting its statusline while
    // uninstalling THIS one would be the silent clobber the module avoids.
    return {
      code: 0,
      message: `statusline belongs to another install at ${own.scriptPath}; left untouched`,
    };
  }

  const stale = !isCurrentInstall;

  try {
    // Pass the path the command actually names, not this install's. For the
    // stale case they differ, and uninstallStatusline has to recognise the
    // entry it is being asked to repair.
    const result = await uninstallStatusline(settingsPath, own.scriptPath);
    if (!result.ok) {
      return { code: 1, message: `could not update ${settingsPath}: ${result.error}` };
    }
    const what = stale ? `stale statusline from a previous install (${own.scriptPath}) removed from` : 'statusline removed from';
    return {
      code: 0,
      message: result.backupPath
        ? `${what} ${settingsPath} (backup: ${result.backupPath})`
        : `${what} ${settingsPath}`,
    };
  } catch (err: any) {
    return { code: 1, message: `could not update ${settingsPath}: ${err?.message ?? String(err)}` };
  }
}
