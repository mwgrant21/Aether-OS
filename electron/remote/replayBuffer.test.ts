// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReplayBuffer } from './replayBuffer';
import type { ChatEvent } from './types';

const ev = (n: number, text = ''): ChatEvent => ({
  k: 'msg',
  id: `${n}:0`,
  atMs: n,
  role: 'claude',
  text,
  truncated: false,
  tools: [],
});
const size = (e: ChatEvent) => Buffer.byteLength(JSON.stringify(e));

describe('replayBuffer', () => {
  it('evicts oldest first and never exceeds 65536 bytes', () => {
    const b = createReplayBuffer();
    for (let i = 0; i < 200; i++) {
      b.push(ev(i, 'x'.repeat(1000)));
      expect(b.bytes).toBeLessThanOrEqual(65536);
    }
    const ids = b.snapshot().map((e) => e.id);
    expect(ids[ids.length - 1]).toBe('199:0');
    expect(ids[0]).not.toBe('0:0');
    expect(ids).toEqual([...ids].sort((a, c) => parseInt(a) - parseInt(c)));
  });

  it('counts UTF-8 bytes, not characters, for emoji and CJK', () => {
    const b = createReplayBuffer(1000);
    const text = '😀漢字'.repeat(40); // 40 * (4+3+3) bytes, 160 UTF-16 units
    const e = ev(1, text);
    expect(size(e)).toBeGreaterThan(JSON.stringify(e).length);
    for (let i = 0; i < 10; i++) b.push(ev(i, text));
    expect(b.bytes).toBeLessThanOrEqual(1000);
    expect(b.bytes).toBe(b.snapshot().reduce((s, x) => s + size(x), 0));
    expect(b.snapshot().length).toBe(Math.floor(1000 / size(e)));
  });

  it('drops a single oversized event and keeps prior content', () => {
    const b = createReplayBuffer(500);
    b.push(ev(1, 'a'));
    b.push(ev(2, 'x'.repeat(600)));
    expect(b.snapshot().map((e) => e.id)).toEqual(['1:0']);
  });

  it('snapshot mutation does not affect the buffer', () => {
    const b = createReplayBuffer();
    b.push(ev(1));
    b.snapshot().pop();
    expect(b.snapshot()).toHaveLength(1);
  });

  it('clear empties and zeroes bytes', () => {
    const b = createReplayBuffer();
    b.push(ev(1, 'hi'));
    b.clear();
    expect(b.snapshot()).toEqual([]);
    expect(b.bytes).toBe(0);
  });

  it('buffers are independent', () => {
    const a = createReplayBuffer();
    const c = createReplayBuffer();
    a.push(ev(1));
    expect(c.snapshot()).toEqual([]);
  });

  it('source has no fs, timers, or writes', () => {
    const src = readFileSync(new URL('./replayBuffer.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/node:fs|from 'fs'|writeFile|setInterval|setTimeout/);
  });
});
