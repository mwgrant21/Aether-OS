// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { amendDraft, confirmItems, draftPath, readDraft, recheckItem } from './draft.mjs';
import { A, B, C, DAY, NOW, WIN, ctxFor, draftWith, mkItem, okProbes, putPlan, tmp } from './draftFixture';
const noKeys = { ...okProbes, propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, false])) };
describe('replaceDraft', () => {
  it('writes the one draft with a fresh label, every item unconfirmed', () => {
    const d = tmp(); const dr = draftWith(d, [mkItem(A, 'Run npm test', 'ready', { confirmed: true })]);
    expect(dr.draftId).toMatch(/^n\d{8}T\d{6}$/); expect(dr.items[0].confirmed).toBe(false);
    expect(readDraft(d)).toEqual(dr); expect(readdirSync(dirname(draftPath(d)))).toEqual(['draft.json']);
  });
  it('a second compile REPLACES the draft: confirmations and amendments are gone, even for an id whose verdict changed', () => {
    const d = tmp(); draftWith(d, [mkItem(A, 'x'), mkItem(B, 'y')]);
    confirmItems(d, [A, B], ctxFor(tmp()), NOW); amendDraft(d, { opusEscalation: true }, NOW);
    draftWith(d, [mkItem(A, 'x', 'question'), mkItem(C, 'z')], NOW + 1000);   // A's verdict changed; B vanished
    const dr = readDraft(d)!;
    expect(dr.items.map((i: any) => [i.id.slice(0, 1), i.verdict, i.confirmed])).toEqual([['a', 'question', false], ['c', 'ready', false]]);
    expect(dr.amendments).toEqual({});
  });
  it('readDraft is null for a torn or malformed draft file and for no file', () => {
    const d = tmp(); draftWith(d, [mkItem(A, 'x')]);
    writeFileSync(draftPath(d), '{oops'); expect(readDraft(d)).toBeNull();
    writeFileSync(draftPath(d), JSON.stringify({ v: 1, draftId: 'n20261104T230000' })); expect(readDraft(d)).toBeNull();   // valid JSON, no items array
    expect(readDraft(tmp())).toBeNull();
  });
});
describe('confirmItems', () => {
  it('confirms a ready item and refuses unknown, question and barred ones with their reasons', () => {
    const d = tmp(); const [x, y, z] = [A, B, C];
    draftWith(d, [mkItem(x, 'Run npm test'), mkItem(y, 'Ask?', 'question'), mkItem(z, 'Delete x', 'barred')]);
    const r = confirmItems(d, [x, y, z, 'f'.repeat(12)], ctxFor(tmp()), NOW);
    expect(r.confirmed).toEqual([x]);
    expect(Object.fromEntries(r.refused.map((q) => [q.id.slice(0, 1), q.reason]))).toEqual({ b: 'not-ready:question', c: 'not-ready:barred', f: 'unknown' });
    expect(readDraft(d)!.items.map((i: any) => i.confirmed)).toEqual([true, false, false]);
  });
  it('a build item is confirmed only while its feasibility check passes now', () => {
    const d = tmp(); draftWith(d, [mkItem(A, 'Build the APK', 'ready', { kind: 'build', artifact: 'apk' })]);
    expect(confirmItems(d, [A], ctxFor(tmp(), noKeys), NOW).refused).toEqual([{ id: A, reason: 'feasibility' }]);
    expect(confirmItems(d, [A], ctxFor(tmp()), NOW).confirmed).toEqual([A]);
  });
  it('refuses everything when there is no draft', () => {
    expect(confirmItems(tmp(), [A], ctxFor(tmp()), NOW)).toEqual({ confirmed: [], refused: [{ id: A, reason: 'no-draft' }] });
  });
  it('refuses a stale draft (its window passed more than 12h ago) with stale-draft and writes nothing', () => {
    const d = tmp(); draftWith(d, [mkItem(A, 'Run npm test')]);
    expect(confirmItems(d, [A], ctxFor(tmp()), WIN + 12 * 3600e3 + 1)).toEqual({ confirmed: [], refused: [{ id: A, reason: 'stale-draft' }] });
    expect(readDraft(d)!.items[0].confirmed).toBe(false);
    expect(confirmItems(d, [A], ctxFor(tmp()), WIN + 12 * 3600e3).confirmed).toEqual([A]);   // control: exactly at the 12h edge it is still current
  });
});
describe('recheckItem', () => {
  it('a plan item passes while its spec is approved and fails once the spec goes back to draft', () => {
    const home = tmp(); const item = putPlan(home, 'approved');
    expect(recheckItem(item, ctxFor(home))).toEqual({ ok: true, reason: null });
    putPlan(home, 'DRAFT');
    expect(recheckItem(item, ctxFor(home))).toEqual({ ok: false, reason: 'spec-not-approved' });
  });
  it('a plan that vanished fails with plan-not-found', () => {
    expect(recheckItem(putPlan(tmp(), 'approved'), ctxFor(tmp()))).toEqual({ ok: false, reason: 'plan-not-found' });   // item from one home, checked against an empty one
  });
  it('an item stored as non-ready fails with not-ready', () => {
    expect(recheckItem(mkItem(A, 'Ask?', 'question'), ctxFor(tmp()))).toEqual({ ok: false, reason: 'not-ready:question' });
  });
});
describe('amendDraft', () => {
  it('stores a valid amendment and leaves the target window alone', () => {
    const d = tmp(); draftWith(d, []);
    expect(amendDraft(d, { opusEscalation: true }, NOW).ok).toBe(true);
    expect(readDraft(d)).toMatchObject({ amendments: { opusEscalation: true }, targetWindowStartMs: WIN });
  });
  it('amending the window recomputes the draft\'s target window', () => {
    const d = tmp(); draftWith(d, []);
    expect(amendDraft(d, { window: { start: '22:00', end: '06:00' } }, NOW).ok).toBe(true);
    expect(readDraft(d)!.targetWindowStartMs).toBe(new Date(2026, 10, 4, 22).getTime());   // NOW (23:00) is inside it
  });
  it('a later unrelated amendment does not recompute the target window', () => {
    const d = tmp(); draftWith(d, []);
    amendDraft(d, { window: { start: '22:00', end: '06:00' } }, NOW);
    const target = new Date(2026, 10, 4, 22).getTime();
    expect(readDraft(d)!.targetWindowStartMs).toBe(target);
    expect(amendDraft(d, { push: false }, new Date(2026, 10, 5, 7).getTime()).ok).toBe(true);   // inside the 12h grace
    expect(readDraft(d)).toMatchObject({ amendments: { push: false }, targetWindowStartMs: target });
  });
  it('rejects delete and an incoherent merge, keeping the stored amendments', () => {
    const d = tmp(); draftWith(d, []);
    expect(amendDraft(d, { delete: true }, NOW).ok).toBe(false);
    expect(amendDraft(d, { fableElevation: true }, NOW).ok).toBe(false);
    expect(readDraft(d)!.amendments).toEqual({});
  });
  it('without a draft it says so', () => { expect(amendDraft(tmp(), { push: false }, NOW)).toEqual({ ok: false, errors: ['no draft'] }); });
  it('refuses a stale draft, even for a window patch that would revive it, and writes nothing', () => {
    const d = tmp(); draftWith(d, []);
    const later = NOW + 2 * DAY;
    expect(amendDraft(d, { window: { start: '22:00', end: '06:00' } }, later)).toEqual({ ok: false, errors: ['stale-draft'] });
    expect(readDraft(d)).toMatchObject({ amendments: {}, targetWindowStartMs: WIN });
    expect(amendDraft(d, { opusEscalation: true }, WIN + 12 * 3600e3).ok).toBe(true);   // control: at the 12h edge it is still current
  });
});
