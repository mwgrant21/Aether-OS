// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkPlan, compileNightList } from './compileNightList.mjs';
const NOW = new Date(2026, 10, 4, 23, 0).getTime();
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'afk-compile-'));
  const put = (rel: string, text: string, ageDays = 0) => {
    const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
    const t = new Date(NOW - ageDays * 864e5); utimesSync(p, t, t); return p;
  };
  return { home, put };
}
const HANDOFF = '# H\n\n## Next steps\n1. Run npm test and fix the failing starters test\n2. Ask Matt whether to push\n3. Delete .worktrees/old\n\n## Decisions\n- x\n';
const base = (home: string, extra = {}) => ({ homeDir: home, projects: ['aether-os'], nowMs: NOW, ...extra });
// JSON doubles backslashes, so a bare Windows path never matches inside JSON.stringify output: check every spelling.
const leaks = (obj: unknown, s: string) => [s, s.replace(/\\/g, '/'), JSON.stringify(s).slice(1, -1)].some((v) => JSON.stringify(obj).includes(v));
describe('compileNightList', () => {
  it('compiles the newest eligible handoff and ledger todos, with verdicts', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/2026-11-04-new-handoff.md', HANDOFF);
    put('.claude/handoffs/aether-os/2026-10-20-old-handoff.md', '## Next steps\n1. stale item\n', 10);
    put('.claude/handoffs/aether-os/verdict-x.md', '## Next steps\n1. should be ignored\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [todo] Build the APK for aethermobile\n- [done] finished\n');
    const l = compileNightList(base(home));
    const byTitle = Object.fromEntries(l.items.map((i) => [i.title, i]));
    expect(byTitle['Run npm test and fix the failing starters test'].verdict).toBe('ready');
    expect(byTitle['Ask Matt whether to push'].verdict).toBe('question');
    expect(byTitle['Delete .worktrees/old'].verdict).toBe('barred');
    expect(byTitle['Build the APK for aethermobile']).toMatchObject({ kind: 'build', artifact: 'apk' });
    expect(byTitle['Build the APK for aethermobile'].source.kind).toBe('ledger');
    expect(l.items.some((i) => i.title.includes('stale') || i.title.includes('ignored'))).toBe(false);
  });
  it('stores signal not payload: basename source, short title, stable distinct ids, unconfirmed', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. ' + 'x'.repeat(300) + '\n');
    const a = compileNightList(base(home)); const b = compileNightList(base(home));
    expect(a.items[0].title.length).toBe(140);
    expect(a.items[0].source.file).toBe('h.md');
    expect(leaks({ p: home }, home)).toBe(true);   // control: the matcher can fail, so the next line is not vacuous
    expect(leaks(a, home)).toBe(false);
    expect(a.items[0].id).toMatch(/^[0-9a-f]{12}$/); expect(a.items[0].id).toBe(b.items[0].id);
    expect(a.items[0]).toMatchObject({ confirmed: false, kind: 'work', artifact: null });
  });
  it('de-duplicates the same text from handoff and ledger', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [todo] Run npm test\n');
    expect(compileNightList(base(home)).items.length).toBe(1);
  });
  it('a handoff older than maxAgeDays is not compiled even when it is the only one', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/old.md', '## Next steps\n1. stale item\n', 10);
    const l = compileNightList(base(home));
    expect(l.items).toEqual([]); expect(l.warnings.join(' ')).toContain('aether-os');
    expect(compileNightList(base(home, { maxAgeDays: 30 })).items.map((i) => i.title)).toEqual(['stale item']);
  });
  it('tags build items, makes a two-artifact item a question, and does not treat "setup" as a build', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Build the APK\n2. Ship the apk and the installer\n3. Prepare setup fixtures\n');
    const [apk, both, setup] = compileNightList(base(home)).items;
    expect(apk).toMatchObject({ kind: 'build', artifact: 'apk', verdict: 'ready' });
    expect(both).toMatchObject({ artifact: null, verdict: 'question' }); expect(both.reasons).toContain('question:two-artifacts');
    expect(setup).toMatchObject({ kind: 'work', artifact: null });
  });
  it('heading "(all need Matt)" and ledger pending make questions', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps (all need Matt)\n1. Run npm test\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [pending Matt] restart collector\n');
    const l = compileNightList(base(home));
    expect(l.items.every((i) => i.verdict === 'question')).toBe(true);
    expect(l.items.every((i) => i.reasons.includes('question:needs-matt'))).toBe(true);
  });
  it('plan reference: approved spec stays ready, unapproved or missing plan is a question', () => {
    const { home, put } = fixture();
    put('projects/aether-os/docs/superpowers/plans/p-ok.md', '# P\n**Spec:** `docs/superpowers/specs/ok.md`\n- [ ] unchecked step\n');
    put('projects/aether-os/docs/superpowers/specs/ok.md', '# S\nStatus: approved\n');
    put('projects/aether-os/docs/superpowers/plans/p-draft.md', '# P\n**Spec:** `docs/superpowers/specs/draft.md`\n');
    put('projects/aether-os/docs/superpowers/specs/draft.md', '# S\nStatus: DRAFT\n');
    put('.claude/handoffs/aether-os/h.md',
      '## Next steps\n1. Execute docs/superpowers/plans/p-ok.md\n2. Execute docs/superpowers/plans/p-draft.md\n3. Execute docs/superpowers/plans/gone.md\n');
    const l = compileNightList(base(home)); const [ok, draft, gone] = l.items;
    expect(leaks(l, home)).toBe(false);   // the plan-not-found warning must not carry the home path either
    expect(ok).toMatchObject({ verdict: 'ready', planRef: { file: 'p-ok.md', specApproved: true } });
    expect(draft.reasons).toContain('question:spec-not-approved');
    expect(gone.reasons).toContain('question:plan-not-found');
  });
  it('unchecked plan boxes alone put nothing on the list', () => {
    const { home, put } = fixture();
    put('projects/aether-os/docs/superpowers/plans/shipped.md', '**Spec:** `s.md`\n' + '- [ ] step\n'.repeat(50));
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    expect(compileNightList(base(home)).items.map((i) => i.title)).toEqual(['Run npm test']);
  });
  it('a plan named by Matt becomes its own item', () => {
    const { home, put } = fixture();
    const plan = put('projects/aether-os/docs/superpowers/plans/named.md', '**Spec:** `docs/superpowers/specs/n.md`\n');
    put('projects/aether-os/docs/superpowers/specs/n.md', 'Status: approved\n');
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    const l = compileNightList(base(home, { plans: [plan] }));
    expect(l.items.find((i) => i.kind === 'plan')).toMatchObject({ title: 'Execute plan named.md', verdict: 'ready' });
  });
  it('targets the window it is given, not the 01:00 default', () => {
    const { home } = fixture();
    const l = compileNightList(base(home, { window: { start: '22:00', end: '06:00' } }));
    expect(l.targetWindowStartMs).toBe(new Date(2026, 10, 4, 22, 0).getTime());   // NOW is 23:00, inside that window
  });
  it('a project with no handoff folder warns instead of throwing; target window is the next 01:00', () => {
    const { home } = fixture();
    const l = compileNightList(base(home));
    expect(l.items).toEqual([]); expect(l.warnings.join(' ')).toContain('aether-os');
    expect(l.targetWindowStartMs).toBe(new Date(2026, 10, 5, 1, 0).getTime());
  });
  it('a barred item stays barred under a needs-Matt heading or a missing plan', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps (all need Matt)\n1. Delete .worktrees/old\n2. Delete docs/superpowers/plans/gone.md\n');
    const l = compileNightList(base(home));
    expect(l.items.every((i) => i.verdict === 'barred')).toBe(true);
    expect(l.items.every((i) => !i.reasons.some((r) => r.startsWith('question:')))).toBe(true);
  });
  it('a named plan whose spec is not approved, or that is missing, is a question', () => {
    const { home, put } = fixture();
    const draft = put('projects/aether-os/docs/superpowers/plans/d.md', '**Spec:** `docs/superpowers/specs/d.md`\n');
    put('projects/aether-os/docs/superpowers/specs/d.md', 'Status: draft\n');
    const l = compileNightList(base(home, { plans: [draft, join(home, 'projects', 'aether-os', 'docs', 'superpowers', 'plans', 'nope.md')] }));
    const [d, nope] = l.items;
    expect(d).toMatchObject({ kind: 'plan', verdict: 'question', reasons: ['question:spec-not-approved'] });
    expect(nope.reasons).toEqual(['question:plan-not-found']);
    expect(leaks(l, home)).toBe(false);
  });
  it('a named plan with a barred file name stays barred even with an approved spec', () => {
    const { home, put } = fixture();
    const plan = put('projects/aether-os/docs/superpowers/plans/cleanup-old-worktrees.md', '**Spec:** `docs/superpowers/specs/c.md`\n');
    put('projects/aether-os/docs/superpowers/specs/c.md', 'Status: approved\n');
    const it = compileNightList(base(home, { plans: [plan] })).items[0];
    expect(it).toMatchObject({ kind: 'plan', verdict: 'barred' });
    expect(it.reasons.length).toBeGreaterThan(0);
    expect(it.reasons.every((r: string) => r.startsWith('barred:'))).toBe(true);
  });
  it('a barred named plan that is missing stays barred and still warns', () => {
    const { home } = fixture();
    const plan = join(home, 'projects', 'aether-os', 'docs', 'superpowers', 'plans', 'delete-old-branches.md');
    const l = compileNightList(base(home, { plans: [plan] }));
    expect(l.items[0].verdict).toBe('barred');
    expect(l.items[0].reasons.some((r: string) => r.startsWith('question:'))).toBe(false);
    expect(l.warnings.join(' ')).toContain('delete-old-branches.md');
  });
  it('a benign named plan with an approved spec is ready with no reasons', () => {
    const { home, put } = fixture();
    const plan = put('projects/aether-os/docs/superpowers/plans/dashboards.md', '**Spec:** `docs/superpowers/specs/d.md`\n');
    put('projects/aether-os/docs/superpowers/specs/d.md', 'Status: approved\n');
    expect(compileNightList(base(home, { plans: [plan] })).items[0]).toMatchObject({ verdict: 'ready', reasons: [] });
  });
  it('an undefined repoRoots entry falls back to the default root instead of throwing', () => {
    const { home, put } = fixture();
    put('projects/aether-os/docs/superpowers/plans/u.md', '**Spec:** `s.md`\n');
    expect(checkPlan({ homeDir: home, repoRoots: { 'aether-os': undefined }, project: 'aether-os', file: 'u.md' }).found).toBe(true);
  });
  it('an explicit handoff path is compiled regardless of age, and repoRoots overrides the plan root', () => {
    const { home, put } = fixture();
    const h = put('.claude/handoffs/aether-os/pinned.md', '## Next steps\n1. Execute plans/r.md\n', 30);
    put('elsewhere/docs/superpowers/plans/r.md', '**Spec:** `docs/superpowers/specs/r.md`\n');
    put('elsewhere/docs/superpowers/specs/r.md', 'Status: approved\n');
    const l = compileNightList(base(home, { handoffs: [h], repoRoots: { 'aether-os': join(home, 'elsewhere') } }));
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ verdict: 'ready', planRef: { file: 'r.md', specApproved: true } });
  });
});
describe('compileNightList review fixes', () => {
  it('a duplicate keeps the most restrictive verdict in either encounter order', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Restart collector\n2. Run npm test\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [pending Matt] Restart collector\n');
    const a = compileNightList(base(home)).items.find((i) => i.title === 'Restart collector')!;
    expect(a.verdict).toBe('question'); expect(a.reasons).toContain('question:needs-matt');
    const f2 = fixture();
    f2.put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    f2.put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [todo] Run npm test\n');
    const pinned = f2.put('pinned/aether-os/p.md', '## Next steps (needs Matt approval)\n1. Run npm test\n');
    const b = compileNightList(base(f2.home, { handoffs: [pinned] })).items;
    expect(b).toHaveLength(1); expect(b[0]).toMatchObject({ verdict: 'question' });
  });
  it('heading "(needs Matt approval)" makes every item a question', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps (needs Matt approval)\n1. Run npm test\n');
    expect(compileNightList(base(home)).items[0]).toMatchObject({ verdict: 'question', reasons: ['question:needs-matt'] });
  });
  it('an explicit plan under a repoRoots override is owned by that project', () => {
    const { home, put } = fixture();
    const plan = put('custom-root/docs/superpowers/plans/x.md', '**Spec:** `docs/superpowers/specs/x.md`\n');
    put('custom-root/docs/superpowers/specs/x.md', 'Status: approved\n');
    const l = compileNightList({ homeDir: home, projects: ['aether-os', 'TarotApp'], nowMs: NOW, plans: [plan], repoRoots: { TarotApp: join(home, 'custom-root') } });
    expect(l.items[0]).toMatchObject({ project: 'TarotApp', kind: 'plan', verdict: 'ready' });
  });
});
describe('checkPlan', () => {
  it('reports found and specApproved, and refuses a spec path that escapes the repo root', () => {
    const { home, put } = fixture();
    put('projects/p/docs/superpowers/plans/a.md', '**Spec:** `docs/superpowers/specs/a.md`\n');
    put('projects/p/docs/superpowers/specs/a.md', 'Status: approved\n');
    put('projects/p/docs/superpowers/plans/esc.md', '**Spec:** `../../outside.md`\n');
    put('outside.md', 'Status: approved\n');
    expect(checkPlan({ homeDir: home, repoRoots: {}, project: 'p', file: 'a.md' })).toEqual({ found: true, specApproved: true });
    expect(checkPlan({ homeDir: home, repoRoots: {}, project: 'p', file: 'esc.md' })).toEqual({ found: true, specApproved: false });
    expect(checkPlan({ homeDir: home, repoRoots: undefined, project: 'p', file: 'zz.md' })).toEqual({ found: false, specApproved: false });
  });
});
