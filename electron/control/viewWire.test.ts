// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_MAX_FLEET, AGENTS_MAX_TIMELINE, encodeAgentsView, encodeFleetRows, encodeTimelineRows, encodeAnalyticsView, encodeDashView, encodeMemoryView, MEMORY_CONTENT_CAP, MEMORY_MAX_LIVE, MEMORY_MAX_TOMBSTONES, MEMORY_SUBJECT_CAP, encodeProjectsView, PROJECTS_MAX_CHILDREN, PROJECTS_MAX_ROOTS, PROJECTS_TEXT_CAP } from './viewWire';
import { encodeViewSnap } from './protocol';
import type { LedgerWire, MemoryWire, ProjectsWire } from '../../src/shared/remote/types';

const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../protocol/mobile-protocol.json'), 'utf8'));

const asLedger = (computedAtMs: number, f: Omit<LedgerWire, 'computedAtMs'>): LedgerWire => ({ computedAtMs, ...f });
// The golden's payload turned back into encoder input (the wire nests no computedAtMs per project).
function goldenWire(): ProjectsWire {
  const d = JSON.parse(spec.frames.viewSnapProjects).d;
  const led = (x: any): LedgerWire => asLedger(d.computedAtMs, { total: x.total, tiers: x.tiers, rollups: x.rollups, cache: x.cache });
  return {
    computedAtMs: d.computedAtMs,
    all: led(d.all),
    unscoped: d.unscoped ? led(d.unscoped) : null,
    roots: d.roots.map((r: any) => ({ key: r.key, name: r.name, ledger: led(r), children: r.children.map((c: any) => ({ key: c.key, worktree: c.worktree, ledger: led(c) })) })),
  };
}
const led = (): LedgerWire => goldenWire().all!;
const root = (name: string, n: number): ProjectsWire['roots'][number] => ({
  key: `k-${n}-${name.length}`, name, ledger: led(), children: Array.from({ length: n }, (_, i) => ({ key: `c-${name.length}-${i}`, worktree: i === 0 ? null : `wt${i}`, ledger: led() })),
});
const wire = (roots: ProjectsWire['roots']): ProjectsWire => ({ ...goldenWire(), roots });

describe('encodeProjectsView', () => {
  it('reproduces the viewSnapProjects golden byte for byte', () => {
    expect(encodeViewSnap('projects', encodeProjectsView(goldenWire()))).toBe(spec.frames.viewSnapProjects);
  });
  it('fails closed to null on any bad number, tier or key, and on null input', () => {
    expect(encodeProjectsView(null)).toBeNull();
    const bad: Array<(w: ProjectsWire) => void> = [
      (x) => { (x.all as any).total.usd = -1; },
      (x) => { (x.unscoped as any).cache.hitRate = 1.5; },
      (x) => { (x.roots[0].ledger as any).tiers = ['gpt']; },
      (x) => { (x.roots[0].children[1].ledger as any).rollups.week = NaN; },
      (x) => { (x as any).all = null; },
      (x) => { (x.roots[1] as any).key = ''; },
      (x) => { (x.roots[1] as any).name = 7; },
      (x) => { (x as any).computedAtMs = 1.5; },
    ];
    for (const f of bad) {
      const x = goldenWire();
      f(x);
      expect(encodeProjectsView(x)).toBeNull();
    }
  });
  it('rebuilds field by field: stray keys (paths, optimize data) never reach the payload', () => {
    const x = goldenWire() as any;
    x.roots[0].path = 'C:/secret/repo';
    x.roots[0].optimize = { findings: ['x'] };
    x.roots[0].ledger.timeZone = 'America/New_York';
    x.roots[0].children[1].cwd = 'C:/secret/repo/wt';
    const out = JSON.stringify(encodeProjectsView(x));
    expect(out).toBe(JSON.stringify(encodeProjectsView(goldenWire())));
    expect(out).not.toMatch(/secret|optimize|New_York|path|cwd/);
  });
  it('sends children only for a root with more than one checkout', () => {
    const d: any = encodeProjectsView(wire([root('solo', 1), root('empty', 0), root('multi', 2)]));
    expect(d.roots.map((r: any) => r.children.length)).toEqual([0, 0, 2]);
    expect(d.roots[2].children[0].worktree).toBeNull();
  });
  it('keeps root order and caps roots at 50, children at 20, and name and worktree at 60 characters', () => {
    const roots = Array.from({ length: PROJECTS_MAX_ROOTS + 3 }, (_, i) => root(`r${PROJECTS_MAX_ROOTS + 3 - i}`, 0));
    const d: any = encodeProjectsView(wire(roots));
    expect(d.roots).toHaveLength(PROJECTS_MAX_ROOTS);
    expect(d.roots.map((r: any) => r.name)).toEqual(roots.slice(0, PROJECTS_MAX_ROOTS).map((r) => r.name));
    const big = root('my project '.repeat(10), PROJECTS_MAX_CHILDREN + 5);
    big.children = big.children.map((c, i) => (i === 1 ? { ...c, worktree: 'my tree '.repeat(20) } : c));
    const e: any = encodeProjectsView(wire([big]));
    expect(e.roots[0].name).toHaveLength(PROJECTS_TEXT_CAP);
    expect(e.roots[0].children).toHaveLength(PROJECTS_MAX_CHILDREN);
    expect(e.roots[0].children[1].worktree).toHaveLength(PROJECTS_TEXT_CAP);
  });
  it('masks secrets in names before capping, and never splits a surrogate pair at the cap', () => {
    const tok = 'sk-ant-' + 'a'.repeat(30);
    const d: any = encodeProjectsView(wire([root(`${tok}-proj`, 0), root('p'.repeat(PROJECTS_TEXT_CAP - 1) + '\u{1F600}', 0)]));
    expect(JSON.stringify(d)).not.toContain(tok);
    expect(d.roots[0].name).toContain('[redacted]');
    expect(d.roots[1].name).toBe('p'.repeat(PROJECTS_TEXT_CAP - 1));
  });
});

// The golden's payload turned back into encoder input (wire `owner` is the store's `ownerAgent`).
function memGolden(): MemoryWire {
  const d = JSON.parse(spec.frames.viewSnapMemory).d;
  return { computedAtMs: d.computedAtMs, live: d.live.map(({ owner, ...r }: any) => ({ ...r, ownerAgent: owner })), tombstones: d.tombstones.map(({ owner, ...r }: any) => ({ ...r, ownerAgent: owner })) };
}
const liveRow = (id: number, over: Record<string, unknown> = {}): MemoryWire['live'][number] => ({ ...memGolden().live[0], id, ...over }) as MemoryWire['live'][number];
const tomb = (id: number, over: Record<string, unknown> = {}): MemoryWire['tombstones'][number] => ({ ...memGolden().tombstones[0], id, ...over }) as MemoryWire['tombstones'][number];

describe('encodeMemoryView', () => {
  it('reproduces the viewSnapMemory golden byte for byte', () => {
    expect(encodeViewSnap('memory', encodeMemoryView(memGolden()))).toBe(spec.frames.viewSnapMemory);
  });
  it('masks secrets in content, subject and owner before capping', () => {
    const tok = 'sk-ant-' + 'a'.repeat(30);
    const w = memGolden();
    w.live = [liveRow(1, { content: `key is ${tok} ok`, subject: tok, ownerAgent: tok })];
    w.tombstones = [tomb(2, { content: `old ${tok}` })];
    const out = JSON.stringify(encodeMemoryView(w));
    expect(out).not.toContain(tok);
    expect(out).toContain('[redacted]');
  });
  it('caps content at 600, subject at 80, and never splits a surrogate pair', () => {
    const w = memGolden();
    w.live = [liveRow(1, { content: 'c'.repeat(MEMORY_CONTENT_CAP + 50), subject: 's'.repeat(MEMORY_SUBJECT_CAP - 1) + '\u{1F600}' })];
    const d: any = encodeMemoryView(w);
    expect(d.live[0].content).toHaveLength(MEMORY_CONTENT_CAP);
    expect(d.live[0].subject).toBe('s'.repeat(MEMORY_SUBJECT_CAP - 1));
  });
  it('fails closed to null on a bad enum, id, number or text, and on null input', () => {
    expect(encodeMemoryView(null)).toBeNull();
    const bad: Array<(w: any) => void> = [
      (w) => { w.live[0].kind = 'rumour'; },
      (w) => { w.live[0].scope = 'secret'; },
      (w) => { w.live[0].status = 'closed'; },
      (w) => { w.live[0].id = 1.5; },
      (w) => { w.live[0].salience = NaN; },
      (w) => { w.live[0].updatedAtMs = -1; },
      (w) => { w.live[0].content = 7; },
      (w) => { w.tombstones[0].cause = 'whim'; },
      (w) => { w.tombstones[0].supersededBy = 'x'; },
      (w) => { w.tombstones = null; },
    ];
    for (const f of bad) {
      const w = memGolden();
      f(w);
      expect(encodeMemoryView(w)).toBeNull();
    }
  });
  it('orders live by salience then recency and tombstones newest first, caps at 150 and 60, and counts the totals', () => {
    const w = memGolden();
    w.live = [liveRow(1, { salience: 0.2 }), liveRow(2, { salience: 0.8, updatedAtMs: 5 }), liveRow(3, { salience: 0.8, updatedAtMs: 9 })];
    w.tombstones = [tomb(1, { deletedAtMs: 10 }), tomb(2, { deletedAtMs: 30 }), tomb(3, { deletedAtMs: 20 })];
    const d: any = encodeMemoryView(w);
    expect(d.live.map((r: any) => r.id)).toEqual([3, 2, 1]);
    expect(d.tombstones.map((r: any) => r.id)).toEqual([2, 3, 1]);
    w.live = Array.from({ length: MEMORY_MAX_LIVE + 7 }, (_, i) => liveRow(i + 1, { salience: i / 1000 }));
    w.tombstones = Array.from({ length: MEMORY_MAX_TOMBSTONES + 4 }, (_, i) => tomb(i + 1, { deletedAtMs: i }));
    const e: any = encodeMemoryView(w);
    expect(e.live).toHaveLength(MEMORY_MAX_LIVE);
    expect(e.live[0].id).toBe(MEMORY_MAX_LIVE + 7);
    expect(e.tombstones).toHaveLength(MEMORY_MAX_TOMBSTONES);
    expect(e.counts).toEqual({ live: MEMORY_MAX_LIVE + 7, tombstones: MEMORY_MAX_TOMBSTONES + 4 });
  });
  it('rebuilds field by field: reference counts and stray keys never reach the payload; extraction is null', () => {
    const w: any = memGolden();
    w.live[0].referenceCount = 987;
    w.live[0].path = 'C:/secret/repo';
    w.tombstones[0].extractionCostUsd = 12.5;
    const out = JSON.stringify(encodeMemoryView(w));
    expect(out).toBe(JSON.stringify(encodeMemoryView(memGolden())));
    expect(out).not.toMatch(/987|secret|referenceCount|12\.5/);
    expect((encodeMemoryView(w) as any).extraction).toBeNull();
  });
});

const dashGolden = (): Record<string, unknown> => JSON.parse(spec.frames.viewSnapDash).d;
const dashWith = (path: string[], value: unknown): Record<string, unknown> => {
  const d = dashGolden();
  let o: any = d;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path[path.length - 1]] = value;
  return d;
};

describe('encodeDashView', () => {
  it('reproduces the viewSnapDash golden byte for byte', () => {
    expect(encodeViewSnap('dash', encodeDashView(dashGolden()))).toBe(spec.frames.viewSnapDash);
  });
  it('keeps null as null (not measured is never 0)', () => {
    const d = dashGolden() as any;
    d.ratePerMin = null; d.kpis.monthTokens = null; d.kpis.todayUsd = null; d.kpis.budgetLeftPct = null; d.recap = null;
    d.kpis.eta = { kind: 'none', secs: null, source: 'scan', resetsInMs: null };
    const out = encodeDashView(d) as any;
    expect([out.ratePerMin, out.kpis.monthTokens, out.kpis.todayUsd, out.kpis.budgetLeftPct, out.recap]).toEqual([null, null, null, null, null]);
  });
  it('returns null for the whole payload on a NaN, negative or out-of-range number', () => {
    for (const [path, v] of [
      [['ratePerMin'], NaN], [['ratePerMin'], -1], [['kpis', 'todayUsd'], -0.01], [['kpis', 'monthTokens'], Infinity],
      [['kpis', 'budgetLeftPct'], 100.5], [['kpis', 'capM'], 0], [['kpis', 'eta', 'resetsInMs'], -5], [['strip', 'alerts'], -1], [['recap', 'tokensBurned'], NaN],
    ] as [string[], unknown][]) expect(encodeDashView(dashWith(path, v)), path.join('.')).toBeNull();
  });
  it('returns null for an unknown enum or an eta whose kind and secs disagree', () => {
    expect(encodeDashView(dashWith(['alarm'], 'panic'))).toBeNull();
    expect(encodeDashView(dashWith(['kpis', 'eta', 'source'], 'guess'))).toBeNull();
    expect(encodeDashView(dashWith(['kpis', 'eta', 'secs'], null))).toBeNull(); // kind 'secs' needs secs
    expect(encodeDashView(dashWith(['kpis', 'eta', 'kind'], 'now'))).toBeNull(); // 'now' must not carry secs
    expect(encodeDashView(dashWith(['readiness'], [{ key: 'desktop', met: true, glows: false, atMs: null }, { key: 'desktop', met: true, glows: false, atMs: null }]))).toBeNull();
  });
  it('drops stray keys at every level, including free text and a cfg object', () => {
    const d = dashGolden() as any;
    d.cfg = { theme: 'x' }; d.digest = [{ text: 'LEAK' }]; d.kpis.note = 'LEAK'; d.kpis.eta.text = 'LEAK'; d.readiness[0].text = 'LEAK'; d.recap.detail = 'LEAK'; d.strip.notifs = ['LEAK'];
    const out = encodeViewSnap('dash', encodeDashView(d));
    expect(out).toBe(spec.frames.viewSnapDash);
    expect(out).not.toContain('LEAK');
  });
  it('rejects a non-object input', () => {
    expect(encodeDashView(null)).toBeNull();
    expect(encodeDashView([] as unknown as Record<string, unknown>)).toBeNull();
  });
});

const anGolden = (): Record<string, any> => JSON.parse(spec.frames.viewSnapAnalytics).d;

describe('encodeAnalyticsView', () => {
  it('reproduces the viewSnapAnalytics golden byte for byte', () => {
    expect(encodeViewSnap('analytics', encodeAnalyticsView(anGolden()))).toBe(spec.frames.viewSnapAnalytics);
  });
  it('masks secrets and caps descriptions at 80, types at 40 and command names at 24', () => {
    const d = anGolden();
    d.longest[0].description = 'x'.repeat(200);
    d.burn[0].description = 'deploy with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD now';
    d.burn[0].type = 't'.repeat(100);
    d.commands[0].name = 'c'.repeat(60);
    d.commands[1].name = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const out = encodeAnalyticsView(d) as any;
    expect(out.longest[0].description).toHaveLength(80);
    expect(out.burn[0].type).toHaveLength(40);
    expect(out.commands[0].name).toHaveLength(24);
    expect(JSON.stringify(out)).not.toMatch(/sk-ant-api03|ghp_abc/);
  });
  it('fails closed on a command name that is more than one word, and drops stray keys (prompt, raw logs, full command)', () => {
    expect(encodeAnalyticsView({ ...anGolden(), commands: [{ name: 'rm -rf /', count: 1 }] })).toBeNull();
    expect(encodeAnalyticsView({ ...anGolden(), commands: [{ name: '', count: 1 }] })).toBeNull();
    const d = anGolden();
    d.logs.text = 'LEAK'; d.rawLogs = [{ m: 'LEAK' }]; d.longest[0].prompt = 'LEAK'; d.burn[0].prompt = 'LEAK'; d.commands[0].full = 'LEAK';
    const out = encodeViewSnap('analytics', encodeAnalyticsView(d));
    expect(out).toBe(spec.frames.viewSnapAnalytics);
    expect(out).not.toContain('LEAK');
  });
  it('cuts lists at 8, 5 and 5, keeps toolUses null as null, and returns null for a bad number or shape', () => {
    const d = anGolden();
    d.longest = Array.from({ length: 12 }, () => d.longest[0]);
    d.burn = Array.from({ length: 9 }, () => d.burn[1]);
    d.commands = Array.from({ length: 7 }, () => d.commands[0]);
    const out = encodeAnalyticsView(d) as any;
    expect([out.longest.length, out.burn.length, out.commands.length, out.burn[0].toolUses]).toEqual([8, 5, 5, null]);
    for (const mutate of [
      (x: any) => { x.logs.info = -1; }, (x: any) => { x.burn[0].tokens = NaN; }, (x: any) => { x.longest[0].startedAtMs = Infinity; },
      (x: any) => { x.commands[0].count = 1.5; }, (x: any) => { x.burn[0].toolUses = -2; }, (x: any) => { x.longest = null; }, (x: any) => { x.longest[0].description = 7; },
    ]) { const x = anGolden(); mutate(x); expect(encodeAnalyticsView(x)).toBeNull(); }
    expect(encodeAnalyticsView(null)).toBeNull();
  });
});

const agGolden = (): Record<string, any> => JSON.parse(spec.frames.viewSnapAgents).d;

describe('encodeAgentsView', () => {
  it('reproduces the viewSnapAgents golden byte for byte', () => {
    expect(encodeViewSnap('agents', encodeAgentsView(agGolden()))).toBe(spec.frames.viewSnapAgents);
  });
  it('masks BEFORE capping and caps description 120, headline 120, narration 160, detail 120, prompt 1200', () => {
    const akia = 'AKIAIOSFODNN7EXAMPLE';
    const d = agGolden();
    Object.assign(d.running[0], { description: 'x'.repeat(300), headline: 'y'.repeat(300), narration: 'z'.repeat(300), prompt: 'p'.repeat(2000) });
    d.running[0].anomaly.detail = 'q'.repeat(300);
    d.running[1].prompt = `${'p'.repeat(1180)} ${akia}`;
    d.running[1].description = `${'d'.repeat(114)} ${akia}`;
    d.running[1].headline = `${'h'.repeat(114)} ${akia}`;
    d.running[1].narration = `${'n'.repeat(154)} ${akia}`;
    const out = encodeAgentsView(d) as any;
    expect([out.running[0].description.length, out.running[0].headline.length, out.running[0].narration.length, out.running[0].anomaly.detail.length, out.running[0].prompt.length]).toEqual([120, 120, 160, 120, 1200]);
    expect(JSON.stringify(out.running[1])).not.toMatch(/AKIA/);
    expect(out.running[1].prompt).toContain('[redacted]');
  });
  it('fails closed: unsafe id, needsInput that disagrees with anomaly, unknown anomaly kind, bad numbers, bad shapes', () => {
    for (const mutate of [
      (x: any) => { x.running[0].id = 'a b'; }, (x: any) => { x.running[0].id = 'x'.repeat(65); }, (x: any) => { x.running[0].needsInput = false; }, (x: any) => { x.running[1].needsInput = true; },
      (x: any) => { x.running[0].anomaly.kind = 'weird'; }, (x: any) => { x.done[0].tokens = NaN; }, (x: any) => { x.done[0].durationMs = -1; }, (x: any) => { x.running[0].startedAtMs = Infinity; },
      (x: any) => { x.running = null; }, (x: any) => { x.running[0].prompt = 5; }, (x: any) => { x.computedAtMs = 'now'; },
    ]) { const x = agGolden(); mutate(x); expect(encodeAgentsView(x)).toBeNull(); }
    expect(encodeAgentsView(null)).toBeNull();
  });
  it('drops stray keys (toolUseId, permission requests, fleet and timeline input) and always emits fleet and timeline as null', () => {
    const d = agGolden();
    d.running[0].toolUseId = 'LEAK'; d.running[0].permission = 'LEAK'; d.done[0].prompt = 'LEAK'; d.anomaly = 'LEAK'; d.running[0].anomaly.toolUseId = 'LEAK';
    d.fleet = [{ name: 'LEAK' }]; d.timeline = [{ label: 'LEAK' }];
    const out = encodeViewSnap('agents', encodeAgentsView(d));
    expect(out).toBe(spec.frames.viewSnapAgents);
    expect(out).not.toContain('LEAK');
  });
  it('reduces a path in an anomaly detail to its file name, after masking', () => {
    const d = agGolden();
    d.running[0].anomaly.detail = 'C:\\Users\\Matt\\secret-project\\src\\worker.ts read 6 times';
    expect((encodeAgentsView(d) as any).running[0].anomaly.detail).toBe('worker.ts read 6 times');
  });
  it('leaves no directory fragment of a spaced, quoted or POSIX path in an anomaly detail', () => {
    const cases: [string, string][] = [
      ['C:\\Users\\John Smith\\Documents\\proj\\a.ts read 6 times', 'a.ts read 6 times'],
      ['/home/alice smith/p/f.ts written 3 times in 5min', 'f.ts written 3 times in 5min'],
      ['"D:\\Work\\Acme Corp Secret Project\\f.ts" read 4 times', 'f.ts read 4 times'],
      ['C:\\Users\\Jane Q Public\\app\\f.ts read 2 times', 'f.ts read 2 times'],
      ['C:\\Users\\Matt\\proj\\worker.ts read 6 times', 'worker.ts read 6 times'],
      ['12000 tokens used with zero file edits', '12000 tokens used with zero file edits'],
      ['Bash open for 95s', 'Bash open for 95s'],
    ];
    for (const [detail, want] of cases) {
      const d = agGolden();
      d.running[0].anomaly.detail = detail;
      expect((encodeAgentsView(d) as any).running[0].anomaly.detail).toBe(want);
    }
  });
  it('puts the fleet and timeline from the second argument on the wire (viewSnapAgentsDiag golden) and still ignores any in the roster', () => {
    const g = JSON.parse(spec.frames.viewSnapAgentsDiag).d;
    const roster = agGolden();
    roster.fleet = [{ key: 'LEAKLEAK1', title: 'LEAK' }]; roster.timeline = [{ k: 'tool', label: 'LEAK' }];
    expect(encodeViewSnap('agents', encodeAgentsView(roster, { fleet: g.fleet, timeline: g.timeline }))).toBe(spec.frames.viewSnapAgentsDiag);
    expect(encodeViewSnap('agents', encodeAgentsView(roster))).toBe(spec.frames.viewSnapAgents);
  });
  it('cuts lists at 30 running and 20 done', () => {
    const d = agGolden();
    d.running = Array.from({ length: 40 }, () => d.running[1]);
    d.done = Array.from({ length: 30 }, () => d.done[0]);
    const out = encodeAgentsView(d) as any;
    expect([out.running.length, out.done.length]).toEqual([30, 20]);
  });
});

const fleetRow = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ key: 'a1b2c3d4e5f60718', projectName: 'aether-os', name: 'sync-worker', startedAtMs: 1789990000000, status: 'busy', kind: 'interactive', pid: 4242, ...o });

describe('encodeFleetRows', () => {
  it('titles a row with the project basename, keeps the golden field names and order, and sorts oldest first', () => {
    const out = encodeFleetRows([
      fleetRow({ key: 'bbbbbbbb11111111', projectName: 'C:\\Users\\John Smith\\Work Stuff\\tarot-app', startedAtMs: 1789995000000, status: 'idle', pid: null }),
      fleetRow(),
    ])!;
    expect(out.map(r => r.title)).toEqual(['aether-os', 'tarot-app']);
    expect(Object.keys(out[0])).toEqual(['key', 'title', 'name', 'startedAtMs', 'status', 'kind', 'pid']);
    expect(out[1].pid).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/John|Smith|Work Stuff|Users/);
  });
  it('drops stray keys (sessionId, cwd, a path) and masks a secret before the cap', () => {
    const akia = 'AKIA' + 'B'.repeat(16);
    const out = encodeFleetRows([fleetRow({ sessionId: 'RAW-SESSION-ID', cwd: 'C:\\LEAK\\dir', transcriptPath: '/LEAK/x.jsonl', name: `${'n'.repeat(50)} ${akia}` })])!;
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/LEAK|RAW-SESSION|AKIA|cwd|sessionId/);
    expect((out[0].name as string).length).toBeLessThanOrEqual(60);
  });
  it('drops the bad row, not the list; null when nothing valid is left; [] only for an empty input; null for a non-array', () => {
    const out = encodeFleetRows([fleetRow({ status: 'weird' }), fleetRow({ key: 'short' }), fleetRow({ startedAtMs: -1 }), fleetRow({ pid: 1.5 }), fleetRow({ key: 'cccccccc22222222' })])!;
    expect(out.map(r => r.key)).toEqual(['cccccccc22222222']);
    expect(encodeFleetRows([fleetRow({ status: 'weird' })])).toBeNull();
    expect(encodeFleetRows([])).toEqual([]);
    expect(encodeFleetRows(null)).toBeNull();
    expect(encodeFleetRows([fleetRow(), fleetRow()])!).toHaveLength(1);
  });
  it('caps at 50, keeping the oldest', () => {
    const rows = Array.from({ length: 70 }, (_, i) => fleetRow({ key: `k${String(i).padStart(10, '0')}`, startedAtMs: 1000 + (69 - i) }));
    const out = encodeFleetRows(rows)!;
    expect(out).toHaveLength(AGENTS_MAX_FLEET);
    expect([out[0].startedAtMs, out[49].startedAtMs]).toEqual([1000, 1049]);
  });
});

const tc = (o: Record<string, unknown> = {}) => ({ toolUseId: 'LEAK-TU', toolName: 'Edit', filePathRel: 'src/worker.ts', startedAtMs: 1, closedAtMs: 1789999700000, ...o });
const dp = (o: Record<string, unknown> = {}) => ({ toolUseId: 'LEAK-DP', tokens: 482000, toolUses: 37, durationMs: 612000, startedAtMs: 1, endedAtMs: 1789999800000, agentId: 'LEAK-AG', taskKind: 'x', sessionId: 'LEAK-SESS', retries: 0, exitState: 'ok', severity: 1, medianMsAtEval: 5, ...o });
const an = (o: Record<string, unknown> = {}) => ({ kind: 'reReadLoop', toolUseId: 'LEAK-AN', detail: 'src/worker.ts read 6 times', detectedAtMs: 1789999950000, ...o });
const snap = (o: Record<string, unknown> = {}) => ({ toolCalls: [tc()], dispatches: [dp()], anomalies: [an()], ...o });

describe('encodeTimelineRows', () => {
  it('maps toolCall to tool, composes one label per kind, sorts newest first and keeps only the six wire fields', () => {
    const out = encodeTimelineRows(snap())!;
    expect(out.map(r => r.k)).toEqual(['anomaly', 'dispatch', 'tool']);
    expect(out.map(r => r.label)).toEqual(['reReadLoop: worker.ts read 6 times', 'Agent', 'Edit worker.ts']);
    expect(Object.keys(out[1])).toEqual(['k', 'atMs', 'label', 'tokens', 'toolUses', 'durationMs']);
    expect(out[1]).toMatchObject({ tokens: 482000, toolUses: 37, durationMs: 612000 });
    expect(out[2]).toMatchObject({ tokens: null, toolUses: null, durationMs: null });
  });
  it('lets no path-bearing field reach the wire: filePathRel, ids, session, agent and source_file_rel are dropped', () => {
    const json = JSON.stringify(encodeTimelineRows(snap({ toolCalls: [tc({ source_file_rel: 'C--Users-Matt-LEAK-proj/x.jsonl', filePathRel: 'C:\\LEAK\\dir\\file.ts' })] })));
    expect(json).not.toMatch(/LEAK|source_file|filePathRel|sessionId|agentId|toolUseId|taskKind|exitState|C:/);
    expect(json).toContain('Edit file.ts');
  });
  it('leaves only the basename of a spaced Windows or POSIX tool file path, and of a spaced path in an anomaly detail', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ toolCalls: [tc({ filePathRel: 'Users\\John Smith\\Secret Project\\app\\a b.ts' })], dispatches: [], anomalies: [] }, 'Edit a b.ts'],
      [{ toolCalls: [tc({ filePathRel: '/home/alice smith/p/f.ts' })], dispatches: [], anomalies: [] }, 'Edit f.ts'],
      [{ toolCalls: [tc({ filePathRel: 'dir with space/' })], dispatches: [], anomalies: [] }, 'Edit'],
      [{ toolCalls: [], dispatches: [], anomalies: [an({ detail: 'C:\\Users\\John Smith\\Documents\\proj\\a.ts read 6 times' })] }, 'reReadLoop: a.ts read 6 times'],
    ];
    for (const [s, want] of cases) {
      const out = encodeTimelineRows(s)!;
      expect(out[0].label).toBe(want);
      expect(JSON.stringify(out)).not.toMatch(/John|Smith|Secret|alice|Documents|dir with/);
    }
  });
  it('masks before the cap: a secret that straddles the 80th character is redacted, not half-cut', () => {
    const akia = 'AKIA' + 'B'.repeat(16);
    const out = encodeTimelineRows({ toolCalls: [tc({ toolName: `${'t'.repeat(70)} ${akia}`, filePathRel: null })], dispatches: [], anomalies: [] })!;
    expect((out[0].label as string).length).toBeLessThanOrEqual(80);
    expect(out[0].label).not.toMatch(/AKIA|BBBB/);
  });
  it('caps at 60 newest and null-vs-[]: null for no snapshot, [] only when all three lists are empty, null when rows exist but none is valid', () => {
    const calls = Array.from({ length: 90 }, (_, i) => tc({ closedAtMs: 1000 + i }));
    const out = encodeTimelineRows(snap({ toolCalls: calls, dispatches: [], anomalies: [] }))!;
    expect(out).toHaveLength(AGENTS_MAX_TIMELINE);
    expect([out[0].atMs, out[59].atMs]).toEqual([1089, 1030]);
    expect(encodeTimelineRows(null)).toBeNull();
    expect(encodeTimelineRows({ toolCalls: [], dispatches: [], anomalies: [] })).toEqual([]);
    expect(encodeTimelineRows({ toolCalls: [tc({ closedAtMs: 'x' })], dispatches: [], anomalies: [] })).toBeNull();
    expect(encodeTimelineRows({ toolCalls: [] })).toBeNull();
  });
  it('drops a dispatch with a bad number and keeps unmeasured usage as null, never 0', () => {
    const out = encodeTimelineRows(snap({ toolCalls: [], anomalies: [], dispatches: [dp({ tokens: -5 }), dp({ tokens: null, toolUses: null, durationMs: null, endedAtMs: 2000 })] }))!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ k: 'dispatch', tokens: null, toolUses: null, durationMs: null });
  });
});
