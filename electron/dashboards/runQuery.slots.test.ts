// @vitest-environment node
// A fake child process that ignores kill() until the test closes it, so the slot
// accounting can be checked without racing a real process's exit.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

class FakeChild extends EventEmitter {
  pid = 1000 + Math.floor(Math.random() * 1000);
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}
const children: FakeChild[] = [];
vi.mock('node:child_process', () => ({ spawn: () => { const c = new FakeChild(); children.push(c); return c; } }));

const { MAX_CONCURRENT_QUERIES, executeIsolated, stopAllQueries } = await import('./runQuery');

describe('executeIsolated child processes', () => {
  it('holds a timed-out query slot until its killed process has exited', async () => {
    const runs = Array.from({ length: MAX_CONCURRENT_QUERIES + 1 }, () => executeIsolated('db', 'SELECT 1', null, 10, 20, 0));
    const firsts = await Promise.all(runs.slice(0, MAX_CONCURRENT_QUERIES));
    expect(firsts.every((r) => !r.ok && r.kind === 'timeout')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(children.length).toBe(MAX_CONCURRENT_QUERIES);
    expect(children.every((c) => c.killed)).toBe(true);

    children[0].emit('close', null);
    await vi.waitFor(() => expect(children.length).toBe(MAX_CONCURRENT_QUERIES + 1));
    for (const c of children) c.emit('close', null);
    expect(await runs[MAX_CONCURRENT_QUERIES]).toMatchObject({ ok: false, kind: 'timeout' });
  });

  // Last in the file: stopAllQueries() is one-way for the module.
  it('stopAllQueries kills running query processes and never spawns a queued or later one', async () => {
    const before = children.length;
    const runs = Array.from({ length: MAX_CONCURRENT_QUERIES + 2 }, () => executeIsolated('db', 'SELECT 1', null, 10, 60_000, 0));
    await vi.waitFor(() => expect(children.length).toBe(before + MAX_CONCURRENT_QUERIES));
    const fresh = children.slice(before);
    expect(fresh.some((c) => c.killed)).toBe(false);

    stopAllQueries();
    expect(fresh.every((c) => c.killed)).toBe(true);
    for (const c of fresh) c.emit('close', null);
    const results = await Promise.all(runs);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.slice(MAX_CONCURRENT_QUERIES)).toEqual([
      { ok: false, kind: 'sql', error: 'Query was cancelled: Aether is shutting down.' },
      { ok: false, kind: 'sql', error: 'Query was cancelled: Aether is shutting down.' },
    ]);
    expect(await executeIsolated('db', 'SELECT 1', null, 10, 60_000, 0)).toMatchObject({ ok: false, error: 'Query was cancelled: Aether is shutting down.' });
    await new Promise((r) => setTimeout(r, 50));
    expect(children.length).toBe(before + MAX_CONCURRENT_QUERIES);
  });
});
