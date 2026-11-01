// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ClientMessage, ServerEvent, VoiceGatewayCore, VoiceSocket } from './protocol';
import { createEventLog } from './eventLog';
import { createVoiceConnections } from './voiceConnection';

const SID = 'sess-1';
const TID = 'turn-0001';

function ev(seq: number, extra: Record<string, unknown> = {}): ServerEvent {
  return { t: 'response.delta', text: `d${seq}`, sessionId: SID, turnId: TID, seq, ...extra } as ServerEvent;
}

function fakeSocket() {
  const sent: any[] = [];
  const closes: number[] = [];
  let onMsg: (t: string) => void = () => {};
  let onClose: () => void = () => {};
  let buffered = 0;
  const socket: VoiceSocket = {
    send: (t) => void sent.push(JSON.parse(t)),
    close: (c) => void closes.push(c),
    bufferedBytes: () => buffered,
    onMessage: (cb) => void (onMsg = cb),
    onClose: (cb) => void (onClose = cb),
  };
  return {
    socket,
    sent,
    closes,
    say: (m: unknown) => onMsg(typeof m === 'string' ? m : JSON.stringify(m)),
    drop: () => onClose(),
    setBuffered: (n: number) => void (buffered = n),
  };
}

function fakeGateway() {
  const log: ServerEvent[] = [];
  const listeners = new Set<(e: ServerEvent) => void>();
  const handled: ClientMessage[] = [];
  const g = {
    sid: SID,
    st: 'ready' as const,
    // Runs inside replayAfter, before the result is computed: models an emit racing the replay.
    duringReplay: null as null | (() => void),
    replayResult: null as null | ReturnType<VoiceGatewayCore['replayAfter']>,
    emit(e: ServerEvent) {
      log.push(e);
      for (const l of [...listeners]) l(e);
    },
  };
  const core: VoiceGatewayCore = {
    sessionId: () => g.sid,
    state: () => g.st,
    handle: (m) => void handled.push(m),
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    replayAfter: (n) => {
      g.duringReplay?.();
      if (g.replayResult) return g.replayResult;
      return { ok: true, events: log.filter((e) => e.seq > n) };
    },
    stop: async () => {},
  };
  return { g, core, log, handled, listenerCount: () => listeners.size };
}

const FIRST = { t: 'permission.reply', id: 'p0', approve: false };

function setup(opts: { slow?: number } = {}) {
  const gw = fakeGateway();
  const lines: string[] = [];
  const conns = createVoiceConnections({ gateway: gw.core, log: (l) => lines.push(l), slowConsumerBytes: opts.slow });
  return { ...gw, conns, lines };
}

describe('attach', () => {
  it('sends one seq:0 status frame and then forwards live events', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    a.say(FIRST);
    expect(a.sent).toEqual([{ t: 'status', kind: 'session', state: 'ready', sessionId: SID, turnId: null, seq: 0 }]);
    s.g.emit(ev(1));
    expect(a.sent[1]).toMatchObject({ t: 'response.delta', seq: 1 });
    expect(s.conns.count()).toBe(1);
  });

  it('replaces the first connection: error replaced then close 4000, new one proceeds', () => {
    const s = setup();
    const a = fakeSocket();
    const b = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    s.conns.attach(b.socket, { ref: 'c2' });
    expect(a.sent[1]).toMatchObject({ t: 'error', code: 'replaced', retryable: false });
    expect(a.closes).toEqual([4000]);
    expect(s.listenerCount()).toBe(1);
    b.say(FIRST);
    s.g.emit(ev(1));
    expect(a.sent).toHaveLength(2);
    expect(b.sent[1]).toMatchObject({ seq: 1 });
    expect(s.conns.count()).toBe(1);
    a.drop(); // late close of the replaced socket must not free the new slot
    expect(s.conns.count()).toBe(1);
  });
});

describe('resume', () => {
  it('ok: replays events after lastSeq in order, then continues live', () => {
    const s = setup();
    s.log.push(ev(1), ev(2), ev(3));
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    a.say({ t: 'resume', lastSeq: 1, sessionId: SID });
    expect(a.sent.slice(1).map((e) => e.seq)).toEqual([2, 3]);
    s.g.emit(ev(4));
    expect(a.sent.slice(1).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(s.listenerCount()).toBe(1);
  });

  it('delivers each event exactly once when the gateway emits during the replay step', () => {
    const s = setup();
    s.log.push(ev(1), ev(2));
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    s.g.duringReplay = () => {
      s.g.duringReplay = null;
      s.g.emit(ev(3)); // logged AND offered to listeners, inside the resume step
    };
    a.say({ t: 'resume', lastSeq: 0 });
    s.g.emit(ev(4));
    const seqs = a.sent.slice(1).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('gap: error resume_gap, cancels the in-flight turn, stays live', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    s.g.emit({ t: 'turn.started', sessionId: SID, turnId: TID, seq: 1 });
    s.g.replayResult = { ok: false, reason: 'gap' };
    a.say({ t: 'resume', lastSeq: 0 });
    expect(a.sent.find((e) => e.t === 'error')).toMatchObject({ code: 'resume_gap', retryable: true });
    expect(s.handled).toEqual([{ t: 'turn.cancel', turnId: TID, spokenText: '' }]);
    s.g.emit(ev(2));
    expect(a.sent.at(-1)).toMatchObject({ seq: 2 });
  });

  it('gap with no turn in flight sends no cancel', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    s.g.replayResult = { ok: false, reason: 'gap' };
    a.say({ t: 'resume', lastSeq: 0 });
    expect(s.handled).toEqual([]);
  });

  it('ahead: error bad_message without closing', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    s.g.replayResult = { ok: false, reason: 'ahead' };
    a.say({ t: 'resume', lastSeq: 99 });
    expect(a.sent.at(-1)).toMatchObject({ t: 'error', code: 'bad_message' });
    expect(a.closes).toEqual([]);
  });

  it('session_changed when the sessionId differs; no replay', () => {
    const s = setup();
    s.log.push(ev(1));
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    a.say({ t: 'resume', lastSeq: 0, sessionId: 'other' });
    expect(a.sent.at(-1)).toMatchObject({ t: 'error', code: 'session_changed', retryable: false });
    expect(a.sent).toHaveLength(2);
  });
});

describe('messages and close', () => {
  it('forwards valid non-resume messages to the gateway', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    a.say({ t: 'permission.reply', id: 'p1', approve: true });
    expect(s.handled).toEqual([{ t: 'permission.reply', id: 'p1', approve: true }]);
  });

  it('bad message: error bad_message, close 1008, frame never echoed', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    a.say('{"t":"nope","secret":"SENTINEL-xyz"}');
    expect(a.sent.at(-1)).toMatchObject({ t: 'error', code: 'bad_message' });
    expect(a.closes).toEqual([1008]);
    expect(JSON.stringify(a.sent)).not.toContain('SENTINEL');
    expect(s.lines.join('\n')).not.toContain('SENTINEL');
    expect(s.listenerCount()).toBe(0);
    expect(s.handled).toEqual([]);
  });

  it('slow consumer: closes 1013 and stops delivering', () => {
    const s = setup({ slow: 100 });
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    a.say(FIRST);
    a.setBuffered(101);
    s.g.emit(ev(1));
    expect(a.closes).toEqual([1013]);
    expect(a.sent).toHaveLength(1);
    expect(s.listenerCount()).toBe(0);
    expect(s.conns.count()).toBe(0);
  });

  it('unsubscribes and frees the slot on close', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    expect(s.listenerCount()).toBe(1);
    a.drop();
    expect(s.listenerCount()).toBe(0);
    expect(s.conns.count()).toBe(0);
  });

  it('closeAll and the attach handle use 1001 for disabled and 4001 for revoked', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    s.conns.closeAll('disabled');
    expect(a.closes).toEqual([1001]);
    expect(s.conns.count()).toBe(0);
    const b = fakeSocket();
    s.conns.attach(b.socket, { ref: 'c2' });
    s.conns.closeAll('revoked');
    expect(b.closes).toEqual([4001]);
    const c = fakeSocket();
    const h = s.conns.attach(c.socket, { ref: 'c3' });
    h.close('revoked');
    expect(c.closes).toEqual([4001]);
    expect(s.listenerCount()).toBe(0);
  });

  it('logs only fixed strings with the ref', () => {
    const s = setup();
    const a = fakeSocket();
    s.conns.attach(a.socket, { ref: 'c1' });
    s.g.emit(ev(1, { text: 'PRIVATE-REPLY' }));
    a.drop();
    expect(s.lines.join('\n')).not.toContain('PRIVATE');
    expect(s.lines.every((l) => l.startsWith('voice: '))).toBe(true);
  });
});

describe('exactly-once with a real event log', () => {
  function real() {
    const elog = createEventLog();
    const listeners = new Set<(e: ServerEvent) => void>();
    const handled: ClientMessage[] = [];
    const core: VoiceGatewayCore = {
      sessionId: () => elog.sessionId,
      state: () => 'ready',
      handle: (m) => {
        handled.push(m);
        if (m.t === 'turn.start' && !busy) {
          busy = true;
          emit(elog.append(m.turnId, { t: 'turn.started' }));
        }
      },
      subscribe: (l) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      replayAfter: (n) => elog.after(n),
      stop: async () => {},
    };
    let busy = false;
    function emit(e: ServerEvent) {
      for (const l of [...listeners]) l(e);
    }
    const out = {
      elog,
      handled,
      push: () => emit(elog.append(TID, { t: 'response.delta', text: 'x' })),
    };
    const conns = createVoiceConnections({ gateway: core });
    return { ...out, conns };
  }
  const seqsOf = (a: { sent: any[] }) => a.sent.filter((e) => e.seq > 0).map((e) => e.seq as number);
  const expectClean = (seqs: number[], from: number, to: number) => {
    expect(seqs).toEqual(Array.from({ length: to - from + 1 }, (_, i) => from + i));
  };

  // 8 events logged before attach, 9 and 10 emitted between attach and the first frame, 11 after resume.
  it.each([0, 5, 8, 9, 10])('first frame resume lastSeq=%i: gapless, increasing, no duplicates', (lastSeq) => {
    const r = real();
    for (let i = 0; i < 8; i++) r.push();
    const a = fakeSocket();
    r.conns.attach(a.socket, { ref: 'c1' });
    r.push();
    r.push();
    a.say({ t: 'resume', lastSeq });
    r.push();
    expectClean(seqsOf(a), lastSeq + 1, 11);
  });

  it('a client that never resumes gets every event after attach once, in order', () => {
    const r = real();
    for (let i = 0; i < 8; i++) r.push();
    const a = fakeSocket();
    r.conns.attach(a.socket, { ref: 'c1' });
    r.push();
    r.push();
    a.say({ t: 'permission.reply', id: 'p1', approve: true });
    r.push();
    expectClean(seqsOf(a), 9, 11);
  });

  it('a stale second resume does not re-send events already delivered', () => {
    const r = real();
    const a = fakeSocket();
    r.conns.attach(a.socket, { ref: 'c1' });
    for (let i = 0; i < 4; i++) r.push();
    a.say({ t: 'resume', lastSeq: 0 });
    a.say({ t: 'resume', lastSeq: 0 });
    r.push();
    a.say({ t: 'resume', lastSeq: 2 });
    expectClean(seqsOf(a), 1, 5);
  });

  it('a busy second turn.start does not displace the in-flight turn for gap cancel', () => {
    const elog = createEventLog({ maxBytes: 200 });
    const handled: ClientMessage[] = [];
    let l: ((e: ServerEvent) => void) | null = null;
    const core: VoiceGatewayCore = {
      sessionId: () => elog.sessionId,
      state: () => 'ready',
      handle: (m) => {
        handled.push(m);
        if (m.t === 'turn.start' && m.turnId === 'turn-AAAA') l?.(elog.append(m.turnId, { t: 'turn.started' }));
      },
      subscribe: (cb) => ((l = cb), () => void (l = null)),
      replayAfter: (n) => elog.after(n),
      stop: async () => {},
    };
    const conns = createVoiceConnections({ gateway: core });
    const a = fakeSocket();
    conns.attach(a.socket, { ref: 'c1' });
    a.say({ t: 'turn.start', turnId: 'turn-AAAA', text: 'one', mode: 'voice' });
    a.say({ t: 'turn.start', turnId: 'turn-BBBB', text: 'two', mode: 'voice' }); // gateway answers busy: no event
    for (let i = 0; i < 20; i++) l?.(elog.append('turn-AAAA', { t: 'response.delta', text: 'y'.repeat(30) }));
    a.say({ t: 'resume', lastSeq: 0 });
    expect(a.sent.some((e) => e.code === 'resume_gap')).toBe(true);
    expect(handled.at(-1)).toEqual({ t: 'turn.cancel', turnId: 'turn-AAAA', spokenText: '' });
  });
});
