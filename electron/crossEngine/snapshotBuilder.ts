// Builds an isolated on-disk snapshot of a dispatch's touched files, for
// handing to a cross-engine verifier: the committed baseline plus exactly the
// current content of the files the dispatch's own tool calls touched --
// never the whole working tree, and never anything the dispatch didn't
// touch. See the Task 0 reconciliation note under docs/superpowers/specs/
// (2026-08-07, cross-engine verification).

import { mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DispatchEvidence } from './dispatchEvidence';

const execFileAsync = promisify(execFile);

export interface VerificationSnapshot {
  snapshotDir: string;
  dispose: () => Promise<void>;
}

/** Rejects any touched path that escapes the project root after
 *  normalization -- the untrusted input here is file_path_rel from SQLite,
 *  which this repo's own privacy conventions already require to be
 *  project-relative, but this is re-verified rather than trusted. */
function assertContained(projectRoot: string, relPath: string): string {
  const abs = resolvePath(projectRoot, relPath);
  const rootWithSep = resolvePath(projectRoot) + sep;
  if (abs !== resolvePath(projectRoot) && !abs.startsWith(rootWithSep)) {
    throw new Error(`touched path escapes project root: ${relPath}`);
  }
  return abs;
}

export async function buildVerificationSnapshot(evidence: DispatchEvidence): Promise<VerificationSnapshot> {
  const snapshotDir = await mkdtemp(join(tmpdir(), 'aether-codex-verify-'));

  try {
    // Committed baseline first (git archive HEAD is insufficient alone --
    // it omits uncommitted work, so it's combined with an explicit copy of
    // the exact approved touched paths below).
    await execFileAsync('git', ['archive', 'HEAD', '-o', join(snapshotDir, '__baseline.tar')], { cwd: evidence.projectRoot });
    // --force-local: without it, (GNU/bsd)tar on Windows parses an absolute
    // path with a drive letter (`C:\...`) as a `host:file` remote-archive
    // spec (the colon after the drive letter is ambiguous with the
    // ssh-remote-tar syntax), and fails with "Cannot connect to C:". Passing
    // the archive name as a bare filename with cwd set to snapshotDir avoids
    // re-introducing an absolute path into the command at all.
    await execFileAsync('tar', ['--force-local', '-xf', '__baseline.tar'], { cwd: snapshotDir });
    await rm(join(snapshotDir, '__baseline.tar'));

    for (const relPath of evidence.touchedFiles) {
      const srcAbs = assertContained(evidence.projectRoot, relPath);
      const destAbs = assertContained(snapshotDir, relPath);
      await mkdir(dirname(destAbs), { recursive: true });
      try {
        await copyFile(srcAbs, destAbs);
      } catch {
        // File deleted since the dispatch touched it: represent the
        // deletion by removing it from the snapshot if the baseline had it.
        await rm(destAbs, { force: true });
      }
    }
  } catch (err) {
    await rm(snapshotDir, { recursive: true, force: true });
    throw err;
  }

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await rm(snapshotDir, { recursive: true, force: true });
  };

  return { snapshotDir, dispose };
}
