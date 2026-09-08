import { promises as fsp } from 'fs';
import { dirname } from 'path';
import { upsertGuidance } from '../src/shared/optimizeActions';
import { writeBackup, writeFileAtomically } from './atomicWrite';

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
  try {
    let existing = '';
    let fileExisted = true;
    try {
      existing = await fsp.readFile(targetPath, 'utf8');
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
    if (fileExisted) backupPath = await writeBackup(targetPath, existing, 'ttbak');
    await fsp.mkdir(dirname(targetPath), { recursive: true });
    await writeFileAtomically(targetPath, content);
    return { ok: true, added: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
