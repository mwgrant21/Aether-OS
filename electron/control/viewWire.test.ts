// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectsView, PROJECTS_MAX_CHILDREN, PROJECTS_MAX_ROOTS, PROJECTS_TEXT_CAP } from './viewWire';
import { encodeViewSnap } from './protocol';
import type { LedgerWire, ProjectsWire } from '../../src/shared/remote/types';

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
