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
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, lstatSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// How long to watch the config for activity before committing to a publish.
// Long enough to catch a client that is mid-rewrite, short enough that the
// probe's startup cost stays invisible.
const QUIESCE_MS = 25;

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// mtime+size rather than a content hash: this runs twice per publish on a file
// the client rewrites constantly, and we only need "did anything move".
function fingerprint(path) {
  const st = statSync(path);
  return `${st.mtimeMs}:${st.size}`;
}

// The client keys `projects` by the workspace path spelled with FORWARD slashes,
// even on Windows. Callers hand us a path from path.resolve(), which on Windows
// is backslashed, so writing that spelling verbatim creates a second, unused
// entry: the flag gets set on a key the client never looks up, trustWorkspace
// reports success, prepare-run suppresses its manual-dialog warning, and the
// probe still stops on the trust screen.
//
// This is not hypothetical -- the operator's own config carried both spellings
// of the 2026-09-17T06-50-59-953Z probe workspace, 13 forward-slash keys written
// by the client and 1 backslash key written by this script.
//
// Normalising here rather than at the call site covers the CLI entrypoint below
// too, and matches what prepare-run.mjs already does for `cwd` and
// `transcript_hint`.
export function projectKeyFor(workspace) {
  return workspace.replace(/\\/g, '/');
}

export function trustWorkspace(workspaceArg, configPath = join(homedir(), '.claude.json'), options = {}) {
  // `beforePublish` exists so verify-trust-workspace.mjs can simulate another
  // Claude process writing the config mid-sequence. Nothing in normal operation
  // passes it.
  const { beforePublish, afterPublish, duringQuiesce, quiesceMs = QUIESCE_MS, attempt = 1 } = options;
  const workspace = projectKeyFor(workspaceArg);
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
  if (existing?.hasTrustDialogAccepted === true) return { trusted: true, alreadyTrusted: true, projectKey: workspace };

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

    // The interval between the last observation below and renameSync CANNOT be
    // closed from here. rename is not a compare-and-swap: once it lands our
    // bytes ARE the file, so a write that slipped into that interval leaves
    // nothing behind to detect -- the read-back afterwards sees exactly
    // `intended` either way. Reordering does not help (any snapshot is still
    // taken before the rename), and a lock file would only serialise this
    // script against itself, since the client does not take one.
    //
    // What is reachable is refusing to publish into a file that is visibly
    // being written RIGHT NOW. Two observations a short interval apart: if
    // anything moved, a client is mid-rewrite and racing it is a coin flip, so
    // the publish is abandoned in favour of the documented fallback (warn, let
    // the operator answer the trust screen). This shrinks exposure to the
    // irreducible interval; it does not eliminate it.
    const beforeQuiesce = fingerprint(configPath);
    sleepSync(quiesceMs);
    if (duringQuiesce) duringQuiesce(configPath);   // test-only seam
    if (fingerprint(configPath) !== beforeQuiesce) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      try { unlinkSync(backup); } catch { /* best effort */ }
      if (attempt < 2) return trustWorkspace(workspace, configPath, { ...options, attempt: attempt + 1 });
      return { trusted: false,
        reason: 'config is being rewritten by another process; not publishing into an active write' };
    }

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
    // Test-only: lets a control race the interval between publishing and
    // reading back. beforePublish fires earlier and cannot reach this window.
    if (afterPublish) afterPublish(configPath);
    after = readFileSync(configPath, 'utf8');
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    // If the rename already landed, the config may be mid-change; put the
    // backup back rather than leaving it in an unknown state.
    try { if (existsSync(backup)) copyFileSync(backup, configPath); } catch { /* best effort */ }
    return { trusted: false, reason: `filesystem error while updating config: ${e.message}`,
      backup: existsSync(backup) ? backup : undefined };
  }
  // Restore ONLY while the live file still holds exactly what we published. If it
  // does not, someone wrote after our rename, and putting the backup back would
  // discard their newer config.
  const restoreIfStillOurs = (reason) => {
    let live = null;
    try { live = readFileSync(configPath, 'utf8'); } catch { /* treat as unreadable below */ }
    if (live === intended) {
      try { copyFileSync(backup, configPath); } catch { /* best effort */ }
      return { trusted: false, reason: reason + '; original config restored from backup', backup };
    }
    return { trusted: false,
      reason: reason + '; config was changed by another process after publishing, so it was left alone',
      backup };
  };

  const ok = after === intended
    && JSON.parse(after).projects?.[workspace]?.hasTrustDialogAccepted === true;
  if (!ok) return restoreIfStillOurs('verification failed');

  // Confirm the only difference is the intended one: every other project entry
  // and every top-level key must survive untouched.
  const before = JSON.parse(original);
  const now = JSON.parse(after);
  const strippedBefore = { ...before, projects: { ...before.projects } };
  const strippedNow = { ...now, projects: { ...now.projects } };
  delete strippedBefore.projects[workspace];
  delete strippedNow.projects[workspace];
  if (JSON.stringify(strippedBefore) !== JSON.stringify(strippedNow)) {
    return restoreIfStillOurs('unintended change detected');
  }

  return { trusted: true, backup, projectKey: workspace };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const workspace = process.argv[2];
  if (!workspace) { console.error('usage: node trust-workspace.mjs <absolute workspace path>'); process.exit(2); }
  const result = trustWorkspace(workspace);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.trusted ? 0 : 1);
}
