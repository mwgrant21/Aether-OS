import { join } from 'path';
import { readInstallState, uninstallStatusline } from './statuslineInstaller';

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
 * The status guard is this function's own contribution. uninstallStatusline
 * deletes whatever `statusLine` it finds; that is safe behind the app's UI,
 * which only offers uninstall when the state is already 'installed', and is
 * NOT safe here, where the uninstaller calls this unconditionally. A user who
 * configured some other statusline tool and never enabled Aether's would
 * otherwise have that tool silently deleted by uninstalling this app.
 */
export async function runStatuslineUninstall(
  settingsPath: string,
  scriptPath: string
): Promise<StatuslineUninstallResult> {
  let state;
  try {
    state = await readInstallState(settingsPath, scriptPath);
  } catch (err: any) {
    return { code: 1, message: `could not read ${settingsPath}: ${err?.message ?? String(err)}` };
  }

  if (state.status !== 'installed') {
    // 'not-installed'   -- nothing to do.
    // 'installed-other' -- somebody else's statusLine; not ours to remove.
    // 'unreadable'      -- a file we could not parse, so we must not rewrite it.
    return {
      code: 0,
      message: `no Aether statusline to remove (${state.status})`,
    };
  }

  try {
    const result = await uninstallStatusline(settingsPath, scriptPath);
    if (!result.ok) {
      return { code: 1, message: `could not update ${settingsPath}: ${result.error}` };
    }
    return {
      code: 0,
      message: result.backupPath
        ? `statusline removed from ${settingsPath} (backup: ${result.backupPath})`
        : `statusline removed from ${settingsPath}`,
    };
  } catch (err: any) {
    return { code: 1, message: `could not update ${settingsPath}: ${err?.message ?? String(err)}` };
  }
}
