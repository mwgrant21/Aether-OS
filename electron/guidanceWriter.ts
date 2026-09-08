import { promises as fsp } from 'fs';
import { dirname } from 'path';
import { guidanceFor, upsertGuidance } from '../src/shared/optimizeActions';
import { resolveRealPath, writeBackup, writeFileAtomically } from './atomicWrite';

export type ApplyGuidanceResult =
  | { ok: true; added: false; alreadyPresent: true }
  | { ok: true; added: true; backupPath: string | null }
  | { ok: false; error: string };

/**
 * The file-mutating half of the optimize:apply IPC handler, extracted so it can
 * be tested without the Electron main process. Reads the target, upserts the
 * managed guidance block, backs the original up under a unique name, and
 * replaces the file atomically (#66) -- previously this path wrote a
 * `.ttbak-<ms>` backup that a same-millisecond apply would overwrite, then
 * wrote the target directly, leaving it truncated if the write died part-way.
 *
 * Recording appliedAt stays with the caller: it is state bookkeeping, not part
 * of mutating the user's file, and it also runs on the alreadyPresent path.
 */
export async function applyGuidanceToFile(
  targetPath: string,
  findingId: string
): Promise<ApplyGuidanceResult> {
  // An unknown finding has no guidance to write. upsertGuidance reports that
  // the same way it reports "already present" (added: false), so distinguish
  // them here rather than telling the caller a write succeeded that never
  // happened -- that would start the recurrence clock for a finding the file
  // never received.
  if (guidanceFor(findingId) === null) return { ok: false, error: 'unknown finding' };

  try {
    // Follow a symlinked CLAUDE.md so the backup and the replacement both land
    // on the real file and the link survives.
    const realPath = await resolveRealPath(targetPath);
    let existing = '';
    let fileExisted = true;
    try {
      existing = await fsp.readFile(realPath, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        existing = '';
        fileExisted = false;
      } else {
        throw err;
      }
    }

    const { content, added } = upsertGuidance(existing, findingId);
    if (!added) {
      return { ok: true, added: false, alreadyPresent: true };
    }

    let backupPath: string | null = null;
    if (fileExisted) backupPath = await writeBackup(realPath, existing, 'ttbak');
    await fsp.mkdir(dirname(realPath), { recursive: true });
    await writeFileAtomically(realPath, content);
    return { ok: true, added: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
