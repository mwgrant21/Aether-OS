// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { encodeMemoryView, MEMORY_CONTENT_CAP, MEMORY_MAX_LIVE, MEMORY_MAX_TOMBSTONES, MEMORY_SUBJECT_CAP, encodeProjectsView, PROJECTS_MAX_CHILDREN, PROJECTS_MAX_ROOTS, PROJECTS_TEXT_CAP } from './viewWire';
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
