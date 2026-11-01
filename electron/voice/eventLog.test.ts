// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createEventLog } from './eventLog';

const delta = (text: string) => ({ t: 'response.delta' as const, text });

describe('eventLog', () => {
  it('seq starts at 1 and is gapless across 1000 appends', () => {
    const log = createEventLog({ maxBytes: 1 << 20 });
    for (let i = 1; i <= 1000; i++) expect(log.append('turn-0001', delta('x')).seq).toBe(i);
    expect(log.lastSeq).toBe(1000);
    const r = log.after(0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.events.map((e) => e.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
  });

  it('evicts oldest at the byte bound: after(0) is gap, after(lastSeq-3) is 3 events', () => {
    const log = createEventLog({ maxBytes: 1000 });
    for (let i = 0; i < 100; i++) log.append(null, delta('y'.repeat(50)));
    expect(log.after(0)).toEqual({ ok: false, reason: 'gap' });
    const r = log.after(log.lastSeq - 3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.events.map((e) => e.seq)).toEqual([98, 99, 100]);
  });

  it('after() is either a gapless run from n+1 or gap, exact at the eviction edge', () => {
    const log = createEventLog({ maxBytes: 1000 });
    for (let i = 0; i < 100; i++) log.append(null, delta('y'.repeat(50)));
    let firstOk = -1;
    for (let n = 0; n <= log.lastSeq; n++) {
      const r = log.after(n);
      if (r.ok) {
        if (firstOk < 0) firstOk = n;
        expect(r.events.map((e) => e.seq)).toEqual(
          Array.from({ length: log.lastSeq - n }, (_, i) => n + 1 + i),
        );
      } else {
        expect(firstOk).toBe(-1);
      }
    }
    // firstOk is exactly (oldest buffered seq) - 1: the event right after it is held, the one before is not.
    expect(firstOk).toBeGreaterThan(0);
    const r = log.after(firstOk);
    expect(r.ok && r.events[0].seq).toBe(firstOk + 1);
    expect(log.after(firstOk - 1)).toEqual({ ok: false, reason: 'gap' });
  });

  it('after(lastSeq) is ok and empty; after(lastSeq+1) is ahead', () => {
    const log = createEventLog();
    expect(log.after(0)).toEqual({ ok: true, events: [] });
    log.append(null, delta('a'));
    expect(log.after(1)).toEqual({ ok: true, events: [] });
    expect(log.after(2)).toEqual({ ok: false, reason: 'ahead' });
  });

  it('counts multi-byte text in bytes', () => {
    const text = 'é'.repeat(100);
    const one = JSON.stringify({ t: 'response.delta', text, sessionId: 's', turnId: null, seq: 1 });
    expect(Buffer.byteLength(one)).toBeGreaterThan(one.length);
    const log = createEventLog({ maxBytes: Buffer.byteLength(one) * 2 - 1, newId: () => 's' });
    log.append(null, delta(text));
    log.append(null, delta(text));
    // by char length both would fit; by bytes the first is evicted
    expect(log.after(0)).toEqual({ ok: false, reason: 'gap' });
    expect(log.after(1).ok).toBe(true);
  });

  it('an event larger than the buffer is dropped and later after() reports gap', () => {
    const log = createEventLog({ maxBytes: 200 });
    log.append(null, delta('z'.repeat(500)));
    expect(log.after(0)).toEqual({ ok: false, reason: 'gap' });
  });

  it('two logs have different sessionIds and events carry it', () => {
    const a = createEventLog();
    const b = createEventLog();
    expect(a.sessionId).not.toBe(b.sessionId);
    const e = a.append('turn-0001', { t: 'turn.started' });
    expect(e).toMatchObject({ sessionId: a.sessionId, turnId: 'turn-0001', seq: 1, t: 'turn.started' });
  });

  it('clear() empties the buffer but keeps lastSeq monotonic', () => {
    const log = createEventLog();
    log.append(null, delta('a'));
    log.append(null, delta('b'));
    log.clear();
    expect(log.lastSeq).toBe(2);
    expect(log.after(1)).toEqual({ ok: false, reason: 'gap' });
    expect(log.append(null, delta('c')).seq).toBe(3);
  });
});
