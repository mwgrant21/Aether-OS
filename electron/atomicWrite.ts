import { constants, promises as fsp } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { randomBytes } from 'crypto';

// The one implementation of "back up, then replace a user file safely" for the
// Electron main process. Ported from collector/src/hookInstaller.ts, which grew
// these rules the hard way (#59, #60); electron/statuslineInstaller.ts and
// electron/guidanceWriter.ts both write user-owned files and must not drift
// from it. The Go port (collector-go/internal/hookinstall) mirrors the naming
// and cleanup rules; symlink and mode preservation below are Electron-only so
// far, tracked for the collector copies in #63.

/**
 * A sibling of `targetPath` whose name is unique per invocation even when two
 * writers (this app, the TS collector, the Go collector) hit the same
 * millisecond: timestamp + pid + 4 random bytes. Uniqueness is what makes a
 * failing writer's cleanup safe -- it can only ever remove its own file (#59)
 * -- and what stops a second backup from overwriting the user's pristine
 * first one (#60).
 *
 * The temp marker is deliberately the same (`aethertmp`) for every file this
 * module writes, so one sweep can find strays; only backup markers vary, since
 * they are the artifact a user goes looking for by name.
 */
export function uniqueSiblingPath(targetPath: string, marker: string): string {
  return `${targetPath}.${marker}-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

/**
 * The real file behind `targetPath`, following symlinks. A user whose
 * `~/.claude/CLAUDE.md` (or settings.json) is a link into a dotfiles repo must
 * keep that link: writing through it is what they asked for, and replacing it
 * with a regular file silently disconnects the repo.
 *
 * A DANGLING link resolves to its intended destination, not to the link, so
 * the first write creates what the user pointed at. Only a path that is not a
 * link at all falls back to itself, which is the plain new-file case. The
 * depth cap makes a symlink loop terminate rather than recurse forever.
 */
export async function resolveRealPath(targetPath: string, depth = 0): Promise<string> {
  try {
    return await fsp.realpath(targetPath);
  } catch {
    // realpath throws for a path that does not exist -- which covers both a
    // plain new file AND a DANGLING link, whose intended destination is
    // missing. Falling back to the path itself would be right for the first
    // and wrong for the second: it would replace the link with a regular file
    // and leave the destination the user pointed at still absent.
    if (depth < 32) {
      try {
        if ((await fsp.lstat(targetPath)).isSymbolicLink()) {
          const link = await fsp.readlink(targetPath);
          const next = isAbsolute(link) ? link : resolve(dirname(targetPath), link);
          return await resolveRealPath(next, depth + 1);
        }
      } catch {
        // Not a link, or unreadable: fall through to the path itself.
      }
    }
    return targetPath;
  }
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
 *
 * Follows a symlinked target and carries the existing file's permission bits
 * onto the replacement, so an atomic replace is not observably different from
 * a direct write apart from being safe. Refuses a read-only target, and falls
 * back to an in-place write for a hard-linked one, which a rename would sever.
 */
export async function writeFileAtomically(targetPath: string, content: string): Promise<void> {
  const realPath = await resolveRealPath(targetPath);

  // Replacing a file must not widen its permissions: a 0600 CLAUDE.md stays
  // 0600 rather than becoming whatever the umask allows. Undefined when the
  // file does not exist yet, in which case the default applies as before.
  let mode: number | undefined;
  let hardLinked = false;
  try {
    const stat = await fsp.stat(realPath);
    mode = stat.mode & 0o777;
    hardLinked = stat.nlink > 1;
  } catch {
    mode = undefined;
  }

  // A rename is governed by the DIRECTORY's permissions, so it would happily
  // replace a file the user deliberately made read-only -- something the plain
  // write this replaced would have refused with EACCES. Keep that contract.
  if (mode !== undefined) {
    try {
      await fsp.access(realPath, constants.W_OK);
    } catch {
      const err: NodeJS.ErrnoException = new Error(
        `EACCES: permission denied, write '${realPath}'`
      );
      err.code = 'EACCES';
      err.path = realPath;
      throw err;
    }
  }

  // A hard-linked target is two directory entries sharing one inode, which a
  // rename would sever: the other entry would keep the OLD contents while we
  // report success -- the same silent divergence as replacing a symlink.
  // Write in place instead. That trades back the truncation window this
  // function exists to close, which is the lesser harm here: the caller has
  // already taken a backup, and a truncated file is visible where a severed
  // link is not.
  if (hardLinked) {
    await fsp.writeFile(realPath, content, { encoding: 'utf8' });
    return;
  }

  const tmpPath = uniqueSiblingPath(realPath, 'aethertmp');
  try {
    // flag wx: exclusive create, so a collision is an error rather than a clobber.
    // mode at CREATION, not after: creating under the umask and narrowing later
    // leaves a window where another local user can open the temp file and keep
    // the descriptor. umask can only clear bits, never add them, so a
    // restrictive mode survives it; the chmod below still runs to make a
    // permissive mode exact.
    await fsp.writeFile(tmpPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      ...(mode !== undefined ? { mode } : {}),
    });
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
    // chmod before the rename, so the file is never briefly visible at the
    // target path with the wrong mode.
    if (mode !== undefined) await fsp.chmod(tmpPath, mode);
    await fsp.rename(tmpPath, realPath);
  } catch (err) {
    // Past the create, the temp file is ours whatever the failure was.
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
