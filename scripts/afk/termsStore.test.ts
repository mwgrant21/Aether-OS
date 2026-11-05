// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_TERMS } from './terms.mjs';
import { readLiveTerms, termsPath, writeLiveTerms } from './termsStore.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-terms-'));
const put = (dir: string, text: string) => { mkdirSync(dirname(termsPath(dir)), { recursive: true }); writeFileSync(termsPath(dir), text); };
describe('readLiveTerms', () => {
  it('missing file reads as defaults with no warning', () => {
    expect(readLiveTerms(tmp())).toEqual({ terms: DEFAULT_TERMS, source: 'defaults', warnings: [] });
  });
  it('corrupt JSON fails closed to defaults with a warning', () => {
    const d = tmp(); put(d, '{nope');
    const r = readLiveTerms(d);
    expect(r.source).toBe('defaults'); expect(r.terms).toEqual(DEFAULT_TERMS); expect(r.warnings.length).toBe(1);
  });
  it('a file that tries delete:true fails closed to defaults', () => {
    const d = tmp(); put(d, JSON.stringify({ ...DEFAULT_TERMS, delete: true }));
    const r = readLiveTerms(d);
    expect(r.terms.delete).toBe(false); expect(r.source).toBe('defaults'); expect(r.warnings.join(' ')).toContain('delete');
  });
});
describe('writeLiveTerms', () => {
  it('round-trips and returns the readback', () => {
    const d = tmp();
    const r = writeLiveTerms(d, { ...DEFAULT_TERMS, codexReviewsPerPush: 2 });
    expect(r.ok).toBe(true); expect(r.terms.codexReviewsPerPush).toBe(2);
    expect(readLiveTerms(d)).toMatchObject({ source: 'file', terms: { codexReviewsPerPush: 2 } });
  });
  it('writes nothing for invalid terms', () => {
    const d = tmp();
    const r = writeLiveTerms(d, { ...DEFAULT_TERMS, forcePush: true });
    expect(r.ok).toBe(false); expect(r.errors.join(' ')).toContain('forcePush');
    expect(existsSync(termsPath(d))).toBe(false);
  });
});
