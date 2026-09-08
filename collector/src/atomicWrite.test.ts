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
  chmodSync,
  linkSync,
  statSync as fsStatSync,
  promises as fsp,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { uniqueSiblingPath, writeBackup, writeFileAtomically, resolveRealPath } from './atomicWrite.js';

function freshTarget(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-atomicwrite-'));
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
    const d = mkdtempSync(join(tmpdir(), 'aether-collector-symlink-probe-'));
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
      const realDir = mkdtempSync(join(tmpdir(), 'aether-collector-symlink-real-'));
      const linkDir = mkdtempSync(join(tmpdir(), 'aether-collector-symlink-link-'));
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
      const dir = mkdtempSync(join(tmpdir(), 'aether-collector-symlink-resolve-'));
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
      const dir = mkdtempSync(join(tmpdir(), 'aether-collector-symlink-dangling-'));
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
