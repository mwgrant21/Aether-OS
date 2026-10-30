// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createLedgerFeed } from './ledgerFeed';
import type { LedgerSnapshot } from '../src/shared/ledgerMath';
import type { LedgerWire } from '../src/shared/remote/types';

const snap = (usd: number): LedgerSnapshot => ({
  total: { usd, breakdown: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 } },
  tiers: ['opus', 'sonnet'],
  rollups: { today: 12.5, week: null, month: 624.99 },
  cache: { cacheReadTokens: 52560000, wouldHaveCostUsd: 1576.8, actuallyCostUsd: 157.68, savedUsd: 1419.12 },
  cacheHitRate: 0.896,
  timeZone: 'America/New_York',
  computedAtMs: 1790000000000,
});

describe('ledger feed', () => {
  it('attach delivers the current wire synchronously, without timeZone', () => {
    const feed = createLedgerFeed({ current: () => snap(912.34) });
    const got: (LedgerWire | null)[] = [];
    feed.port.attach({ snap: (l) => { got.push(l); } });
    expect(got).toEqual([{
      computedAtMs: 1790000000000,
      total: { usd: 912.34, input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
      tiers: ['opus', 'sonnet'],
      rollups: { today: 12.5, week: null, month: 624.99 },
      cache: { readTokens: 52560000, wouldHaveUsd: 1576.8, actualUsd: 157.68, savedUsd: 1419.12, hitRate: 0.896 },
    }]);
    expect(JSON.stringify(got[0])).not.toContain('America/New_York');
  });

  it('forwards only the known fields even when the snapshot carries extra keys', () => {
    const dirty = { ...snap(1), prompt: 'secret', total: { ...snap(1).total, extra: 9 } } as unknown as LedgerSnapshot;
    const feed = createLedgerFeed({ current: () => dirty });
    let w: LedgerWire | null = null;
    feed.port.attach({ snap: (l) => { w = l; } });
    expect(Object.keys(w!)).toEqual(['computedAtMs', 'total', 'tiers', 'rollups', 'cache']);
    expect(Object.keys(w!.total)).toEqual(['usd', 'input', 'output', 'cacheCreation', 'cacheRead']);
  });

  it('a null current() yields snap(null)', () => {
    const feed = createLedgerFeed({ current: () => null });
    const got: (LedgerWire | null)[] = [];
    feed.port.attach({ snap: (l) => { got.push(l); } });
    expect(got).toEqual([null]);
  });

  it('notify re-reads current() and reaches an attached tap', () => {
    let cur = snap(1);
    const feed = createLedgerFeed({ current: () => cur });
    const usd: number[] = [];
    feed.port.attach({ snap: (l) => { usd.push(l!.total.usd); } });
    cur = snap(2);
    feed.notify();
    expect(usd).toEqual([1, 2]);
  });

  it('after detach (idempotent) the tap gets nothing more', () => {
    const feed = createLedgerFeed({ current: () => snap(1) });
    let n = 0;
    const h = feed.port.attach({ snap: () => { n++; } });
    h.detach();
    h.detach();
    feed.notify();
    expect(n).toBe(1);
  });

  it('a throwing tap neither stops a second tap nor escapes attach() or notify()', () => {
    const feed = createLedgerFeed({ current: () => snap(1) });
    let n = 0;
    expect(() => feed.port.attach({ snap: () => { throw new Error('boom'); } })).not.toThrow();
    feed.port.attach({ snap: () => { n++; } });
    expect(() => feed.notify()).not.toThrow();
    expect(n).toBe(2);
  });
});
