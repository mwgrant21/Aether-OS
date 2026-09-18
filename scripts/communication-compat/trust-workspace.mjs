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

export function trustWorkspace(workspace, configPath = join(homedir(), '.claude.json')) {
  if (!existsSync(configPath)) return { trusted: false, reason: `no config at ${configPath}` };
  if (lstatSync(configPath).isSymbolicLink()) {
    return { trusted: false, reason: 'refusing to rewrite a symlinked ~/.claude.json' };
  }

  const original = readFileSync(configPath, 'utf8');
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
  copyFileSync(configPath, backup);

  const tmp = join(dirname(configPath), `.claude.json.compat-tmp-${process.pid}`);
  writeFileSync(tmp, intended);
  renameSync(tmp, configPath);

  // Verify by reading back, not by trusting the write.
  const after = readFileSync(configPath, 'utf8');
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
