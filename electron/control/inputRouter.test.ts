// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createInputRouter } from './inputRouter';
import type { TerminalSlotId } from '../../src/shared/remote/types';

function setup(running = true) {
  const writes: Array<[TerminalSlotId, string]> = [];
  const logs: string[] = [];
  let t = 1000;
  const router = createInputRouter({
    terminals: { write: (s, d) => { if (!running) return false; writes.push([s, d]); return true; } },
    now: () => t,
    log: (m) => { logs.push(m); },
  });
  return { router, writes, logs, tick: (ms: number) => { t += ms; } };
}

describe('inputRouter', () => {
  it('applies in-order frames with exactly one write each, carrying the exact string', () => {
    const { router, writes } = setup();
    const s = router.open('dev', 'e1');
    expect(s.input('claude', 1, 'ls\r')).toEqual({ kind: 'applied', ack: 1 });
    expect(s.input('claude', 2, '\x03')).toEqual({ kind: 'applied', ack: 2 });
    expect(writes).toEqual([['claude', 'ls\r'], ['claude', '\x03']]);
  });

  it('re-acks a duplicate without writing', () => {
    const { router, writes } = setup();
    const s = router.open('dev', 'e1');
    s.input('claude', 1, 'a');
    s.input('claude', 2, 'b');
    expect(s.input('claude', 2, 'b')).toEqual({ kind: 'duplicate', ack: 2 });
    expect(s.input('claude', 1, 'a')).toEqual({ kind: 'duplicate', ack: 2 });
    expect(writes).toHaveLength(2);
  });

  it('treats a gap as a violation and writes nothing', () => {
    const { router, writes } = setup();
    const s = router.open('dev', 'e1');
    s.input('claude', 1, 'a');
    expect(s.input('claude', 3, 'c')).toEqual({ kind: 'violation', why: 'control: input gap' });
    expect(writes).toHaveLength(1);
  });

  it('keeps counters per slot', () => {
    const { router } = setup();
    const s = router.open('dev', 'e1');
    s.input('claude', 1, 'a');
    expect(s.input('codex', 1, 'a')).toEqual({ kind: 'applied', ack: 1 });
    expect(s.applied()).toEqual({ claude: 1, codex: 1 });
  });

  it('resets counters when the epoch changes', () => {
    const { router, writes } = setup();
    router.open('dev', 'e1').input('claude', 1, 'a');
    const s2 = router.open('dev', 'e2');
    expect(s2.applied()).toEqual({});
    expect(s2.input('claude', 1, 'b')).toEqual({ kind: 'applied', ack: 1 });
    expect(writes).toHaveLength(2);
  });

  it('resumes counters for a second session of the same device and epoch', () => {
    const { router } = setup();
    router.open('dev', 'e1').input('claude', 1, 'a');
    const s2 = router.open('dev', 'e1');
    expect(s2.applied()).toEqual({ claude: 1 });
    expect(s2.input('claude', 1, 'a')).toEqual({ kind: 'duplicate', ack: 1 });
  });

  it('rejects oversize, empty and lone-surrogate input without writing', () => {
    const { router, writes } = setup();
    const s = router.open('dev', 'e1');
    const bad = { kind: 'violation', why: 'control: invalid input' };
    expect(s.input('claude', 1, 'x'.repeat(8193))).toEqual(bad);
    expect(s.input('claude', 1, '\ud800')).toEqual(bad);
    expect(s.input('claude', 1, '')).toEqual(bad);
    expect(writes).toHaveLength(0);
  });

  it('rate-limits the 101st frame in a second before writing it', () => {
    const { router, writes } = setup();
    const s = router.open('dev', 'e1');
    for (let c = 1; c <= 100; c++) expect(s.input('claude', c, 'a').kind).toBe('applied');
    expect(s.input('claude', 101, 'a')).toEqual({ kind: 'rate-limit' });
    expect(writes).toHaveLength(100);
  });

  it('rate-limits on bytes: 40 frames of 8 KB trips the 256 KB cap', () => {
    const { router, writes } = setup();
    const s = router.open('dev', 'e1');
    const kinds: string[] = [];
    for (let c = 1; c <= 40; c++) kinds.push(s.input('claude', c, 'x'.repeat(8192)).kind);
    expect(kinds.slice(0, 32).every((k) => k === 'applied')).toBe(true);
    expect(kinds[32]).toBe('rate-limit');
    expect(writes).toHaveLength(32);
  });

  it('rolls the window over after one second', () => {
    const { router, tick } = setup();
    const s = router.open('dev', 'e1');
    for (let c = 1; c <= 100; c++) s.input('claude', c, 'a');
    expect(s.input('claude', 101, 'a').kind).toBe('rate-limit');
    tick(1000);
    expect(s.input('claude', 101, 'a')).toEqual({ kind: 'applied', ack: 101 });
  });

  it('acks a frame for a non-running slot, writes nothing and logs one dropped line', () => {
    const { router, writes, logs } = setup(false);
    const s = router.open('dev', 'e1');
    expect(s.input('claude', 1, 'a')).toEqual({ kind: 'applied', ack: 1 });
    expect(s.input('claude', 2, 'b')).toEqual({ kind: 'applied', ack: 2 });
    expect(writes).toHaveLength(0);
    expect(logs.filter((l) => l.startsWith('control: input dropped'))).toEqual(['control: input dropped slot=claude']);
  });

  it('logs the first input as a byte count only, never the data', () => {
    const { router, logs } = setup();
    const s = router.open('dev', 'e1');
    s.input('claude', 1, 'HUNTER2-SENTINEL');
    s.input('claude', 2, 'HUNTER2-SENTINEL');
    expect(logs).toEqual(['control: first input slot=claude bytes=16']);
    expect(logs.join('\n')).not.toContain('HUNTER2');
  });

  it('never logs the data on the dropped line either', () => {
    const { router, logs } = setup(false);
    router.open('dev', 'e1').input('claude', 1, 'HUNTER2-SENTINEL');
    expect(logs.join('\n')).not.toContain('HUNTER2');
  });
});
