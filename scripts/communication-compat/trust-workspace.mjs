// Pre-accepts Claude Code's folder-trust dialog for a scratch probe workspace.
//
// prepare-run.mjs creates a FRESH workspace per run, and every fresh directory
// makes the client stop on a trust screen before it ever connects to the MCP
// server. That turned the "model-bearing step" into a step that silently needed
// a human to click something undocumented: run 5 sat parked at showSetupScreens()
// with a 24 KB debug log and no events at all, looking like a harness failure.
//
// This writes exactly what accepting that dialog writes -- hasTrustDialogAccepted
// on one project entry, for a directory this harness just created -- and nothing
// else. ~/.claude.json is the operator's real config, so:
//
//   * refuse if it is a symlink, so a rename cannot replace the link's target
//   * back it up first, and report where
//   * change exactly one key under exactly one project path
//   * write via tmp + rename in the same directory, so a crash cannot truncate it
//   * re-read afterwards and verify both the new flag AND that the rest of the
//     file is byte-identical to what we intended; restore the backup if not
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export function trustWorkspace(workspace, configPath = join(homedir(), '.claude.json'), options = {}) {
  // `beforePublish` exists so verify-trust-workspace.mjs can simulate another
  // Claude process writing the config mid-sequence. Nothing in normal operation
  // passes it.
  const { beforePublish, attempt = 1 } = options;
  if (!existsSync(configPath)) return { trusted: false, reason: `no config at ${configPath}` };
  if (lstatSync(configPath).isSymbolicLink()) {
    return { trusted: false, reason: 'refusing to rewrite a symlinked ~/.claude.json' };
  }

  let original;
  try { original = readFileSync(configPath, 'utf8'); }
  catch (e) { return { trusted: false, reason: `config is not readable: ${e.message}` }; }
  let config;
  try { config = JSON.parse(original); }
  catch (e) { return { trusted: false, reason: `config is not parseable JSON: ${e.message}` }; }

  config.projects ??= {};
  const existing = config.projects[workspace];
  if (existing?.hasTrustDialogAccepted === true) return { trusted: true, alreadyTrusted: true };

  // Mirror the shape the client writes for a new project, then set the one flag.
  config.projects[workspace] = {
    allowedTools: [], mcpContextUris: [], mcpServers: {},
    enabledMcpjsonServers: [], disabledMcpjsonServers: [],
    ...existing,
    hasTrustDialogAccepted: true,
  };

  const intended = JSON.stringify(config, null, 2) + '\n';
  const backup = `${configPath}.compat-backup-${Date.now()}`;
  const tmp = join(dirname(configPath), `.claude.json.compat-tmp-${process.pid}`);

  // Every step below can fail for reasons that have nothing to do with us: an
  // unwritable directory, a full disk, or Windows briefly locking the
  // destination during rename. None of those should abort the caller -- it has
  // a documented fallback (warn, and let the operator answer the trust screen),
  // and an exception would skip it after the run directory is already built.
  let after;
  try {
    copyFileSync(configPath, backup);

    // Claude Code rewrites this file constantly (lastCost, lastDuration, and so
    // on) and the operator runs several sessions, so another process can land a
    // write between our read and this publish. `intended` would then be built on
    // stale contents, and the rename would silently discard that update while
    // this function reported success. The backup is taken from the CURRENT file,
    // so comparing it against what we read is how we notice.
    const atBackup = readFileSync(backup, 'utf8');
    if (atBackup !== original) {
      try { unlinkSync(backup); } catch { /* best effort */ }
      if (attempt < 2) {
        // Rebuild from the newer contents once; a second collision means the
        // file is too busy to update safely from here.
        return trustWorkspace(workspace, configPath, { ...options, attempt: attempt + 1 });
      }
      return { trusted: false,
        reason: 'config changed concurrently while updating; not overwriting another process\'s write' };
    }

    if (beforePublish) beforePublish(configPath);

    writeFileSync(tmp, intended);

    // Re-check immediately before the rename: the window between the backup and
    // the publish is small but not zero.
    const atPublish = readFileSync(configPath, 'utf8');
    if (atPublish !== original) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      try { unlinkSync(backup); } catch { /* best effort */ }
      if (attempt < 2) return trustWorkspace(workspace, configPath, { ...options, attempt: attempt + 1 });
      return { trusted: false,
        reason: 'config changed concurrently while updating; not overwriting another process\'s write' };
    }

    renameSync(tmp, configPath);
    after = readFileSync(configPath, 'utf8');
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    // If the rename already landed, the config may be mid-change; put the
    // backup back rather than leaving it in an unknown state.
    try { if (existsSync(backup)) copyFileSync(backup, configPath); } catch { /* best effort */ }
    return { trusted: false, reason: `filesystem error while updating config: ${e.message}`,
      backup: existsSync(backup) ? backup : undefined };
  }
  const ok = after === intended
    && JSON.parse(after).projects?.[workspace]?.hasTrustDialogAccepted === true;
  if (!ok) {
    copyFileSync(backup, configPath);
    return { trusted: false, reason: 'verification failed; original config restored from backup', backup };
  }

  // Confirm the only difference is the intended one: every other project entry
  // and every top-level key must survive untouched.
  const before = JSON.parse(original);
  const now = JSON.parse(after);
  const strippedBefore = { ...before, projects: { ...before.projects } };
  const strippedNow = { ...now, projects: { ...now.projects } };
  delete strippedBefore.projects[workspace];
  delete strippedNow.projects[workspace];
  if (JSON.stringify(strippedBefore) !== JSON.stringify(strippedNow)) {
    copyFileSync(backup, configPath);
    return { trusted: false, reason: 'unintended change detected; original config restored from backup', backup };
  }

  return { trusted: true, backup };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const workspace = process.argv[2];
  if (!workspace) { console.error('usage: node trust-workspace.mjs <absolute workspace path>'); process.exit(2); }
  const result = trustWorkspace(workspace);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.trusted ? 0 : 1);
}
