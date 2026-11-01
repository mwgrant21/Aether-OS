import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPhoneViewPublisher } from './usePhoneViewPublisher';
import type { AetherState } from './types';

afterEach(() => { vi.useRealTimers(); });
const st = (n: number) => ({ n }) as unknown as AetherState;
const nOf = (s: AetherState) => (s as unknown as { n: number }).n;

describe('createPhoneViewPublisher', () => {
  it('publishes nothing with an empty registry', () => {
    const pub = vi.fn();
    createPhoneViewPublisher({}, pub).update(st(1));
    expect(pub).not.toHaveBeenCalled();
  });

  it('publishes only on change (structural compare)', () => {
    vi.useFakeTimers();
    const pub = vi.fn();
    const p = createPhoneViewPublisher({ dash: s => ({ x: { n: nOf(s) } }) }, pub, { now: () => Date.now() });
    p.update(st(1));
    vi.advanceTimersByTime(2000);
    p.update(st(1)); // new state object, equal payload
    vi.advanceTimersByTime(2000);
    p.update(st(2));
    expect(pub.mock.calls).toEqual([['dash', { x: { n: 1 } }], ['dash', { x: { n: 2 } }]]);
  });

  it('throttles to once a second per view and sends the newest state after the gap', () => {
    vi.useFakeTimers();
    const pub = vi.fn();
    const p = createPhoneViewPublisher({ dash: s => ({ n: nOf(s) }) }, pub, { now: () => Date.now() });
    p.update(st(1));
    p.update(st(2));
    p.update(st(3));
    expect(pub.mock.calls).toEqual([['dash', { n: 1 }]]);
    vi.advanceTimersByTime(999);
    expect(pub).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(pub.mock.calls[1]).toEqual(['dash', { n: 3 }]);
    p.dispose();
  });

  it('skips a builder that returns null or throws, and dispose cancels a pending send', () => {
    vi.useFakeTimers();
    const pub = vi.fn();
    const p = createPhoneViewPublisher({ dash: () => null, agents: () => { throw new Error('x'); } }, pub, { now: () => Date.now() });
    expect(() => p.update(st(1))).not.toThrow();
    expect(pub).not.toHaveBeenCalled();
    const q = createPhoneViewPublisher({ dash: s => ({ n: nOf(s) }) }, pub, { now: () => Date.now() });
    q.update(st(1)); q.update(st(2)); q.dispose();
    vi.advanceTimersByTime(5000);
    expect(pub).toHaveBeenCalledTimes(1);
  });
});
