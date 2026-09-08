import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { uniqueSiblingPath, writeBackup, writeFileAtomically } from './atomicWrite';

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

  it("creates the backup exclusively, so it can never overwrite an earlier one (#60)", async () => {
    const target = freshTarget('original');
    const spy = vi.spyOn(fsp, 'writeFile');
    try {
      await writeBackup(target, 'original', 'ttbak');
      const options = spy.mock.calls[0][2] as { flag?: string };
      expect(options?.flag).toBe('wx');
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates the error instead of overwriting when the backup name already exists', async () => {
    const target = freshTarget('original');
    const spy = vi
      .spyOn(fsp, 'writeFile')
      .mockRejectedValueOnce(Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }));
    try {
      await expect(writeBackup(target, 'newer', 'ttbak')).rejects.toThrow('EEXIST');
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(target, 'utf8')).toBe('original');
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
