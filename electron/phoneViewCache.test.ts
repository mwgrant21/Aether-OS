// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPhoneViewCache, createCacheViewFeed, PHONE_VIEW_MAX_BYTES } from './phoneViewCache';

afterEach(() => { vi.useRealTimers(); });

describe('phoneViewCache', () => {
  it('keeps the latest payload per view id while control is on', () => {
    const c = createPhoneViewCache(() => true);
    expect(c.ingest('dash', { n: 1 })).toBe(true);
    expect(c.ingest('dash', { n: 2 })).toBe(true);
    expect(c.ingest('analytics', { n: 3 })).toBe(true);
    expect(c.get('dash')).toEqual({ n: 2 });
    expect(c.get('analytics')).toEqual({ n: 3 });
  });

  it('is inert while control is off, and empty after a disable', () => {
    let on = true;
    const c = createPhoneViewCache(() => on);
    const seen: string[] = [];
    c.onChange(v => seen.push(v));
    c.ingest('dash', { n: 1 });
    on = false;
    c.clear();
    expect(c.get('dash')).toBeUndefined();
    expect(c.ingest('dash', { n: 2 })).toBe(false);
    expect(c.ingest('agents', { n: 3 })).toBe(false);
    expect(c.get('dash')).toBeUndefined();
    expect(c.get('agents')).toBeUndefined();
    expect(seen).toEqual(['dash', 'dash']); // one for the ingest, one for the clear; none for the refused ingests
  });

  it('refuses unknown ids, non-plain-object payloads and payloads over 128 KiB', () => {
    const c = createPhoneViewCache(() => true);
    expect(c.ingest('nope', { a: 1 })).toBe(false);
    expect(c.ingest('dash', [1])).toBe(false);
    expect(c.ingest('dash', 'x')).toBe(false);
    expect(c.ingest('dash', null)).toBe(false);
    expect(c.ingest('dash', { s: 'x'.repeat(PHONE_VIEW_MAX_BYTES) })).toBe(false);
    expect(c.get('dash')).toBeUndefined();
    expect(c.ingest('dash', { s: 'x'.repeat(1000) })).toBe(true);
  });
});

describe('createCacheViewFeed', () => {
  it('replays the current value on attach (null when empty) and stops after detach', () => {
    const c = createPhoneViewCache(() => true);
    const feed = createCacheViewFeed(c, 'dash', p => ({ wrapped: p }), { minGapMs: 0 });
    const a: unknown[] = [];
    const h = feed.attach({ snap: d => a.push(d) });
    expect(a).toEqual([null]);
    c.ingest('dash', { n: 1 });
    expect(a).toEqual([null, { wrapped: { n: 1 } }]);
    h.detach();
    c.ingest('dash', { n: 2 });
    expect(a).toHaveLength(2);
    const b: unknown[] = [];
    feed.attach({ snap: d => b.push(d) });
    expect(b).toEqual([{ wrapped: { n: 2 } }]);
  });

  it('sends at most once per second per tap, with the latest value in the trailing send', () => {
    vi.useFakeTimers();
    const c = createPhoneViewCache(() => true);
    const feed = createCacheViewFeed(c, 'dash', p => p, { now: () => Date.now() });
    const a: unknown[] = [];
    feed.attach({ snap: d => a.push(d) });
    c.ingest('dash', { n: 1 }); // right after the replay: held back
    c.ingest('dash', { n: 2 });
    expect(a).toEqual([null]);
    vi.advanceTimersByTime(999);
    expect(a).toEqual([null]);
    vi.advanceTimersByTime(1);
    expect(a).toEqual([null, { n: 2 }]);
  });

  it('delivers null at once when the cache is cleared, cancelling a pending send', () => {
    vi.useFakeTimers();
    const c = createPhoneViewCache(() => true);
    const feed = createCacheViewFeed(c, 'dash', p => p, { now: () => Date.now() });
    const a: unknown[] = [];
    feed.attach({ snap: d => a.push(d) });
    c.ingest('dash', { n: 1 });
    c.clear();
    expect(a).toEqual([null, null]);
    vi.advanceTimersByTime(5000);
    expect(a).toEqual([null, null]);
  });

  it('sends null when the encoder throws, and a throwing tap does not escape', () => {
    const c = createPhoneViewCache(() => true);
    c.ingest('dash', { n: 1 });
    const bad = createCacheViewFeed(c, 'dash', () => { throw new Error('x'); });
    const a: unknown[] = [];
    bad.attach({ snap: d => a.push(d) });
    expect(a).toEqual([null]);
    const ok = createCacheViewFeed(c, 'dash', p => p);
    expect(() => ok.attach({ snap: () => { throw new Error('tap'); } })).not.toThrow();
  });
});
