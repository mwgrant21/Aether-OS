// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { termsPath, writeLiveTerms } from './termsStore.mjs';
import { amendDraft, confirmItems, draftPath, readDraft } from './draft.mjs';
import { approvedPath, pointerPath, readApproved } from './approval.mjs';
import { buildAllowRules } from './denyRules.mjs';
import { approveNight, expectedPhrase } from './approveFlow.mjs';
import { resolveNightPlan, unfinishedSelection } from './resolvePlan.mjs';
import { A, B, DAY, NOW, WIN, ctxFor, draftWith, mkItem, okProbes, putPlan, tmp } from './draftFixture';
const HOME = tmp('afk-home');
const two = () => [mkItem(A, 'item a'), mkItem(B, 'item b')];
const approve = (d: string, terms = DEFAULT_TERMS, nowMs = NOW) => approveNight({ aetherDir: d, homeDir: HOME, probes: okProbes, nowMs, isTty: true, print: () => {},
  readLine: async () => expectedPhrase(termsSha256(terms)) });
const resolve = (d: string, nowMs: number, homeDir = HOME) => resolveNightPlan({ aetherDir: d, homeDir, probes: okProbes, nowMs });
const confirm = (d: string, ids: string[], home = HOME, nowMs = NOW) => confirmItems(d, ids, ctxFor(home), nowMs);
const ids = (xs: any[]) => xs.map((i) => i.id);
const ITEM_KEYS = ['artifact', 'id', 'kind', 'project', 'source', 'title'];
// A night approved yesterday on the defaults (its window start was WIN - DAY).
async function approvedYesterday(d: string, amend?: Record<string, unknown>) {
  draftWith(d, two(), NOW - DAY, { targetWindowStartMs: WIN - DAY }); confirm(d, [A], HOME, NOW - DAY);
  if (amend) amendDraft(d, amend, NOW - DAY);
  await approve(d, { ...DEFAULT_TERMS, ...amend } as any, NOW - DAY);
}
describe('resolveNightPlan: approved', () => {
  it('(a) compile, confirm, approve, compile again the same evening: the approved work still resolves as approved', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    draftWith(d, two(), NOW + 5000); confirm(d, [B]);                  // the re-compile, and a confirmation of its own
    const r = resolve(d, WIN);
    expect(r.kind).toBe('approved'); expect(ids(r.items)).toEqual([A]); expect(ids(r.held)).toEqual([B]);
    expect(r.targetWindowStartMs).toBe(WIN);
    expect(r.terms).toEqual(DEFAULT_TERMS); expect(r.allowRules).toEqual(buildAllowRules(DEFAULT_TERMS, r.items as any));
    expect(Object.keys(r.items[0]).sort()).toEqual(ITEM_KEYS);
  });
  it('(b) approve, then change the live window and compile: the approved record still resolves', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    writeLiveTerms(d, { ...DEFAULT_TERMS, window: { start: '00:00', end: '06:00' } });
    draftWith(d, two(), NOW + 5000, { targetWindowStartMs: new Date(2026, 10, 5, 0).getTime() });   // a compile under the new window
    const r = resolve(d, WIN);
    expect(r.kind).toBe('approved'); expect(ids(r.items)).toEqual([A]); expect(r.terms?.window.start).toBe('01:00');
  });
  it('a hand-edited draft cannot add work to an approved night', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    const j = JSON.parse(readFileSync(draftPath(d), 'utf8')); j.items[1].confirmed = true; writeFileSync(draftPath(d), JSON.stringify(j));
    expect(ids(resolve(d, WIN).items)).toEqual([A]);
  });
  it('(g) an approval record with edited allowRules returns none and names the hash', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    const j = JSON.parse(readFileSync(approvedPath(d), 'utf8')); j.allowRules.push('Bash(rm:*)'); writeFileSync(approvedPath(d), JSON.stringify(j));
    const r = resolve(d, WIN);
    expect(r).toMatchObject({ kind: 'none', items: [], allowRules: [], nightId: null, targetWindowStartMs: null }); expect(r.reason).toMatch(/hash-mismatch/);
  });
  it('(f) a crash between the record write and the pointer write reads as none, and retrying approve heals it', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    rmSync(pointerPath(d));                                            // the state a crash between the two writes leaves
    expect(resolve(d, WIN)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/pointer-missing/) });
    expect((await approve(d)).ok).toBe(true);
    expect(resolve(d, WIN)).toMatchObject({ kind: 'approved' });
  });
  it('a record more than 12h past its window start is not an approved night', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    expect(resolve(d, WIN + 12 * 3600e3 + 1).kind).toBe('none');
  });
});
describe('resolveNightPlan: window and torn files', () => {
  it('returns the window it is FOR: tonight\'s start before it opens and still at 09:00; the same plan twice; none after the grace', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    const before = resolve(d, NOW), early = resolve(d, WIN), late = resolve(d, WIN + 8 * 3600e3);   // 23:00, 01:00, 09:00
    expect(before.kind).toBe('approved'); expect(before.targetWindowStartMs).toBe(WIN); expect(before.targetWindowStartMs!).toBeGreaterThan(NOW);   // not yet open
    expect(late).toEqual(early);                                         // no started-state: the caller owns run-once, keyed on targetWindowStartMs
    expect(late.targetWindowStartMs).toBe(WIN);                          // windowFor(09:00) would be tomorrow's 01:00
    expect(late.nightId).toMatch(/^n\d{8}T\d{6}$/);
    expect(resolve(d, WIN + 12 * 3600e3 + 1)).toMatchObject({ kind: 'none', nightId: null, targetWindowStartMs: null });
  });
  it('(k) a torn draft: an approved night still resolves; an unfinished night and a first night do not', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    writeFileSync(draftPath(d), '{oops');
    const r = resolve(d, WIN);
    expect(r).toMatchObject({ kind: 'approved', targetWindowStartMs: WIN }); expect(ids(r.items)).toEqual([A]);
    const e = tmp('afk-resolve'); draftWith(e, two()); confirm(e, [A]); writeFileSync(draftPath(e), JSON.stringify({ v: 1 }));   // valid JSON, no items array
    expect(resolve(e, WIN)).toMatchObject({ kind: 'none', items: [], allowRules: [], nightId: null, targetWindowStartMs: null });
    const f = tmp('afk-resolve'); await approvedYesterday(f); writeFileSync(draftPath(f), '{oops');
    expect(resolve(f, WIN).kind).toBe('none');                           // control for the next line: the same setup with an intact draft is unfinished
    draftWith(f, two()); confirm(f, [A]);
    expect(resolve(f, WIN).kind).toBe('unfinished');
  });
});
describe('resolveNightPlan: unfinished', () => {
  it('(c) an unfinished night with an unconfirmed amendment runs only the confirmed items, on the stored standing terms', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d);
    writeLiveTerms(d, { ...DEFAULT_TERMS, opusEscalation: true });     // the live file was edited after that approval
    draftWith(d, two()); confirm(d, [A]); amendDraft(d, { push: false }, NOW);   // tonight: A confirmed, an amendment never approved
    const r = resolve(d, WIN);
    expect(r.kind).toBe('unfinished'); expect(r.terms).toEqual(DEFAULT_TERMS);   // not opus (live), not push:false (amendment)
    expect(r.targetWindowStartMs).toBe(WIN); expect(r.nightId).toMatch(/^n\d{8}T\d{6}$/);
    expect(ids(r.items)).toEqual([A]); expect(ids(r.held)).toEqual([B]);
    expect(r.allowRules).toEqual(buildAllowRules(DEFAULT_TERMS, r.items as any));
    expect(Object.keys(r.items[0]).sort()).toEqual(ITEM_KEYS);        // the draft's verdict/reasons/confirmed fields do not leak into an unfinished night's items
  });
  it('(d) a previous night approved with {opusEscalation:true}: the next unfinished night reads opus=false', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d, { opusEscalation: true });
    const rec = resolve(d, WIN - DAY); expect(rec.kind).toBe('approved'); expect(rec.terms?.opusEscalation).toBe(true);   // that night did run on opus
    draftWith(d, two()); confirm(d, [A]);
    const r = resolve(d, WIN);
    expect(r.kind).toBe('unfinished'); expect(r.terms?.opusEscalation).toBe(false);
  });
  it('the unfinished target follows the STANDING window: an unconfirmed window amendment does not move it or its 12h gate', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d); draftWith(d, two()); confirm(d, [A]);
    expect(amendDraft(d, { window: { start: '22:00', end: '06:00' } }, NOW).ok).toBe(true);   // never approved
    expect(JSON.parse(readFileSync(draftPath(d), 'utf8')).targetWindowStartMs).toBe(new Date(2026, 10, 4, 22).getTime());   // control: the draft's own target moved to 22:00
    const r = resolve(d, WIN);
    expect(r.kind).toBe('unfinished'); expect(r.terms?.window).toEqual({ start: '01:00', end: '07:00' });
    expect(r.targetWindowStartMs).toBe(WIN);                                                  // the standing 01:00, not the amended 22:00
    expect(resolve(d, new Date(2026, 10, 5, 11).getTime()).kind).toBe('unfinished');         // 11:00 is past 22:00+12h but inside 01:00+12h
  });
  it('the draft an approval was made from is never its own unfinished night, even when the approval amended the window', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]);
    expect(amendDraft(d, { window: { start: '22:00', end: '06:00' } }, NOW).ok).toBe(true);
    await approve(d, { ...DEFAULT_TERMS, window: { start: '22:00', end: '06:00' } } as any);   // approved at NOW: record target 22:00, gate 10:00 next day
    const at = new Date(2026, 10, 5, 9).getTime();
    expect(resolve(d, at)).toMatchObject({ kind: 'approved', targetWindowStartMs: new Date(2026, 10, 4, 22).getTime() });   // control: still inside the approved night's 12h gate
    expect(resolve(d, new Date(2026, 10, 5, 10, 30).getTime())).toMatchObject({ kind: 'none', items: [], targetWindowStartMs: null });   // lapsed; without the createdAtMs clause this is unfinished for target 01:00
  });
  it('(l) a corrupt live terms.json changes neither an approved nor an unfinished result (resolve never reads it)', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    const before = resolve(d, WIN); writeFileSync(termsPath(d), '{nope');
    expect(resolve(d, WIN)).toEqual(before); expect(before.kind).toBe('approved');
    const e = tmp('afk-resolve'); await approvedYesterday(e); draftWith(e, two()); confirm(e, [A]);
    const u = resolve(e, WIN); writeFileSync(termsPath(e), '{nope');
    expect(resolve(e, WIN)).toEqual(u); expect(u.kind).toBe('unfinished');
  });
  it('unfinishedSelection is the one computation: it returns exactly what an unfinished night resolves to', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d); draftWith(d, two()); confirm(d, [A]);
    const r = resolve(d, WIN); const a = readApproved(d);
    expect(r.kind).toBe('unfinished'); expect(a.ok).toBe(true);
    const s = unfinishedSelection({ draft: readDraft(d)!, record: (a as any).record, ctx: ctxFor(HOME) });
    expect({ terms: r.terms, termsSha256: r.termsSha256, items: r.items, held: r.held, allowRules: r.allowRules }).toEqual(s);
  });
  it('(e) the first-ever night, with no last-approved terms, returns none', () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]);
    expect(resolve(d, WIN)).toMatchObject({ kind: 'none', items: [], allowRules: [], nightId: null, targetWindowStartMs: null, reason: expect.stringMatching(/last-approved/) });
  });
  it('a confirmed plan item whose spec went back to draft is held, not run', async () => {
    const home = tmp('afk-home'); const plan = putPlan(home, 'approved');
    const d = tmp('afk-resolve'); await approvedYesterday(d);
    draftWith(d, [plan, mkItem(A, 'item a')]); confirm(d, [plan.id, A], home);
    putPlan(home, 'DRAFT');
    const r = resolve(d, WIN, home);
    expect(r.kind).toBe('unfinished'); expect(ids(r.items)).toEqual([A]);
    expect(r.held).toEqual([{ id: plan.id, title: plan.title, verdict: 'ready', reason: 'recheck:spec-not-approved' }]);
  });
  it('nothing confirmed, or a stale draft, resolves to none', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d); draftWith(d, two());
    expect(resolve(d, WIN).kind).toBe('none');
    confirm(d, [A]);
    expect(resolve(d, WIN + 12 * 3600e3 + 1).kind).toBe('none');
  });
  it('an empty directory is none, not an error', () => {
    expect(resolve(tmp('afk-resolve'), NOW)).toMatchObject({ kind: 'none', allowRules: [] });
  });
});
describe('resolveNightPlan: the catch-all reason', () => {
  it('a draft that makes the code throw yields "resolve failed:" with the error name only, never its message', () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); writeFileSync(draftPath(d), JSON.stringify({ items: [null] }));
    const r = resolve(d, NOW);
    expect(r).toMatchObject({ kind: 'none', items: [] });
    expect(r.reason).toMatch(/^resolve failed: TypeError$/); expect(r.reason).not.toMatch(/Cannot read|null|undefined/);
  });
  it('an fs-error-shaped throw keeps its code but leaves the absolute path out', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d);
    const err = Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\secret\\afk\\approved.json'"), { code: 'EACCES' });
    const r = resolveNightPlan({ aetherDir: d, homeDir: HOME, probes: okProbes, nowMs: { valueOf() { throw err; } } as any });
    expect(r.kind).toBe('none'); expect(r.reason).toBe('resolve failed: Error EACCES');
    expect(r.reason).not.toContain('secret');
  });
});
