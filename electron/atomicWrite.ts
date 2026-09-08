import { promises as fsp } from 'fs';
import { randomBytes } from 'crypto';

// The one implementation of "back up, then replace a user file safely" for the
// Electron main process. Ported from collector/src/hookInstaller.ts, which grew
// these rules the hard way (#59, #60); electron/statuslineInstaller.ts and
// main.ts's optimize:apply both write user-owned files and must not drift from
// it. The Go port (collector-go/internal/hookinstall) mirrors the same rules.

/**
 * A sibling of `targetPath` whose name is unique per invocation even when two
 * writers (this app, the TS collector, the Go collector) hit the same
 * millisecond: timestamp + pid + 4 random bytes. Uniqueness is what makes a
 * failing writer's cleanup safe -- it can only ever remove its own file (#59)
 * -- and what stops a second backup from overwriting the user's pristine
 * first one (#60).
 */
export function uniqueSiblingPath(targetPath: string, marker: string): string {
  return `${targetPath}.${marker}-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

/**
 * Copies `raw` to a uniquely named sibling and returns its path. Created
 * exclusively, so it can never overwrite an earlier backup.
 */
export async function writeBackup(targetPath: string, raw: string, marker: string): Promise<string> {
  const backupPath = uniqueSiblingPath(targetPath, marker);
  await fsp.writeFile(backupPath, raw, { encoding: 'utf8', flag: 'wx' });
  return backupPath;
}

/**
 * Write-tmp-then-rename, so the target is never observably partial: a crash,
 * power loss, or ENOSPC part-way through a direct write would otherwise leave
 * the user's real file truncated, and a backup only helps once they notice.
 * Never leaves its temp file behind (#59).
 */
export async function writeFileAtomically(targetPath: string, content: string): Promise<void> {
  const tmpPath = uniqueSiblingPath(targetPath, 'aethertmp');
  try {
    // flag wx: exclusive create, so a collision is an error rather than a clobber.
    await fsp.writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    // A lost exclusive create (EEXIST) means the file is another writer's: leave
    // it alone. Any other failure may have created it (ENOSPC after open), so
    // it is ours to remove. The original error is what the caller sees.
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    }
    throw err;
  }
  try {
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    // Past the create, the temp file is ours whatever the rename error was.
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
