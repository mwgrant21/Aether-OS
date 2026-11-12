import { describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  statSync,
  symlinkSync,
  readlinkSync,
  chmodSync,
  linkSync,
  statSync as fsStatSync,
  promises as fsp,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { uniqueSiblingPath, writeBackup, writeFileAtomically, resolveRealPath } from './atomicWrite';

function freshTarget(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-atomicwrite-'));
  const p = join(dir, 'target.json');
  if (content !== undefined) writeFileSync(p, content, 'utf8');
  return p;
}

const siblings = (p: string, marker: string) =>
  readdirSync(dirname(p)).filter((f) => f.includes(`.${marker}-`));

describe('uniqueSiblingPath', () => {
  it('sits beside the target with the requested marker', () => {
    const p = uniqueSiblingPath('/tmp/settings.json', 'ttbak');
    expect(p.startsWith('/tmp/settings.json.ttbak-')).toBe(true);
  });

  it('is distinct for two calls in the same millisecond (#60)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1700000000000));
    try {
      expect(uniqueSiblingPath('/tmp/x', 'm')).not.toBe(uniqueSiblingPath('/tmp/x', 'm'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('writeBackup', () => {
  it('writes the raw bytes to a marked sibling and returns its path', async () => {
    const target = freshTarget('original');
    const backupPath = await writeBackup(target, 'original', 'ttbak');
    expect(readFileSync(backupPath, 'utf8')).toBe('original');
    expect(siblings(target, 'ttbak')).toHaveLength(1);
  });

  it('keeps both backups when two are taken in the same millisecond (#60)', async () => {
    const target = freshTarget('v1');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1700000000000));
    try {
      const first = await writeBackup(target, 'v1', 'ttbak');
      const second = await writeBackup(target, 'v2', 'ttbak');
      expect(first).not.toBe(second);
      expect(readFileSync(first, 'utf8')).toBe('v1');
      expect(readFileSync(second, 'utf8')).toBe('v2');
      expect(siblings(target, 'ttbak')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to overwrite a backup another writer created at the same name (#60)", async () => {
    const target = freshTarget('original');
    const realWriteFile = fsp.writeFile.bind(fsp);
    let contested = '';
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      contested = String(file);
      // Another writer wins the name first; our exclusive create must now fail
      // for real rather than clobbering it.
      await realWriteFile(contested, 'pristine', 'utf8');
      return realWriteFile(file, data, options);
    });
    try {
      await expect(writeBackup(target, 'newer', 'ttbak')).rejects.toThrow(/EEXIST/);
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(contested, 'utf8')).toBe('pristine');
  });
});

describe('writeFileAtomically', () => {
  it('writes the content and leaves no temp file behind', async () => {
    const target = freshTarget('old');
    await writeFileAtomically(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(siblings(target, 'aethertmp')).toEqual([]);
  });

  it('creates a target that does not exist yet', async () => {
    const target = freshTarget();
    expect(existsSync(target)).toBe(false);
    await writeFileAtomically(target, 'fresh');
    expect(readFileSync(target, 'utf8')).toBe('fresh');
  });

  it('reports the rename failure, leaves the target byte-identical, and removes its temp file (#59)', async () => {
    const target = freshTarget('keep');
    const spy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(new Error('EACCES: simulated rename failure'));
    try {
      await expect(writeFileAtomically(target, 'new')).rejects.toThrow('simulated rename failure');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(siblings(target, 'aethertmp')).toEqual([]);
  });

  it('removes a temp file created by a write that then failed mid-write (#59)', async () => {
    const target = freshTarget('keep');
    const realWriteFile = fsp.writeFile.bind(fsp);
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      if (String(file).includes('.aethertmp-')) {
        await realWriteFile(file, '', 'utf8');
        throw new Error('ENOSPC: simulated write failure');
      }
      return realWriteFile(file, data, options);
    });
    try {
      await expect(writeFileAtomically(target, 'new')).rejects.toThrow('simulated write failure');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(siblings(target, 'aethertmp')).toEqual([]);
  });

  it("leaves another writer's temp file alone when exclusive creation loses the name (#59)", async () => {
    const target = freshTarget('keep');
    const realWriteFile = fsp.writeFile.bind(fsp);
    let contested = '';
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      if (String(file).includes('.aethertmp-')) {
        contested = String(file);
        await realWriteFile(file, 'other writer', 'utf8');
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      }
      return realWriteFile(file, data, options);
    });
    try {
      await expect(writeFileAtomically(target, 'new')).rejects.toThrow('EEXIST');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(contested, 'utf8')).toBe('other writer');
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });
});

// Creating a symlink needs privilege on Windows; probe once so these cases
// skip locally and still run on the Linux CI lanes where they matter.
const symlinkSupported = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'aether-symlink-probe-'));
    writeFileSync(join(d, 'real'), 'x', 'utf8');
    symlinkSync(join(d, 'real'), join(d, 'link'));
    return true;
  } catch {
    return false;
  }
})();

describe('writeFileAtomically: symlinks and permissions', () => {
  it.skipIf(!symlinkSupported)(
    'writes through a symlinked target instead of replacing the link (#66)',
    async () => {
      const realDir = mkdtempSync(join(tmpdir(), 'aether-symlink-real-'));
      const linkDir = mkdtempSync(join(tmpdir(), 'aether-symlink-link-'));
      const realFile = join(realDir, 'CLAUDE.md');
      const link = join(linkDir, 'CLAUDE.md');
      writeFileSync(realFile, 'original', 'utf8');
      symlinkSync(realFile, link);

      await writeFileAtomically(link, 'updated');

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(realFile, 'utf8')).toBe('updated');
      // The temp file must land beside the REAL file, and be cleaned up.
      expect(readdirSync(realDir).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
      expect(readdirSync(linkDir).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
    }
  );

  it.skipIf(!symlinkSupported)(
    'resolveRealPath follows a link and falls back to the path itself when it does not exist',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'aether-symlink-resolve-'));
      const realFile = join(dir, 'real.md');
      const link = join(dir, 'link.md');
      writeFileSync(realFile, 'x', 'utf8');
      symlinkSync(realFile, link);
      expect(await resolveRealPath(link)).toBe(await fsp.realpath(realFile));

      const missing = join(dir, 'not-there.md');
      expect(await resolveRealPath(missing)).toBe(missing);
    }
  );

  it.skipIf(!symlinkSupported)(
    'writes the intended destination of a dangling symlink instead of replacing the link',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'aether-symlink-dangling-'));
      const missingTarget = join(dir, 'not-yet-there.md');
      const link = join(dir, 'CLAUDE.md');
      symlinkSync(missingTarget, link);

      await writeFileAtomically(link, 'created through the link');

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(missingTarget, 'utf8')).toBe('created through the link');
      expect(readdirSync(dir).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
    }
  );

  it(
    'refuses to replace a read-only target rather than bypassing it via the directory',
    async () => {
      const target = freshTarget('protected');
      chmodSync(target, 0o444);
      try {
        await expect(writeFileAtomically(target, 'overwritten')).rejects.toThrow(/EACCES/);
        expect(readFileSync(target, 'utf8')).toBe('protected');
        expect(siblings(target, 'aethertmp')).toEqual([]);
      } finally {
        chmodSync(target, 0o644);
      }
    }
  );

  it(
    'keeps a hard-linked target as one inode instead of severing the link',
    async () => {
      const target = freshTarget('shared');
      const other = target + '.hardlink';
      linkSync(target, other);
      expect(fsStatSync(target).nlink).toBeGreaterThan(1);

      await writeFileAtomically(target, 'updated through one entry');

      // Both directory entries must still be the same file, and both must see
      // the new content -- a rename would have left `other` on the old inode.
      expect(fsStatSync(target).ino).toBe(fsStatSync(other).ino);
      expect(readFileSync(other, 'utf8')).toBe('updated through one entry');
      expect(readFileSync(target, 'utf8')).toBe('updated through one entry');
      expect(siblings(target, 'aethertmp')).toEqual([]);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'creates the temp file with the target mode rather than widening it first',
    async () => {
      const target = freshTarget('private');
      chmodSync(target, 0o600);
      const spy = vi.spyOn(fsp, 'writeFile');
      try {
        await writeFileAtomically(target, 'still private');
        // Call-shape assertion on purpose: the race this guards (another user
        // opening the temp file between create and chmod) is not observable
        // in-process, so the check is that the mode is set AT creation.
        const call = spy.mock.calls.find((c) => String(c[0]).includes('.aethertmp-'));
        expect((call?.[2] as { mode?: number } | undefined)?.mode).toBe(0o600);
      } finally {
        spy.mockRestore();
        chmodSync(target, 0o644);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'carries the existing file mode onto the replacement rather than widening it',
    async () => {
      const target = freshTarget('secret');
      chmodSync(target, 0o600);
      await writeFileAtomically(target, 'still secret');
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, 'utf8')).toBe('still secret');
    }
  );
});

// A chain c0 -> c1 -> ... -> c(n-1) -> <dir>/missing.json, absolute link targets.
// It must END at a missing file: a chain ending at a real file resolves through
// realpath on Windows (so the cap is never reached) and hits the kernel's own
// limit of 40 on Linux, which would make these cases platform-dependent.
function danglingChain(n: number): { dir: string; missing: string; links: string[]; targets: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'aether-symlink-chain-'));
  const missing = join(dir, 'missing.json');
  const links = Array.from({ length: n }, (_, i) => join(dir, `c${i}`));
  const targets = links.map((_, i) => (i === n - 1 ? missing : links[i + 1]));
  links.forEach((l, i) => symlinkSync(targets[i], l));
  return { dir, missing, links, targets };
}

function symlinkLoop(): { dir: string; a: string; b: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aether-symlink-loop-'));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  symlinkSync(b, a);
  symlinkSync(a, b);
  return { dir, a, b };
}

describe('resolveRealPath: the symlink depth cap fails loudly (#72)', () => {
  it.skipIf(!symlinkSupported)('rejects a symlink loop with ELOOP naming the original path', async () => {
    const { a } = symlinkLoop();
    await expect(resolveRealPath(a)).rejects.toMatchObject({
      code: 'ELOOP',
      path: a,
      message: `ELOOP: too many levels of symbolic links, resolve '${a}'`,
    });
  });

  it.skipIf(!symlinkSupported)('rejects a chain deeper than the cap that ends at a missing file', async () => {
    const { links } = danglingChain(34);
    await expect(resolveRealPath(links[0])).rejects.toMatchObject({
      code: 'ELOOP',
      path: links[0],
      message: `ELOOP: too many levels of symbolic links, resolve '${links[0]}'`,
    });
  });

  it.skipIf(!symlinkSupported)('pins the cap at 32 hops: 32 links resolve to the missing file, 33 do not', async () => {
    const ok = danglingChain(32);
    expect(await resolveRealPath(ok.links[0])).toBe(ok.missing);
    const tooDeep = danglingChain(33);
    await expect(resolveRealPath(tooDeep.links[0])).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it.skipIf(!symlinkSupported)('writeFileAtomically leaves every link and the destination alone on a loop', async () => {
    const { dir, a, b } = symlinkLoop();
    await expect(writeFileAtomically(a, 'x')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(lstatSync(a).isSymbolicLink()).toBe(true);
    expect(lstatSync(b).isSymbolicLink()).toBe(true);
    expect(readlinkSync(a)).toBe(b);
    expect(readlinkSync(b)).toBe(a);
    expect(readdirSync(dir).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
  });

  it.skipIf(!symlinkSupported)('writeFileAtomically leaves every link and the destination alone on a deep chain', async () => {
    const { dir, missing, links, targets } = danglingChain(34);
    await expect(writeFileAtomically(links[0], 'x')).rejects.toMatchObject({ code: 'ELOOP' });
    links.forEach((l, i) => {
      expect(lstatSync(l).isSymbolicLink()).toBe(true);
      expect(readlinkSync(l)).toBe(targets[i]);
    });
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('.aethertmp-'))).toEqual([]);
  });
});

// The backup holds the same bytes as the target, so it must not be MORE
// readable than the target (#71). Windows reports 0666 for any writable file,
// so the mode assertions only mean something on POSIX. They never depend on the
// ambient umask: each target is chmod-ed explicitly, and the expectation is the
// requested creation mode filtered by whatever the umask is. (The 0644 case
// only distinguishes "mode threaded through" from "hardcoded 0600" under a
// umask that keeps group read; it is still correct, just weaker, under 077.)
describe('writeBackup: the backup inherits the target mode (#71)', () => {
  const afterUmask = (mode: number) => mode & ~process.umask();
  const modeOf = (p: string) => statSync(p).mode & 0o7777;

  it.skipIf(process.platform === 'win32')('gives a 0600 target a 0600 backup', async () => {
    const target = freshTarget('{"secret":true}');
    chmodSync(target, 0o600);
    const backupPath = await writeBackup(target, '{"secret":true}', 'ttbak');
    expect(modeOf(backupPath)).toBe(afterUmask(0o600));
  });

  it.skipIf(process.platform === 'win32')('gives a 0644 target a 0644 backup, not a hardcoded 0600', async () => {
    const target = freshTarget('{}');
    chmodSync(target, 0o644);
    const backupPath = await writeBackup(target, '{}', 'ttbak');
    expect(modeOf(backupPath)).toBe(afterUmask(0o644));
  });

  it.skipIf(process.platform === 'win32')('keeps owner read+write on a backup of a read-only target', async () => {
    const target = freshTarget('{}');
    chmodSync(target, 0o444);
    try {
      const backupPath = await writeBackup(target, '{}', 'ttbak');
      expect(modeOf(backupPath)).toBe(afterUmask(0o644));
    } finally {
      chmodSync(target, 0o644);
    }
  });

  it.skipIf(process.platform === 'win32')('drops setuid/setgid/sticky bits from the source mode', async () => {
    const target = freshTarget('{}');
    chmodSync(target, 0o4644);
    try {
      const backupPath = await writeBackup(target, '{}', 'ttbak');
      expect(modeOf(backupPath)).toBe(afterUmask(0o644));
    } finally {
      chmodSync(target, 0o644);
    }
  });

  it.skipIf(process.platform === 'win32')('defaults to 0600 when the target cannot be stat-ed', async () => {
    const target = freshTarget();
    expect(existsSync(target)).toBe(false);
    const backupPath = await writeBackup(target, '{}', 'ttbak');
    expect(modeOf(backupPath)).toBe(afterUmask(0o600));
  });

  it.skipIf(process.platform === 'win32' || !symlinkSupported)(
    'reads the mode of the real file behind a symlinked target',
    async () => {
      const real = freshTarget('{}');
      chmodSync(real, 0o600);
      const link = join(dirname(real), 'link.json');
      symlinkSync(real, link);
      const backupPath = await writeBackup(link, '{}', 'ttbak');
      expect(modeOf(backupPath)).toBe(afterUmask(0o600));
    }
  );
});

describe('writeBackup: failure cleanup and error text (#67)', () => {
  it('removes a partial backup created by a write that then failed, and wraps the error', async () => {
    const target = freshTarget('keep');
    const realWriteFile = fsp.writeFile.bind(fsp);
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      if (String(file).includes('.ttbak-')) {
        await realWriteFile(file, '', 'utf8');
        throw Object.assign(new Error('ENOSPC: simulated write failure'), { code: 'ENOSPC' });
      }
      return realWriteFile(file, data, options);
    });
    try {
      await expect(writeBackup(target, 'keep', 'ttbak')).rejects.toMatchObject({
        message: 'could not write backup: ENOSPC: simulated write failure',
        code: 'ENOSPC',
      });
    } finally {
      spy.mockRestore();
    }
    // A truncated file under the backup name would be mistaken for a good backup.
    expect(siblings(target, 'ttbak')).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it("never deletes another writer's backup when the exclusive create loses the name (EEXIST)", async () => {
    const target = freshTarget('original');
    const realWriteFile = fsp.writeFile.bind(fsp);
    let contested = '';
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file: any, data: any, options?: any) => {
      contested = String(file);
      await realWriteFile(contested, 'pristine', 'utf8');
      return realWriteFile(file, data, options);
    });
    try {
      await expect(writeBackup(target, 'newer', 'ttbak')).rejects.toMatchObject({
        message: expect.stringMatching(/^could not write backup: .*EEXIST/),
        code: 'EEXIST',
      });
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(contested, 'utf8')).toBe('pristine');
  });
});
