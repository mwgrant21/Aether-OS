// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TTY_VERBS, VERBS, isInteractive, main } from './cli.mjs';
import { readLiveTerms, termsPath, writeLiveTerms } from './termsStore.mjs';
import { readDraft } from './draft.mjs';
import { buildAllowRules } from './denyRules.mjs';
import { DEFAULT_TERMS } from './terms.mjs';
import { okProbes } from './draftFixture';
const entry = fileURLToPath(new URL('./afk.mjs', import.meta.url));
const tmpHome = () => mkdtempSync(join(tmpdir(), 'afk-cli-'));
const run = (home: string, args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', input: '', env: { ...process.env, HOME: home, USERPROFILE: home } });
const aether = (home: string) => join(home, '.aether-os');
const T0 = new Date(2026, 10, 4, 23).getTime();   // the pinned evening of the in-process tests
const DAY = 864e5;
// Handoff eligibility is judged against nowMs by file mtime, so a test with a pinned clock stamps the file with that clock;
// spawned tests run on the real clock and take the default.
const putHandoff = (home: string, atMs = Date.now(), project = 'p', steps = '1. Run npm test\n') => {
  const d = join(home, '.claude', 'handoffs', project); mkdirSync(d, { recursive: true });
  const f = join(d, 'h.md'); writeFileSync(f, `## Next steps\n${steps}`); utimesSync(f, new Date(atMs), new Date(atMs));
};
describe('TTY gate (spawned, piped stdio)', () => {
  // A spawned child has BOTH stdio ends piped, so it cannot tell `stdin && stdout` from `stdin || stdout`; the predicate test below pins the AND.
  it('isInteractive needs both ends to be a TTY', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractive({}, {})).toBe(false); expect(isInteractive(undefined as any, undefined as any)).toBe(false);
  });
  it.each([
    [['terms', 'set', 'opusEscalation', 'true']],
    [['amend', 'opusEscalation', 'true']],
    [['confirm', '--all-ready']],
    [['approve']],
  ])('%j exits 3 and writes nothing', (args) => {
    const home = tmpHome(); const r = run(home, args);
    expect(r.status).toBe(3);
    expect(existsSync(aether(home))).toBe(false);
  });
});
describe('read verbs (spawned)', () => {
  it('terms show prints defaults and the hash; delete is shown as not allowed', () => {
    const r = run(tmpHome(), ['terms', 'show']);
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/[0-9a-f]{64}/); expect(r.stdout).toContain('delete: NOT ALLOWED');
  });
  it('plan with nothing on disk is none', () => {
    const r = run(tmpHome(), ['plan', '--json']);
    expect(r.status).toBe(0); expect(JSON.parse(r.stdout).kind).toBe('none');
  });
  it('deny-rules prints a JSON object with the protect and run groups', () => {
    const o = JSON.parse(run(tmpHome(), ['deny-rules']).stdout);
    expect(o.protect).toContain('Edit(~/.aether-os/afk/**)'); expect(o.protect).not.toContain('Bash(rm:*)'); expect(o.run).toContain('Bash(rm:*)');
  });
  it('a corrupt terms file is surfaced by terms show and deny-rules, and deny-rules keeps stdout parseable JSON', () => {
    const home = tmpHome(); mkdirSync(join(aether(home), 'afk'), { recursive: true }); writeFileSync(termsPath(aether(home)), '{nope');
    expect(run(home, ['terms', 'show']).stdout).toMatch(/WARNING live terms/);
    const r = run(home, ['deny-rules']);
    expect(r.stderr).toMatch(/WARNING live terms/); expect(JSON.parse(r.stdout).run).toContain('Bash(rm:*)');
  });
  it('unknown verb exits 2', () => { expect(run(tmpHome(), ['frobnicate']).status).toBe(2); });
  it('compile writes the one draft under ~/.aether-os/afk', () => {
    const home = tmpHome(); putHandoff(home);
    const r = run(home, ['compile', '--project', 'p', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.draftId).toMatch(/^n\d{8}T\d{6}$/); expect(out.items[0].title).toBe('Run npm test');
    expect(readDraft(aether(home))?.draftId).toBe(out.draftId);
  });
});
describe('main() with a TTY (in process)', () => {
  // readLine answers the "Type exactly: <phrase>" prompt with the phrase it was shown (the gate itself is tested in approveFlow.test.ts)
  const deps = (home: string, out: string[] = [], nowMs = T0) => ({ homeDir: home, nowMs, isTty: true, readLine: async (q: string) => q.split(': ').pop()!.trim(), print: (s: string) => { out.push(s); }, printErr: (s: string) => { out.push(s); }, env: {} });
  it('terms set writes through the store', async () => {
    const home = tmpHome();
    expect(await main(['terms', 'set', 'codexReviewsPerPush', '2'], deps(home))).toBe(0);
    expect(readLiveTerms(aether(home)).terms.codexReviewsPerPush).toBe(2);
  });
  it.each([['delete', 'true'], ['forcePush', 'true'], ['notifications', 'toast']])('terms set %s %s is refused (exit 4)', async (k, v) => {
    const home = tmpHome(); const out: string[] = [];
    expect(await main(['terms', 'set', k, v], deps(home, out))).toBe(4);
    expect(existsSync(termsPath(aether(home)))).toBe(false); expect(out.join(' ')).toMatch(/barred/);   // refused by name, not by the validator's fallback
  });
  it.each([['delete', 'true'], ['forcePush', 'true']])('amend %s %s is refused (exit 4)', async (k, v) => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home));
    const before = readFileSync(join(aether(home), 'afk', 'draft.json'), 'utf8');
    expect(await main(['amend', k, v], deps(home))).toBe(4);
    expect(readFileSync(join(aether(home), 'afk', 'draft.json'), 'utf8')).toBe(before);
  });
  it('compile targets the live terms window, not the 01:00 default', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    expect(await main(['terms', 'set', 'window.start', '22:00'], deps(home))).toBe(0);
    expect(await main(['compile', '--project', 'p'], deps(home))).toBe(0);
    expect(readDraft(aether(home))?.targetWindowStartMs).toBe(new Date(2026, 10, 4, 22).getTime());
  });
  it('amend window.start recomputes the draft\'s target window', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home));
    expect(await main(['amend', 'window.start', '21:00'], deps(home))).toBe(0);
    expect(readDraft(aether(home))?.targetWindowStartMs).toBe(new Date(2026, 10, 4, 21).getTime());
  });
  it('a second compile replaces the draft: one draft, a new label, nothing confirmed', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home)); await main(['confirm', '--all-ready'], deps(home));
    expect(readDraft(aether(home))?.items[0].confirmed).toBe(true);
    await main(['compile', '--project', 'p'], deps(home, [], T0 + 5000));
    const dr = readDraft(aether(home));
    expect(dr?.items.map((i: any) => i.confirmed)).toEqual([false]); expect(dr?.createdAtMs).toBe(T0 + 5000);
  });
  it('compile after approval says the approved night stands, and plan still returns it as approved', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home));
    await main(['confirm', '--all-ready'], deps(home));
    expect(await main(['approve'], deps(home))).toBe(0);
    const out: string[] = [];
    expect(await main(['compile', '--project', 'p'], deps(home, out, T0 + 5000))).toBe(0);
    expect(out.join('\n')).toMatch(/is approved and will run/);
    const plan: string[] = [];
    expect(await main(['plan', '--json'], deps(home, plan, T0 + 6000))).toBe(0);
    expect(JSON.parse(plan.join('\n'))).toMatchObject({ kind: 'approved', targetWindowStartMs: new Date(2026, 10, 5, 1).getTime(), items: [{ title: 'Run npm test' }] });
  });
  it('confirm and amend after approval say the approved night is unchanged', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home)); await main(['confirm', '--all-ready'], deps(home)); await main(['approve'], deps(home));
    const a: string[] = []; const b: string[] = [];
    expect(await main(['confirm', '--all-ready'], deps(home, a, T0 + 5000))).toBe(0);
    expect(await main(['amend', 'opusEscalation', 'true'], deps(home, b, T0 + 6000))).toBe(0);
    expect(a.join('\n')).toMatch(/is approved and will run/); expect(b.join('\n')).toMatch(/is approved and will run/);
  });
  it('confirm prints the allowlist an unfinished night would run on: the confirmed build item\'s rules, none for a held one', async () => {
    const home = tmpHome(); putHandoff(home, T0, 'aether-os', '1. Build the APK for aether-os\n2. Build the installer for aether-os\n');
    const d = (out: string[] = [], t = T0) => ({ ...deps(home, out, t), probes: okProbes });
    await main(['compile', '--project', 'aether-os'], d()); await main(['confirm', '--all-ready'], d()); await main(['approve'], d());   // creates the last-approved terms
    await main(['compile', '--project', 'aether-os'], d([], T0 + 5000));
    const apk = readDraft(aether(home))!.items.find((i: any) => /APK/.test(i.title))!;
    const out: string[] = [];
    expect(await main(['confirm', apk.id], d(out, T0 + 6000))).toBe(0);            // only the APK; the installer item stays held (not confirmed)
    const text = out.join('\n');
    for (const rule of buildAllowRules(DEFAULT_TERMS, [{ project: 'aether-os', kind: 'build', artifact: 'apk' }])) expect(text).toContain(rule);
    expect(text).toContain('Bash(gradlew.bat assembleDebug:*)'); expect(text).not.toContain('Bash(npm run dist:*)');
  });
  it('confirm with no last-approved terms says no unfinished allowlist exists yet and prints no rule', async () => {
    const home = tmpHome(); putHandoff(home, T0, 'aether-os', '1. Build the APK for aether-os\n'); const out: string[] = [];
    await main(['compile', '--project', 'aether-os'], { ...deps(home), probes: okProbes });
    expect(await main(['confirm', '--all-ready'], { ...deps(home, out), probes: okProbes })).toBe(0);
    expect(out.join('\n')).toMatch(/no unfinished-night allowlist exists yet/); expect(out.join('\n')).not.toContain('Bash(');
  });
  it('TTY_VERBS is exactly the write set, and every verb is declared', () => {
    expect([...TTY_VERBS].sort()).toEqual(['amend', 'approve', 'confirm', 'terms set']);
    for (const v of ['terms show', 'compile', 'feasibility', 'plan', 'deny-rules', 'install-skill', ...TTY_VERBS]) expect(VERBS).toContain(v);
  });
});
describe('main() additions beyond the plan test (in process)', () => {
  const deps = (home: string, out: string[] = [], nowMs = T0, extra: Record<string, unknown> = {}) => ({ homeDir: home, nowMs, isTty: true, readLine: async (q: string) => q.split(': ').pop()!.trim(), print: (s: string) => { out.push(s); }, printErr: (s: string) => { out.push(s); }, env: {}, ...extra });
  it('confirm and amend on a draft whose window passed more than 12h ago exit 4 with stale-draft', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home));
    const a: string[] = []; const b: string[] = [];
    expect(await main(['confirm', '--all-ready'], deps(home, a, T0 + 2 * DAY))).toBe(4);
    expect(await main(['amend', 'opusEscalation', 'true'], deps(home, b, T0 + 2 * DAY))).toBe(4);
    expect(a.join('\n')).toContain('stale-draft'); expect(b.join('\n')).toContain('stale-draft');
  });
  it('confirm skips the unfinished-night preview when the last approval is not older than the draft', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home)); await main(['confirm', '--all-ready'], deps(home)); await main(['approve'], deps(home));
    const out: string[] = [];
    expect(await main(['confirm', '--all-ready'], deps(home, out, T0 + 5000))).toBe(0);
    expect(out.join('\n')).toMatch(/newer than this draft/); expect(out.join('\n')).not.toContain('Bash(');
  });
  it('approve prints the refusal and exits 4 when the terms change while the prompt is open (state-changed)', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home)); await main(['confirm', '--all-ready'], deps(home));
    const out: string[] = [];
    const readLine = async (q: string) => { writeLiveTerms(aether(home), { ...DEFAULT_TERMS, opusEscalation: true }); return q.split(': ').pop()!.trim(); };
    expect(await main(['approve'], deps(home, out, T0, { readLine }))).toBe(4);
    expect(out.join('\n')).toMatch(/changed while the prompt was open/);
    expect(existsSync(join(aether(home), 'afk', 'approved.json'))).toBe(false);
  });
  it('approve exits 4 and prints the refusal message for any approveNight refusal (here no-draft)', async () => {
    const home = tmpHome(); const out: string[] = [];
    expect(await main(['approve'], deps(home, out))).toBe(4);   // no draft: approveNight refuses with its own message
    expect(out.join('\n')).toMatch(/no draft/);
  });
  it('plan prints the reason verbatim', async () => {
    const home = tmpHome(); mkdirSync(join(aether(home), 'afk'), { recursive: true }); writeFileSync(join(aether(home), 'afk', 'approved.json'), '{nope');
    const out: string[] = [];
    expect(await main(['plan'], deps(home, out))).toBe(0);
    expect(out.join('\n')).toContain('approval record failed: invalid');
  });
  it('the no-TTY text points at a plain PowerShell window and never at the ! escape', async () => {
    const out: string[] = [];
    expect(await main(['confirm', '--all-ready'], deps(tmpHome(), out, T0, { isTty: false }))).toBe(3);
    const text = out.join('\n');
    expect(text).toContain('plain PowerShell window'); expect(text).not.toContain('!');
  });
  it('install-skill exits 4 not available yet', async () => {
    const out: string[] = [];
    expect(await main(['install-skill'], deps(tmpHome(), out))).toBe(4); expect(out.join('\n')).toContain('not available yet');
  });
  it('an fs error in terms set is a clean exit 1: no stack, no path', async () => {
    const home = tmpHome(); mkdirSync(aether(home), { recursive: true }); writeFileSync(join(aether(home), 'afk'), 'x');   // afk is a file, so the write fails
    const out: string[] = [];
    expect(await main(['terms', 'set', 'opusEscalation', 'true'], deps(home, out))).toBe(1);
    const text = out.join('\n');
    expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(home); expect(text).not.toMatch(/\n\s+at /); expect(text).not.toMatch(/[A-Za-z]:\\/);
  });
  it('an unexpected error elsewhere is also exit 1 with no message text from the error', async () => {
    const out: string[] = [];
    const boom = { ...deps(tmpHome(), out), print: () => { throw new Error('secret C:\\Users\\x\\file'); } };
    expect(await main(['terms', 'show'], boom)).toBe(1);
    expect(out.join('\n')).not.toContain('secret');
  });
  it('cli.mjs reads no clock', () => {
    expect(readFileSync(fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'utf8')).not.toContain('Date.now');
  });
});
