// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createProjectsFeed } from './projectsFeed';
import type { LedgerSnapshot } from '../src/shared/ledgerMath';
import type { ProjectsSnapshot } from '../src/shared/projectsSnapshot';

const led = (usd: number): LedgerSnapshot => ({
  total: { usd, breakdown: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 } },
  tiers: ['opus'],
  rollups: { today: 1, week: null, month: 3 },
  cache: { cacheReadTokens: 10, wouldHaveCostUsd: 5, actuallyCostUsd: 1, savedUsd: 4 },
  cacheHitRate: 0.5,
  timeZone: 'America/New_York',
  computedAtMs: 1790000000000,
});
const node = (key: string, worktree: string | null, usd: number) => ({ key, name: 'repo', worktree, ledger: led(usd), optimize: { findings: ['SECRET-FINDING'], summary: {}, breakdown: [] } });
const proj = (): ProjectsSnapshot => ({
  computedAtMs: 1790000000000,
  unscoped: null,
  roots: [{ ...node('r1', null, 9), children: [node('r1a', null, 6), node('r1b', 'wt', 3)] }],
} as unknown as ProjectsSnapshot);

describe('projects feed', () => {
  it('attach delivers the validated payload synchronously, without optimize data or timeZone', () => {
    const feed = createProjectsFeed({ current: () => ({ projects: proj(), ledger: led(20) }) });
    const got: any[] = [];
    feed.port.attach({ snap: (d) => { got.push(d); } });
    expect(got).toHaveLength(1);
    expect(got[0].all.total.usd).toBe(20);
    expect(got[0].roots[0].children.map((c: any) => c.worktree)).toEqual([null, 'wt']);
    expect(JSON.stringify(got[0])).not.toMatch(/SECRET-FINDING|America|optimize/);
  });
  it('yields snap(null) until both caches exist', () => {
    for (const cur of [{ projects: null, ledger: led(1) }, { projects: proj(), ledger: null }]) {
      const got: unknown[] = [];
      createProjectsFeed({ current: () => cur }).port.attach({ snap: (d) => { got.push(d); } });
      expect(got).toEqual([null]);
    }
  });
  it('a malformed snapshot fails closed to snap(null) and never throws', () => {
    const bad = proj();
    bad.roots[0].ledger.total.usd = -5;
    const got: unknown[] = [];
    createProjectsFeed({ current: () => ({ projects: bad, ledger: led(1) }) }).port.attach({ snap: (d) => { got.push(d); } });
    expect(got).toEqual([null]);
    const feed = createProjectsFeed({ current: () => { throw new Error('boom'); } });
    expect(() => feed.port.attach({ snap: (d) => { got.push(d); } })).not.toThrow();
    expect(got).toEqual([null, null]);
  });
  it('notify re-reads current() for attached taps; a throwing tap does not stop the others; detach stops delivery', () => {
    let usd = 1;
    const feed = createProjectsFeed({ current: () => ({ projects: proj(), ledger: led(usd) }) });
    const seen: number[] = [];
    feed.port.attach({ snap: () => { throw new Error('tap'); } });
    const h = feed.port.attach({ snap: (d: any) => { seen.push(d.all.total.usd); } });
    usd = 2;
    expect(() => feed.notify()).not.toThrow();
    h.detach();
    h.detach();
    usd = 3;
    feed.notify();
    expect(seen).toEqual([1, 2]);
  });
});
