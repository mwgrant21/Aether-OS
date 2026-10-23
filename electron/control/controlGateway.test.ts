// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { createControlGateway } from './controlGateway';
import { MESSAGE_TYPES } from './protocol';
import type { ControlIdentity, ControlSocket } from '../../src/shared/remote/types';

const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../protocol/mobile-protocol.json'), 'utf8'));
const vec = spec.proof.vectors;
const helloFrame: string = spec.frames.hello;

// Stub identity: the server proof (HMAC keyed by the raw SHA-256 digest of the token), built from the vector.
const key = createHash('sha256').update(vec.token, 'utf8').digest();
const identity: ControlIdentity = {
  ref: 'abcdef012345',
  expiresAtMs: 1792592000000,
  proofFor: (nonce) => createHmac('sha256', key).update(`server\n${nonce}\n/ctl`, 'utf8').digest('hex'),
};

function fakeSocket(): ControlSocket & { sent: string[]; closes: number[]; feed(t: string): void; drop(): void } {
  let onMsg: (t: string) => void = () => {};
  let onClose: () => void = () => {};
  const s = {
    sent: [] as string[],
    closes: [] as number[],
    send: (t: string) => { s.sent.push(t); },
    close: (c: number) => { s.closes.push(c); },
    bufferedBytes: () => 0,
    onMessage: (cb: (t: string) => void) => { onMsg = cb; },
    onClose: (cb: () => void) => { onClose = cb; },
    feed: (t: string) => onMsg(t),
    drop: () => onClose(),
  };
  return s;
}

describe('control gateway (hello only)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = (logs: string[] = []) =>
    createControlGateway({ now: () => 1790000000000, log: (m, r) => { logs.push(`${m}|${r}`); } });

  it('answers hello with a welcome whose proof is the T1 vector', () => {
    const s = fakeSocket();
    make().attach(s, identity);
    s.feed(helloFrame);
    expect(s.sent).toHaveLength(1);
    const w = JSON.parse(s.sent[0]);
    expect(w.t).toBe('welcome');
    expect(w.proof).toBe(vec.proof);
    expect(w.serverTimeMs).toBe(1790000000000);
    expect(w.expiresAtMs).toBe(identity.expiresAtMs);
    expect([w.sessions, w.applied, w.prompts]).toEqual([[], {}, []]);
    expect(s.closes).toEqual([]);
  });

  it('expired deadline sends bye policy and closes 1008', () => {
    const s = fakeSocket();
    make().attach(s, identity);
    vi.advanceTimersByTime(4999);
    expect(s.closes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.sent.map((x) => JSON.parse(x))).toEqual([{ t: 'bye', reason: 'policy' }]);
    expect(s.closes).toEqual([1008]);
  });

  it('cancels the deadline after hello', () => {
    const s = fakeSocket();
    make().attach(s, identity);
    s.feed(helloFrame);
    vi.advanceTimersByTime(60000);
    expect(s.closes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second hello is a policy violation', () => {
    const s = fakeSocket();
    make().attach(s, identity);
    s.feed(helloFrame);
    s.feed(helloFrame);
    expect(s.sent.map((x) => JSON.parse(x).t)).toEqual(['welcome', 'bye']);
    expect(s.closes).toEqual([1008]);
  });

  it('unknown verb kill closes 1008 and kill is not a declared message type', () => {
    const s = fakeSocket();
    make().attach(s, identity);
    s.feed('{"t":"kill"}');
    expect(s.closes).toEqual([1008]);
    expect((MESSAGE_TYPES.phoneToTitan as readonly string[]).includes('kill')).toBe(false);
  });

  it('unparseable and oversize frames close 1008', () => {
    const a = fakeSocket();
    make().attach(a, identity);
    a.feed('garbage');
    expect(a.closes).toEqual([1008]);
    const b = fakeSocket();
    make().attach(b, identity);
    b.feed(helloFrame + ' '.repeat(65537));
    expect(b.closes).toEqual([1008]);
    expect(b.sent.map((x) => JSON.parse(x).t)).toEqual(['bye']);
  });

  it('a frame of exactly 64 KiB is not rejected for size', () => {
    const s = fakeSocket();
    make().attach(s, identity);
    s.feed(helloFrame + ' '.repeat(65536 - helloFrame.length));
    expect(JSON.parse(s.sent[0]).t).toBe('welcome');
  });

  it('invalid epoch or nonce closes 1008 without a welcome', () => {
    for (const patch of [{ epoch: 'ZZ' }, { nonce: '1234' }]) {
      const s = fakeSocket();
      make().attach(s, identity);
      s.feed(JSON.stringify({ ...JSON.parse(helloFrame), ...patch }));
      expect(s.sent.map((x) => JSON.parse(x).t)).toEqual(['bye']);
      expect(s.closes).toEqual([1008]);
    }
  });

  it('close(reason) is idempotent, sends one bye, and uses 1000 for non-policy reasons', () => {
    const s = fakeSocket();
    const sess = make().attach(s, identity);
    sess.close('revoked');
    sess.close('disabled');
    expect(s.sent.map((x) => JSON.parse(x))).toEqual([{ t: 'bye', reason: 'revoked' }]);
    expect(s.closes).toEqual([1000]);
    expect(sess.ref).toBe(identity.ref);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('socket close cancels the timer and later frames are ignored', () => {
    const s = fakeSocket();
    make().attach(s, identity);
    s.drop();
    expect(vi.getTimerCount()).toBe(0);
    s.feed(helloFrame);
    vi.advanceTimersByTime(10000);
    expect(s.sent).toEqual([]);
    expect(s.closes).toEqual([]);
  });

  it('honours injected timer functions and a custom hello timeout', () => {
    const set = vi.fn((fn: () => void, ms: number) => { void fn; return ms; });
    const clear = vi.fn();
    const s = fakeSocket();
    createControlGateway({ now: () => 0, setTimeoutFn: set, clearTimeoutFn: clear, helloTimeoutMs: 123 }).attach(s, identity);
    expect(set).toHaveBeenCalledWith(expect.any(Function), 123);
    s.feed(helloFrame);
    expect(clear).toHaveBeenCalledWith(123);
  });

  it('a deadline callback that fires after hello or close does nothing', () => {
    const fns: Array<() => void> = [];
    const mk = () => createControlGateway({ now: () => 0, setTimeoutFn: (fn) => { fns.push(fn); return fns.length; }, clearTimeoutFn: () => {} });
    const a = fakeSocket();
    mk().attach(a, identity);
    a.feed(helloFrame);
    fns[0]();
    expect(a.sent).toHaveLength(1); // only the welcome
    expect(a.closes).toEqual([]);
    const b = fakeSocket();
    const sb = mk().attach(b, identity);
    sb.close('disabled');
    fns[1]();
    expect(b.sent.map((x) => JSON.parse(x))).toEqual([{ t: 'bye', reason: 'disabled' }]);
    expect(b.closes).toEqual([1000]);
  });

  it('close() still closes the socket when sending the bye throws', () => {
    const s = fakeSocket();
    s.send = () => { throw new Error('socket gone'); };
    const session = make().attach(s, identity);
    expect(() => session.close('revoked')).toThrow('socket gone');
    expect(s.closes).toEqual([1000]);
    expect(() => session.close('revoked')).not.toThrow(); // idempotent afterwards
  });

  it('logs fixed strings with the ref only, never the nonce, proof or token', () => {
    const logs: string[] = [];
    const s = fakeSocket();
    make(logs).attach(s, identity);
    s.feed(helloFrame);
    s.feed(helloFrame);
    const all = logs.join('\n');
    expect(all).toContain(identity.ref);
    for (const secret of [vec.nonce, vec.proof, vec.token, vec.tokenSha256Hex]) expect(all).not.toContain(secret);
  });
});
