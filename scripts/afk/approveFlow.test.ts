// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { termsPath, writeLiveTerms } from './termsStore.mjs';
import { amendDraft, confirmItems } from './draft.mjs';
import { approvedPath, pointerPath, readApproved } from './approval.mjs';
import { buildAllowRules } from './denyRules.mjs';
import { approveNight, expectedPhrase } from './approveFlow.mjs';
import { A, B, DAY, NOW, WIN, ctxFor, draftWith, mkItem, okProbes, putPlan, tmp } from './draftFixture';
const HOME = tmp('afk-home');   // no plans under it, so plain items never touch a plan file
const phrase = (terms = DEFAULT_TERMS) => expectedPhrase(termsSha256(terms));
const apk = (id: string, verdict = 'ready') => mkItem(id, 'Build the APK', verdict, { kind: 'build', artifact: 'apk' });
const exe = (id: string) => mkItem(id, 'Cut a new installer', 'ready', { kind: 'build', artifact: 'installer' });
function setup(items = [mkItem(A, 'Run npm test'), mkItem(B, 'Ask Matt?', 'question')], confirm = [A]) {
  const d = tmp('afk-approve'); draftWith(d, items); confirmItems(d, confirm, ctxFor(HOME), NOW); return d;
}
const run = (d: string, over: Record<string, unknown> = {}) => {
  const printed: string[] = []; let asked = 0;
  const p = approveNight({ aetherDir: d, homeDir: HOME, probes: okProbes, nowMs: NOW, isTty: true, print: (s: string) => printed.push(s),
    readLine: async () => { asked++; return phrase(); }, ...over } as any);
  return { p, text: () => printed.join('\n'), printed, asked: () => asked };
};
describe('approveNight gates', () => {
  it('without a TTY refuses, prints nothing, asks nothing, writes nothing', async () => {
    const d = setup(); const r = run(d, { isTty: false });
    expect(await r.p).toMatchObject({ ok: false, code: 'not-tty' });
    expect(r.printed).toEqual([]); expect(r.asked()).toBe(0); expect(existsSync(approvedPath(d))).toBe(false);
  });
  it('the not-tty message points at a plain PowerShell window and never suggests the ! escape', async () => {
    const r = await run(setup(), { isTty: false }).p as any;
    expect(r.message).toMatch(/PowerShell/); expect(r.message).not.toContain('!');
  });
  it('with no draft, or nothing confirmed, it refuses and writes nothing', async () => {
    expect(await run(tmp('afk-approve')).p).toMatchObject({ ok: false, code: 'no-draft' });
    const d = setup(undefined, []);
    expect(await run(d).p).toMatchObject({ ok: false, code: 'no-confirmed-items' });
    expect(existsSync(approvedPath(d))).toBe(false);
  });
  it('a draft compiled 3 days earlier is refused as stale-draft, naming the window; nothing is asked or written', async () => {
    const d = tmp('afk-approve'); draftWith(d, [mkItem(A, 'Run npm test')], NOW - 3 * DAY, { targetWindowStartMs: WIN - 3 * DAY });
    confirmItems(d, [A], ctxFor(HOME), NOW - 3 * DAY);   // confirmed on the draft's own evening, so the stale draft carries a confirmation
    const r = run(d);
    expect(await r.p).toMatchObject({ ok: false, code: 'stale-draft' }); expect((await r.p as any).message).toMatch(/compile/);
    expect(r.asked()).toBe(0); expect(existsSync(approvedPath(d))).toBe(false); expect(existsSync(pointerPath(d))).toBe(false);
    const ok = run(setup()); expect((await ok.p).ok).toBe(true);                          // control: a draft for tonight's window approves, and its summary names that window
    expect(ok.text()).toMatch(/runs in the window starting 2026-11-05 01:00/);
  });
  it('a wrong phrase writes nothing', async () => {
    const d = setup();
    expect(await run(d, { readLine: async () => 'yes' }).p).toMatchObject({ ok: false, code: 'phrase-mismatch' });
    expect(existsSync(approvedPath(d))).toBe(false); expect(existsSync(pointerPath(d))).toBe(false);
  });
  it('the phrase is compared after trim, and only the exact phrase passes', async () => {
    const d = setup();
    expect(await run(d, { readLine: async () => `  ${phrase()}  ` }).p).toMatchObject({ ok: true });
    expect(await run(d, { readLine: async () => phrase().toLowerCase() }).p).toMatchObject({ ok: false, code: 'phrase-mismatch' });
  });
});
describe('approveNight record', () => {
  it('writes a verifying record: confirmed items only, the rest held, standing terms = the live file', async () => {
    const d = setup(); const r = run(d);
    expect((await r.p).ok).toBe(true);
    const rec = readApproved(d);
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.record.items.map((i: any) => i.id)).toEqual([A]);
    expect(rec.record.held).toEqual([{ id: B, title: 'Ask Matt?', verdict: 'question', reason: 'question:marker' }]);
    expect(rec.record.standingTerms).toEqual(DEFAULT_TERMS); expect(rec.record.terms).toEqual(DEFAULT_TERMS);
    expect(rec.record.targetWindowStartMs).toBe(new Date(2026, 10, 5, 1).getTime());
    expect(rec.record.allowRules).toEqual(buildAllowRules(DEFAULT_TERMS, rec.record.items));   // the list stored is the list computed...
    for (const x of rec.record.allowRules) expect(r.text()).toContain(x);                        // ...and the list printed
    expect(r.text()).toContain('Run npm test'); expect(r.text()).toContain('delete: NOT ALLOWED');
  });
  it('the allowlist comes from CONFIRMED items only: a held question APK item adds nothing, a confirmed installer adds npm run dist', async () => {
    const d = setup([apk(A, 'question'), exe(B)], [B]); const r = run(d);
    expect((await r.p).ok).toBe(true);
    const rules = (readApproved(d) as any).record.allowRules as string[];
    expect(rules).toContain('Bash(npm run dist:*)');
    expect(rules.join(' ')).not.toContain('gradlew.bat'); expect(r.text()).not.toContain('gradlew.bat');
  });
  it('prints both limits beside the allowlist and no longer claims force-push is not allowed', async () => {
    const r = run(setup()); await r.p;
    expect(r.text()).toMatch(/\+refspec/); expect(r.text()).toMatch(/origin main --force/); expect(r.text()).toMatch(/HEAD:master/);
    expect(r.text()).toContain('Bash(git push origin HEAD:master:*)'); expect(r.text()).toContain('Edit(~/.aether-os/afk/**)');   // both deny groups are printed
    expect(r.text()).toMatch(/no Edit\/Write\/test rules/); expect(r.text()).toMatch(/yellow/);
    expect(r.text()).not.toContain('force-push: NOT ALLOWED');
  });
  it('a one-night amendment lands in terms but not in standingTerms or the live file', async () => {
    const d = setup(); writeLiveTerms(d, DEFAULT_TERMS);
    const before = readFileSync(termsPath(d), 'utf8');
    amendDraft(d, { opusEscalation: true }, NOW);
    const amended = { ...DEFAULT_TERMS, opusEscalation: true };
    const r = run(d, { readLine: async () => phrase(amended) });
    expect((await r.p).ok).toBe(true);
    expect(r.text()).toMatch(/tonight only/); expect(r.text()).toMatch(/standing terms/);        // the printed amendments block says what an amendment is
    const rec = (readApproved(d) as any).record;
    expect(rec.terms.opusEscalation).toBe(true); expect(rec.standingTerms.opusEscalation).toBe(false);
    expect(rec.amendments).toEqual({ opusEscalation: true });
    expect(readFileSync(termsPath(d), 'utf8')).toBe(before);
  });
  it('corrupt live terms refuse the approval: nothing is printed, asked or written', async () => {
    const d = setup(); mkdirSync(dirname(termsPath(d)), { recursive: true }); writeFileSync(termsPath(d), '{nope');
    const r = run(d);
    expect(await r.p).toMatchObject({ ok: false, code: 'terms-invalid' });
    expect(r.printed).toEqual([]); expect(r.asked()).toBe(0); expect(existsSync(approvedPath(d))).toBe(false);
    writeLiveTerms(d, DEFAULT_TERMS);                                                         // control: `terms set` rewrites a valid file and approval works again
    expect((await run(d).p).ok).toBe(true);
  });
  it('approving again replaces the record and says so', async () => {
    const d = setup(); await run(d).p;
    const second = run(d); expect((await second.p).ok).toBe(true);
    expect(second.text()).toMatch(/replaces approval n\d{8}T\d{6}/);
  });
});
describe('approveNight re-check', () => {
  it('(h) a confirmed item whose spec went back to draft is refused, and the earlier approval is untouched', async () => {
    const home = tmp('afk-home'); const plan = putPlan(home, 'approved');
    const d = tmp('afk-approve'); draftWith(d, [plan, mkItem(A, 'Run npm test')]); confirmItems(d, [plan.id, A], ctxFor(home), NOW);
    expect((await run(d, { homeDir: home }).p).ok).toBe(true);                          // control: the same draft approves while the spec is approved
    const hash = (readApproved(d) as any).record.recordSha256;
    putPlan(home, 'DRAFT');                                                              // the spec goes back to draft after the confirmation
    const r = await run(d, { homeDir: home }).p;
    expect(r).toMatchObject({ ok: false, code: 'recheck-failed' }); expect((r as any).message).toContain('spec-not-approved');
    expect((readApproved(d) as any).record.recordSha256).toBe(hash);
  });
  it('a confirmed build item whose probes now fail is refused', async () => {
    const d = setup([apk(A)], [A]);
    const noKeys = { ...okProbes, propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, false])) };
    expect(await run(d, { probes: noKeys }).p).toMatchObject({ ok: false, code: 'recheck-failed' });
    expect(existsSync(approvedPath(d))).toBe(false);
  });
  it('every confirmed item is re-checked, not just the first: a later one that now fails refuses the approval', async () => {
    const d = setup([mkItem(A, 'Run npm test'), apk(B)], [A, B]);
    const noKeys = { ...okProbes, propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, false])) };
    const r = await run(d, { probes: noKeys }).p as any;
    expect(r).toMatchObject({ ok: false, code: 'recheck-failed' }); expect(r.message).toContain(B); expect(r.message).not.toContain(A);
  });
  it('a terms file that parses but is invalid (unknown key) refuses as terms-invalid and points at terms set', async () => {
    const d = setup(); mkdirSync(dirname(termsPath(d)), { recursive: true }); writeFileSync(termsPath(d), JSON.stringify({ ...DEFAULT_TERMS, extra: 1 }));
    const r = await run(d).p as any;
    expect(r).toMatchObject({ ok: false, code: 'terms-invalid' }); expect(r.message).toMatch(/terms set/);
  });
});
