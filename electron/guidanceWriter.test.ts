import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { applyGuidanceToFile } from './guidanceWriter';
import { GUIDANCE_BY_ID, isGuidanceApplied } from '../src/shared/optimizeActions';

const FINDING = 'opus-on-trivial-turns';
const OTHER_FINDING = 'unpinned-config-re-reads';

function freshTarget(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-guidance-'));
  const p = join(dir, 'CLAUDE.md');
  if (content !== undefined) writeFileSync(p, content, 'utf8');
  return p;
}

const backups = (p: string) => readdirSync(dirname(p)).filter((f) => f.includes('.ttbak-'));
const temps = (p: string) => readdirSync(dirname(p)).filter((f) => f.includes('.aethertmp-'));

describe('applyGuidanceToFile', () => {
  it('creates the file when it does not exist and takes no backup', async () => {
    const target = freshTarget();
    const result = await applyGuidanceToFile(target, FINDING);
    expect(result).toEqual({ ok: true, added: true, backupPath: null });
    expect(isGuidanceApplied(readFileSync(target, 'utf8'), FINDING)).toBe(true);
    expect(backups(target)).toEqual([]);
  });

  it('backs up the original bytes before rewriting an existing file', async () => {
    const original = '# My guidance\n\n- keep this line\n';
    const target = freshTarget(original);
    const result = await applyGuidanceToFile(target, FINDING);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.added) throw new Error('expected an added result');
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
    const written = readFileSync(target, 'utf8');
    expect(written).toContain('- keep this line');
    expect(isGuidanceApplied(written, FINDING)).toBe(true);
  });

  it('reports alreadyPresent without writing or backing up when the guidance is already there', async () => {
    const target = freshTarget('# g\n');
    await applyGuidanceToFile(target, FINDING);
    const afterFirst = readFileSync(target, 'utf8');
    const backupsAfterFirst = backups(target).length;

    const second = await applyGuidanceToFile(target, FINDING);
    expect(second).toEqual({ ok: true, added: false, alreadyPresent: true });
    expect(readFileSync(target, 'utf8')).toBe(afterFirst);
    expect(backups(target)).toHaveLength(backupsAfterFirst);
  });

  it('keeps both backups when two applies land in the same millisecond (#66)', async () => {
    const original = '# g\n';
    const target = freshTarget(original);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1700000000000));
    try {
      const first = await applyGuidanceToFile(target, FINDING);
      const afterFirst = readFileSync(target, 'utf8');
      const second = await applyGuidanceToFile(target, OTHER_FINDING);
      if (!first.ok || !first.added || !second.ok || !second.added) throw new Error('expected two added results');
      expect(first.backupPath).not.toBe(second.backupPath);
      expect(readFileSync(first.backupPath!, 'utf8')).toBe(original);
      expect(readFileSync(second.backupPath!, 'utf8')).toBe(afterFirst);
      expect(backups(target)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the file byte-identical and no temp file behind when the rename fails (#59)', async () => {
    const original = '# g\n';
    const target = freshTarget(original);
    const spy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(new Error('EACCES: simulated rename failure'));
    let result;
    try {
      result = await applyGuidanceToFile(target, FINDING);
    } finally {
      spy.mockRestore();
    }
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error).toContain('simulated rename failure');
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(temps(target)).toEqual([]);
  });

  it('reports an unknown finding as not added, leaving the file untouched', async () => {
    const original = '# g\n';
    const target = freshTarget(original);
    const result = await applyGuidanceToFile(target, 'no-such-finding');
    expect(result).toEqual({ ok: true, added: false, alreadyPresent: true });
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(backups(target)).toEqual([]);
  });

  it('surfaces a non-ENOENT read failure instead of treating the file as absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-guidance-dir-'));
    const result = await applyGuidanceToFile(dir, FINDING);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error).toMatch(/EISDIR/);
  });

  it('writes guidance text that matches the shared guidance map', async () => {
    const target = freshTarget();
    await applyGuidanceToFile(target, FINDING);
    expect(readFileSync(target, 'utf8')).toContain(GUIDANCE_BY_ID[FINDING]);
    expect(existsSync(target)).toBe(true);
  });
});
