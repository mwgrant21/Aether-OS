// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TERMS } from './terms.mjs';
import { approvedPath, buildRecord, pointerPath, readApproved, recordHash, writeApproved } from './approval.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-appr-'));
const item = { id: 'a1b2c3d4e5f6', project: 'aether-os', kind: 'work', artifact: null, title: 't', source: { kind: 'handoff', file: 'h.md' } };
const fields = (over: Record<string, unknown> = {}) => ({
  nightId: 'n20261104T231509', approvedAtMs: 5, targetWindowStartMs: 9, standingTerms: DEFAULT_TERMS, amendments: {},
  terms: DEFAULT_TERMS, items: [item], held: [], allowRules: ['Bash(git status:*)'], ...over,
});
const stored = (d: string) => JSON.parse(readFileSync(approvedPath(d), 'utf8'));
// Rewrite approved.json after `fn` edits it; rehash recomputes recordSha256; repoint makes the pointer agree (a thorough tamperer).
const edit = (d: string, fn: (r: any) => void, o: { rehash?: boolean; repoint?: boolean } = {}) => {
  const j = stored(d); fn(j);
  if (o.rehash) j.recordSha256 = recordHash(j);
  writeFileSync(approvedPath(d), JSON.stringify(j));
  if (o.repoint) writeFileSync(pointerPath(d), JSON.stringify({ ...JSON.parse(readFileSync(pointerPath(d), 'utf8')), recordSha256: j.recordSha256 }));
};
const approved = () => { const d = tmp(); writeApproved(d, buildRecord(fields())); return d; };
describe('write and read', () => {
  it('round-trips, stamps version/via/hashes, and verifies', () => {
    const d = approved(); const r = readApproved(d);
    expect(r.ok && r.record).toMatchObject({ v: 1, via: 'tty', nightId: 'n20261104T231509', items: [item], allowRules: ['Bash(git status:*)'] });
    expect(r.ok && r.record.recordSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ok && r.record.recordSha256).toBe(recordHash(stored(d)));
  });
  it('a later approval replaces the earlier one (one approved slot)', () => {
    const d = approved(); writeApproved(d, buildRecord(fields({ nightId: 'n20261105T231509', approvedAtMs: 6 })));
    const r = readApproved(d); expect(r.ok && r.record.nightId).toBe('n20261105T231509');
  });
  it('refuses to build from invalid terms or a non-array allowRules', () => {
    expect(() => buildRecord(fields({ terms: { ...DEFAULT_TERMS, delete: true } }))).toThrow();
    expect(() => buildRecord(fields({ standingTerms: { ...DEFAULT_TERMS, forcePush: true } }))).toThrow();
    expect(() => buildRecord(fields({ allowRules: 'Bash(git status:*)' }))).toThrow();
  });
  it('missing and invalid JSON read as missing and invalid', () => {
    expect(readApproved(tmp())).toEqual({ ok: false, reason: 'missing' });
    const d = approved(); writeFileSync(approvedPath(d), '{oops');
    expect(readApproved(d)).toEqual({ ok: false, reason: 'invalid' });
  });
});
describe('tamper detection', () => {
  it.each([
    ['allowRules', (r: any) => r.allowRules.push('Bash(rm:*)')],
    ['items', (r: any) => { r.items = []; }],
    ['nightId', (r: any) => { r.nightId = 'n20991231T000000'; }],
    ['held', (r: any) => { r.held.push({ id: 'z', title: 'x', verdict: 'question', reason: 'question:needs-matt' }); }],
    ['approvedAtMs', (r: any) => { r.approvedAtMs += 1; }],
    ['targetWindowStartMs', (r: any) => { r.targetWindowStartMs += 1; }],
    ['standingTerms', (r: any) => { r.standingTerms.opusEscalation = true; }],
    ['amendments', (r: any) => { r.amendments.push = false; }],
    ['effective terms', (r: any) => { r.terms.push = false; }],
  ])('editing %s fails with hash-mismatch', (_n, fn) => {
    const d = approved(); edit(d, fn);
    expect(readApproved(d)).toEqual({ ok: false, reason: 'hash-mismatch' });
  });
  it('an editor who recomputes recordSha256 still fails against the pointer', () => {
    const d = approved(); edit(d, (r) => r.allowRules.push('Bash(rm:*)'), { rehash: true });
    expect(readApproved(d)).toEqual({ ok: false, reason: 'pointer-mismatch' });
  });
  it('an editor who also fixes the pointer but not termsSha256 fails with terms-invalid', () => {
    const d = approved(); edit(d, (r) => { r.terms.opusEscalation = true; }, { rehash: true, repoint: true });
    expect(readApproved(d)).toEqual({ ok: false, reason: 'terms-invalid' });
  });
  it('a missing pointer fails closed (the crash between the two writes)', () => {
    const d = approved(); rmSync(pointerPath(d));
    expect(readApproved(d)).toEqual({ ok: false, reason: 'pointer-missing' });
  });
});
