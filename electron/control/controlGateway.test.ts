// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { createControlGateway } from './controlGateway';
import { MESSAGE_TYPES } from './protocol';
import type { ControlIdentity, ControlSocket, TerminalInfo, TerminalReadPort, TerminalSlotId, TerminalSlotState, TerminalTap } from '../../src/shared/remote/types';

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

interface FakeAttach { s: TerminalSlotId; lastQ: number | null; tap: TerminalTap; detaches: number }
function fakePort(info: TerminalInfo[] = []) {
  const attaches: FakeAttach[] = [];
  const stateCbs: Array<(e: { s: TerminalSlotId; state: TerminalSlotState }) => void> = [];
  const calls: string[] = [];
  let unsubs = 0;
  let failDetach = false;
  const port: TerminalReadPort = {
    list: () => { calls.push('list'); return info; },
    attach: (s, lastQ, tap) => {
      calls.push('attach');
      const rec: FakeAttach = { s, lastQ, tap, detaches: 0 };
      attaches.push(rec);
      return { detach: () => { rec.detaches += 1; if (failDetach) throw new Error("detach failed"); } };
    },
    onState: (cb) => { calls.push('onState'); stateCbs.push(cb); return () => { unsubs += 1; }; },
    retain: () => { throw new Error('the gateway must never retain'); },
  };
  return { port, attaches, stateCbs, calls, unsubs: () => unsubs, failDetach: () => { failDetach = true; } };
}
const INFO: TerminalInfo[] = [
  { s: 'claude', label: 'Terminal', state: 'running', cols: 100, rows: 30, q: 12 },
  { s: 'terminal2', label: 'Terminal 2', state: 'not-started', cols: 0, rows: 0, q: 0 },
  { s: 'codex', label: 'Codex', state: 'exited', cols: 80, rows: 24, q: 5 },
];
const attachFrame = (s: string, q?: number): string => JSON.stringify(q === undefined ? { t: 'attach', s } : { t: 'attach', s, q });
const detachFrame = (s: string): string => JSON.stringify({ t: 'detach', s });

describe('control gateway terminal verbs', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(info: TerminalInfo[] = INFO) {
    const logs: string[] = [];
    const fp = fakePort(info);
    const gw = createControlGateway({ now: () => 1790000000000, log: (m, r) => { logs.push(`${m}|${r}`); }, terminals: fp.port });
    const s = fakeSocket();
    const session = gw.attach(s, identity);
    return { fp, s, session, logs };
  }

  it('welcome carries list() byte for byte and precedes the state subscription', () => {
    const { fp, s } = setup();
    s.feed(helloFrame);
    expect(s.sent).toEqual([spec.frames.welcomeSessions]);
    expect(fp.calls).toEqual(['list', 'onState']);
    fp.stateCbs[0]({ s: 'codex', state: 'running' });
    expect(s.sent.map((x) => JSON.parse(x).t)).toEqual(['welcome', 'state']);
    expect(s.sent[1]).toBe(JSON.stringify({ t: 'state', s: 'codex', state: 'running' }));
  });

  it('attach or detach before hello is bye policy 1008 and never reaches the port', () => {
    for (const frame of [attachFrame('claude'), detachFrame('claude')]) {
      const { fp, s } = setup();
      s.feed(frame);
      expect(s.sent.map((x) => JSON.parse(x))).toEqual([{ t: 'bye', reason: 'policy' }]);
      expect(s.closes).toEqual([1008]);
      expect(fp.calls).toEqual([]);
    }
  });

  it('attach passes q, and null when absent; a bad slot or q is a violation', () => {
    const { fp, s } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    s.feed(attachFrame('codex', 77));
    expect(fp.attaches.map((a) => [a.s, a.lastQ])).toEqual([['claude', null], ['codex', 77]]);
    expect(s.closes).toEqual([]);
    s.feed('{"t":"attach","s":"claude","q":"7"}');
    expect(s.closes).toEqual([1008]);
    expect(fp.attaches).toHaveLength(2);
  });

  it('tap callbacks produce exactly the golden frames, in order', () => {
    const { fp, s } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    const tap = fp.attaches[0].tap;
    tap.snap({ q: 124, cols: 100, rows: 30, d: '\u001b[1mhi\u001b[0m\r\n' });
    tap.out({ q: 125, d: '\u001b[32mok\u001b[0m\r\n' });
    tap.size({ cols: 120, rows: 40 });
    expect(s.sent.slice(1)).toEqual([spec.frames.snap, spec.frames.out, spec.frames.size]);
  });

  it('re-attach of the same slot detaches the first, whose later callbacks send nothing', () => {
    const { fp, s } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    s.feed(attachFrame('claude', 9));
    expect(fp.attaches.map((a) => a.detaches)).toEqual([1, 0]);
    const before = s.sent.length;
    fp.attaches[0].tap.out({ q: 1, d: 'stale' });
    expect(s.sent).toHaveLength(before);
    fp.attaches[1].tap.out({ q: 10, d: 'fresh' });
    expect(s.sent).toHaveLength(before + 1);
  });

  it('detach stops frames; detaching a slot that is not attached is silent', () => {
    const { fp, s } = setup();
    s.feed(helloFrame);
    s.feed(detachFrame('codex'));
    expect(s.closes).toEqual([]);
    expect(s.sent).toHaveLength(1);
    s.feed(attachFrame('claude'));
    s.feed(detachFrame('claude'));
    expect(fp.attaches[0].detaches).toBe(1);
    fp.attaches[0].tap.out({ q: 1, d: 'late' });
    expect(s.sent).toHaveLength(1);
    s.feed(detachFrame('claude'));
    expect(fp.attaches[0].detaches).toBe(1);
  });

  it('socket close detaches every attachment and unsubscribes onState; later callbacks send nothing', () => {
    const { fp, s } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    s.feed(attachFrame('codex'));
    s.drop();
    expect(fp.attaches.map((a) => a.detaches)).toEqual([1, 1]);
    expect(fp.unsubs()).toBe(1);
    fp.attaches[0].tap.out({ q: 1, d: 'x' });
    fp.stateCbs[0]({ s: 'claude', state: 'exited' });
    expect(s.sent).toHaveLength(1);
  });

  it('close(reason) tears down the same way and sends the bye after detaching', () => {
    const { fp, s, session } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    session.close('revoked');
    expect(fp.attaches[0].detaches).toBe(1);
    expect(fp.unsubs()).toBe(1);
    expect(s.sent.map((x) => JSON.parse(x).t)).toEqual(['welcome', 'bye']);
    fp.attaches[0].tap.snap({ q: 1, cols: 1, rows: 1, d: '' });
    fp.stateCbs[0]({ s: 'claude', state: 'exited' });
    expect(s.sent).toHaveLength(2);
    session.close('disabled');
    expect(fp.unsubs()).toBe(1);
  });

  it('a throwing detach does not stop teardown of the others or the bye', () => {
    const { fp, s, session } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    s.feed(attachFrame('codex'));
    fp.failDetach();
    session.close('disabled');
    expect(fp.attaches.map((a) => a.detaches)).toEqual([1, 1]);
    expect(fp.unsubs()).toBe(1);
    expect(s.sent.map((x) => JSON.parse(x).t)).toEqual(['welcome', 'bye']);
    expect(s.closes).toEqual([1000]);
  });

  it('state broadcast reaches a ready socket and not one that has not said hello', () => {
    const fp = fakePort(INFO);
    const gw = createControlGateway({ now: () => 0, terminals: fp.port });
    const ready = fakeSocket();
    const waiting = fakeSocket();
    gw.attach(ready, identity);
    gw.attach(waiting, identity);
    ready.feed(helloFrame);
    expect(fp.stateCbs).toHaveLength(1);
    fp.stateCbs[0]({ s: 'terminal2', state: 'running' });
    expect(ready.sent.map((x) => JSON.parse(x).t)).toEqual(['welcome', 'state']);
    expect(waiting.sent).toEqual([]);
  });

  it('every verb that belongs to a later slice is still bye policy', () => {
    for (const verb of ['in', 'resize', 'start', 'prompt.respond', 'resync', 'ping']) {
      const { fp, s } = setup();
      s.feed(helloFrame);
      s.feed(JSON.stringify({ t: verb, s: 'claude' }));
      expect(s.sent.map((x) => JSON.parse(x).t)).toEqual(['welcome', 'bye']);
      expect(s.closes).toEqual([1008]);
      expect(fp.attaches).toEqual([]);
    }
  });

  it('frames after bye are not sent (taps and state alike)', () => {
    const { fp, s } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    s.feed('garbage');
    expect(s.sent.map((x) => JSON.parse(x).t)).toEqual(['welcome', 'bye']);
    fp.attaches[0].tap.out({ q: 1, d: 'x' });
    fp.stateCbs[0]({ s: 'claude', state: 'exited' });
    s.feed(attachFrame('codex'));
    expect(s.sent).toHaveLength(2);
    expect(fp.attaches).toHaveLength(1);
  });

  it('without a port: sessions stay empty and attach is bye policy', () => {
    const s = fakeSocket();
    createControlGateway({ now: () => 0 }).attach(s, identity);
    s.feed(helloFrame);
    expect(JSON.parse(s.sent[0]).sessions).toEqual([]);
    s.feed(attachFrame('claude'));
    expect(s.sent.map((x) => JSON.parse(x).t)).toEqual(['welcome', 'bye']);
    expect(s.closes).toEqual([1008]);
  });

  it('logs fixed strings: mode is what the tap saw first, detach names the slot, no terminal data', () => {
    const { fp, s, logs } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    s.feed(attachFrame('codex', 5));
    fp.attaches[0].tap.snap({ q: 1, cols: 1, rows: 1, d: 'SECRET-SCREEN' });
    fp.attaches[0].tap.out({ q: 2, d: 'SECRET-OUT' });
    fp.attaches[1].tap.size({ cols: 9, rows: 9 });
    fp.attaches[1].tap.out({ q: 6, d: 'SECRET-RESUME' });
    s.feed(detachFrame('claude'));
    expect(logs).toEqual([
      `control: hello accepted|${identity.ref}`,
      `control: attach slot=claude mode=snap|${identity.ref}`,
      `control: attach slot=codex mode=resume|${identity.ref}`,
      `control: detach slot=claude|${identity.ref}`,
    ]);
    expect(logs.join('\n')).not.toContain('SECRET');
  });

  it('the gateway only calls list/attach/onState on the port', () => {
    const { fp, s } = setup();
    s.feed(helloFrame);
    s.feed(attachFrame('claude'));
    s.feed(detachFrame('claude'));
    s.drop();
    expect(new Set(fp.calls)).toEqual(new Set(['list', 'onState', 'attach']));
  });
});
