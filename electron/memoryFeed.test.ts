// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createMemoryFeed } from './memoryFeed';
import type { MemoryRowUI, MemoryTombstoneUI } from './memoryStore';

const row = (id: number, content = 'c'): MemoryRowUI => ({ id, scope: 'shared', ownerAgent: null, kind: 'decision', content, status: null, salience: 0.5, subject: null, createdAtMs: 1, updatedAtMs: 2, referenceCount: 987 });
const tomb = (id: number): MemoryTombstoneUI => ({ id, scope: 'shared', ownerAgent: null, content: 'gone', deletedAtMs: 3, cause: 'operator', supersededBy: null });
const now = () => 1790000000000;

describe('memory feed', () => {
  it('attach delivers the validated payload synchronously, masked, without reference counts', () => {
    const tok = 'sk-ant-' + 'a'.repeat(30);
    const feed = createMemoryFeed({ read: () => ({ live: [row(1, `use ${tok}`)], tombstones: [tomb(2)] }), now });
    const got: any[] = [];
    feed.port.attach({ snap: (d) => { got.push(d); } });
    expect(got).toHaveLength(1);
    expect(got[0].computedAtMs).toBe(1790000000000);
    expect(got[0].live[0].id).toBe(1);
    expect(JSON.stringify(got[0])).not.toMatch(/sk-ant|987|referenceCount/);
  });
  it('an unreadable DB (null from the store) or a throwing read fails closed to snap(null), never a throw', () => {
    const got: unknown[] = [];
    for (const read of [() => ({ live: null, tombstones: [tomb(1)] }), () => ({ live: [row(1)], tombstones: null }), () => { throw new Error('boom'); }]) {
      expect(() => createMemoryFeed({ read, now }).port.attach({ snap: (d) => { got.push(d); } })).not.toThrow();
    }
    expect(got).toEqual([null, null, null]);
  });
  it('notify re-reads for attached taps; a throwing tap does not stop the others; detach stops delivery', () => {
    let n = 1;
    const feed = createMemoryFeed({ read: () => ({ live: [row(n)], tombstones: [] }), now });
    const seen: number[] = [];
    feed.port.attach({ snap: () => { throw new Error('tap'); } });
    const h = feed.port.attach({ snap: (d: any) => { seen.push(d.live[0].id); } });
    n = 2;
    expect(() => feed.notify()).not.toThrow();
    h.detach();
    h.detach();
    n = 3;
    feed.notify();
    expect(seen).toEqual([1, 2]);
  });
});
