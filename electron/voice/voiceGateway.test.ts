// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from './protocol';
import { createVoiceGateway, type SessionLike } from './voiceGateway';
import type { SessionEvent } from './voiceSession';

const KEY = 'sk-ant-' + 'Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7xC0';

function fakeSession(initial: ReturnType<SessionLike['state']> = 'ready') {
  const cbs = new Set<(e: SessionEvent) => void>();
  const s = {
    st: initial,
    sent: [] as Array<{ id: string; text: string }>,
    interrupts: 0,
    answers: [] as Array<{ id: string; allow: boolean }>,
    stopped: 0,
    sendOk: true,
    emit(e: SessionEvent) {
      for (const cb of [...cbs]) cb(e);
    },
    setState(st: 'starting' | 'ready' | 'restarting' | 'down') {
      s.st = st;
      s.emit({ k: 'state', state: st });
    },
    api: null as unknown as SessionLike,
  };
  s.api = {
    start: () => undefined,
    send: (id, text) => {
      if (!s.sendOk) return false;
      s.sent.push({ id, text });
      return true;
    },
    interrupt: () => {
      s.interrupts++;
    },
    answerPermission: (id, allow) => {
      s.answers.push({ id, allow });
    },
    stop: async () => {
      s.stopped++;
    },
    on: (cb) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    state: () => s.st,
  };
  return s;
}

function setup(opts: { state?: 'ready' | 'starting' | 'restarting' | 'down' | 'none'; subscribe?: boolean } = {}) {
  const s = fakeSession(opts.state ?? 'ready');
  const gw = createVoiceGateway({ session: s.api, orphanTurnMs: 1000, permissionTimeoutMs: 500 });
  gw.start();
  const events: ServerEvent[] = [];
  const unsub = opts.subscribe === false ? () => undefined : gw.subscribe((e) => events.push(e));
  return { s, gw, events, unsub };
}

const start = (turnId: string, text = 'hi') => ({ t: 'turn.start' as const, turnId, text, mode: 'voice' as const });
const types = (ev: ServerEvent[]) => ev.map((e) => e.t);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('turn flow', () => {
  it('happy path: ordered events, gapless seq, constant sessionId', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    expect(s.sent).toEqual([{ id: 'turn-0001', text: 'hi' }]);
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'Hello there. How are' });
    s.emit({ k: 'delta', turnId: 'turn-0001', text: ' you? Fine.' });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    expect(types(events)).toEqual([
      'turn.started',
      'response.delta',
      'response.delta',
      'response.delta',
      'response.spoken_done',
      'turn.completed',
    ]);
    expect(events[events.length - 1]).toMatchObject({ t: 'turn.completed', status: 'completed' });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(1);
    expect(events[0].sessionId).toBe(gw.sessionId());
  });

  it('delimiter yields spoken_done before display', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'Sure thing.\n---\nDetail here.' });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    const t = types(events);
    expect(t.indexOf('response.spoken_done')).toBeLessThan(t.indexOf('response.display'));
    expect(t.filter((x) => x === 'response.spoken_done')).toHaveLength(1);
    expect(events.find((e) => e.t === 'response.display')).toMatchObject({ text: 'Detail here.' });
  });

  it('a secret split across two deltas never appears in any emitted event', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'The key is ' + KEY.slice(0, 15) });
    s.emit({ k: 'delta', turnId: 'turn-0001', text: KEY.slice(15) + ' and password=hunter2hunter2 ok.\n---\n' + KEY });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    const all = JSON.stringify(events);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(7));
    expect(all).not.toContain('hunter2hunter2');
    expect(all).toContain('[redacted]');
  });

  it('a failed result completes as error with turn_failed', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.emit({ k: 'result', turnId: 'turn-0001', ok: false, interrupted: false });
    expect(events.slice(-2)).toMatchObject([
      { t: 'turn.completed', status: 'error' },
      { t: 'error', code: 'turn_failed', retryable: true },
    ]);
  });

  it('send refusal completes the turn as error', () => {
    const { s, gw, events } = setup();
    s.sendOk = false;
    gw.handle(start('turn-0001'));
    expect(types(events)).toEqual(['turn.started', 'turn.completed', 'error']);
  });

  it('tool status carries the masked, capped name only', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.emit({ k: 'tool', turnId: 'turn-0001', name: 'Bash', agent: false });
    s.emit({ k: 'tool', turnId: 'turn-0001', name: 'Task', agent: true });
    s.emit({ k: 'tool', turnId: 'turn-0001', name: 'x'.repeat(100), agent: false });
    const st = events.filter((e) => e.t === 'status');
    expect(st[0]).toMatchObject({ kind: 'tool', state: 'Bash' });
    expect(st[1]).toMatchObject({ kind: 'agent', state: 'Task' });
    expect((st[2] as { state: string }).state).toHaveLength(40);
    expect(Object.keys(st[0]).sort()).toEqual(['kind', 'seq', 'sessionId', 'state', 't', 'turnId']);
  });

  it('a new speech filter per turn: pending text from one turn does not leak into the next', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'Half a sent' });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    gw.handle(start('turn-0002'));
    s.emit({ k: 'delta', turnId: 'turn-0002', text: 'Next one.' });
    s.emit({ k: 'result', turnId: 'turn-0002', ok: true, interrupted: false });
    const second = events.filter((e) => e.turnId === 'turn-0002' && e.t === 'response.delta');
    expect(second.map((e) => (e as { text: string }).text.trim())).toEqual(['Next one.']);
  });
});

describe('cancel', () => {
  it('no response.delta after cancel; one interrupted completion even with a duplicate result', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'First bit. ' });
    const before = events.length;
    gw.handle({ t: 'turn.cancel', turnId: 'turn-0001', spokenText: 'First' });
    expect(s.interrupts).toBe(1);
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'More text. And more. ' });
    s.emit({ k: 'tool', turnId: 'turn-0001', name: 'Bash', agent: false });
    expect(events.length).toBe(before);
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: true });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: true });
    const completed = events.filter((e) => e.t === 'turn.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: 'interrupted', spokenText: 'First' });
    expect(events.slice(before).some((e) => e.t === 'response.delta')).toBe(false);
  });

  it('a late result for the old turn does not complete or leak into the next turn', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    gw.handle({ t: 'turn.cancel', turnId: 'turn-0001', spokenText: '' });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: true });
    gw.handle(start('turn-0002'));
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'stale text. ' });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    expect(events.filter((e) => e.turnId === 'turn-0002').map((e) => e.t)).toEqual(['turn.started']);
    expect(events.filter((e) => e.t === 'turn.completed')).toHaveLength(1);
  });

  it('prefix is used exactly once and is sanitised', () => {
    const { s, gw } = setup();
    gw.handle(start('turn-0001'));
    gw.handle({ t: 'turn.cancel', turnId: 'turn-0001', spokenText: 'say "hi"\nnow\t' + 'z'.repeat(600) });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: true });
    gw.handle(start('turn-0002', 'what next'));
    const sent = s.sent[1].text;
    const m = /^\[interrupted after: "([^"]*)"\] what next$/.exec(sent);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('say hinow' + 'z'.repeat(500 - 9));
    expect(m![1]).toHaveLength(500);
    s.emit({ k: 'result', turnId: 'turn-0002', ok: true, interrupted: false });
    gw.handle(start('turn-0003', 'third'));
    expect(s.sent[2].text).toBe('third');
  });

  it('cancel for an unknown or finished turnId is ignored', () => {
    const { s, gw, events } = setup();
    gw.handle({ t: 'turn.cancel', turnId: 'turn-9999', spokenText: 'x' });
    gw.handle(start('turn-0001'));
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    const n = events.length;
    gw.handle({ t: 'turn.cancel', turnId: 'turn-0001', spokenText: 'x' });
    expect(s.interrupts).toBe(0);
    expect(events.length).toBe(n);
  });
});

describe('busy, idempotency and session states', () => {
  it('second start while in flight is busy; duplicate turnId is ignored silently', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    gw.handle(start('turn-0002'));
    expect(events[events.length - 1]).toMatchObject({ t: 'error', code: 'busy', retryable: true });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    const n = events.length;
    gw.handle(start('turn-0001'));
    expect(events.length).toBe(n);
    expect(s.sent).toHaveLength(1);
  });

  it('queues exactly one turn while starting and runs it on ready', () => {
    const { s, gw, events } = setup({ state: 'starting' });
    gw.handle(start('turn-0001'));
    expect(events[0]).toMatchObject({ t: 'status', kind: 'session', state: 'starting', turnId: null });
    expect(s.sent).toHaveLength(0);
    gw.handle(start('turn-0002'));
    expect(events[events.length - 1]).toMatchObject({ code: 'busy' });
    s.setState('ready');
    expect(s.sent).toEqual([{ id: 'turn-0001', text: 'hi' }]);
    expect(events.map((e) => e.t)).toContain('turn.started');
  });

  it('restarting and down refuse with the right codes', () => {
    const a = setup({ state: 'restarting' });
    a.gw.handle(start('turn-0001'));
    expect(a.events[0]).toMatchObject({ code: 'session_restarting', retryable: true });
    const b = setup({ state: 'down' });
    b.gw.handle(start('turn-0001'));
    expect(b.events[0]).toMatchObject({ code: 'session_down', retryable: false });
    expect(a.s.sent).toHaveLength(0);
  });

  it('state events become status{session} with turnId null', () => {
    const { s, events } = setup();
    s.setState('restarting');
    s.setState('ready');
    expect(events).toMatchObject([
      { t: 'status', kind: 'session', state: 'restarting', turnId: null },
      { t: 'status', kind: 'session', state: 'ready', turnId: null },
    ]);
  });

  it('crash mid-turn: completed error + session_restarting, in-flight cleared, next turn works', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.emit({ k: 'lost', turnId: 'turn-0001' });
    s.setState('restarting');
    expect(events.slice(1).map((e) => e.t)).toEqual(['turn.completed', 'error', 'status']);
    expect(events[1]).toMatchObject({ status: 'error' });
    expect(events[2]).toMatchObject({ code: 'session_restarting', retryable: true });
    s.setState('ready');
    gw.handle(start('turn-0002'));
    expect(s.sent).toHaveLength(2);
    expect(s.sent[0].id).toBe('turn-0001');
  });

  it('a state change away from ready with no lost event completes the turn as lost', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.setState('down');
    expect(events.filter((e) => e.t === 'turn.completed')).toMatchObject([{ status: 'lost' }]);
  });
});

describe('rework edge cases', () => {
  it('cancel of a queued turn drops it: completed interrupted, and ready never starts it', () => {
    const { s, gw, events } = setup({ state: 'starting' });
    gw.handle(start('turn-0001'));
    gw.handle({ t: 'turn.cancel', turnId: 'turn-0001', spokenText: '' });
    expect(events[events.length - 1]).toMatchObject({ t: 'turn.completed', status: 'interrupted', turnId: 'turn-0001' });
    s.setState('ready');
    expect(s.sent).toHaveLength(0);
    expect(events.map((e) => e.t)).not.toContain('turn.started');
    expect(events.map((e) => e.t)).not.toContain('response.delta');
    gw.handle(start('turn-0002'));
    expect(s.sent).toHaveLength(1);
  });

  it('a retry of a queued id dropped on restarting is accepted', () => {
    const { s, gw } = setup({ state: 'starting' });
    gw.handle(start('turn-0001'));
    s.setState('restarting');
    s.setState('ready');
    gw.handle(start('turn-0001'));
    expect(s.sent).toEqual([{ id: 'turn-0001', text: 'hi' }]);
  });

  it('a retry after send failure, crash or turn failure is accepted; a completed id is still a duplicate', () => {
    const { s, gw } = setup();
    s.sendOk = false;
    gw.handle(start('turn-0001'));
    s.sendOk = true;
    gw.handle(start('turn-0001'));
    expect(s.sent.map((x) => x.id)).toEqual(['turn-0001']);
    s.emit({ k: 'lost', turnId: 'turn-0001' });
    gw.handle(start('turn-0001'));
    expect(s.sent).toHaveLength(2);
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    gw.handle(start('turn-0001'));
    expect(s.sent).toHaveLength(2);
  });

  it('a key straddling char 500 of spokenText leaks no fragment into events or replay', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    gw.handle({ t: 'turn.cancel', turnId: 'turn-0001', spokenText: 'a'.repeat(495) + ' ' + KEY });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: true });
    gw.handle(start('turn-0002'));
    const all = JSON.stringify(events) + JSON.stringify(gw.replayAfter(0)) + JSON.stringify(s.sent);
    expect(all).not.toContain(KEY.slice(0, 12));
    expect(all).not.toMatch(/sk-ant-[A-Za-z0-9]/);
  });

  it('a key straddling the 80-char cap of a Bash command leaks no fragment', () => {
    const { s, gw, events } = setup();
    s.emit({ k: 'permission', id: 'p1', tool: 'Bash', input: { command: 'x'.repeat(70) + ' ' + KEY } });
    s.emit({ k: 'permission', id: 'p2', tool: 'Bash', input: { command: 'x'.repeat(60) + ' password=hunter2hunter2' } });
    const all = JSON.stringify(events) + JSON.stringify(gw.replayAfter(0));
    expect(all).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    expect(all).not.toMatch(/hunter/);
  });
});

describe('orphan turn', () => {
  it('is interrupted after the timeout with zero subscribers', () => {
    const { s, gw, events, unsub } = setup();
    gw.handle(start('turn-0001'));
    unsub();
    vi.advanceTimersByTime(999);
    expect(s.interrupts).toBe(0);
    vi.advanceTimersByTime(1);
    expect(s.interrupts).toBe(1);
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: true });
    expect(gw.replayAfter(0)).toMatchObject({ ok: true });
    const r = gw.replayAfter(0);
    expect(r.ok && r.events.some((e) => e.t === 'turn.completed' && e.status === 'interrupted')).toBe(true);
    expect(events).toHaveLength(1); // the unsubscribed listener saw only what came before it left
  });

  it('is not interrupted if a subscriber returns in time; events are logged meanwhile', () => {
    const { s, gw, unsub } = setup();
    gw.handle(start('turn-0001'));
    unsub();
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'While away. ' });
    vi.advanceTimersByTime(500);
    const back: ServerEvent[] = [];
    gw.subscribe((e) => back.push(e));
    vi.advanceTimersByTime(5000);
    expect(s.interrupts).toBe(0);
    const r = gw.replayAfter(0);
    expect(r.ok && r.events.some((e) => e.t === 'response.delta')).toBe(true);
  });

  it('a turn started with nobody listening is also timed out', () => {
    const { s, gw } = setup({ subscribe: false });
    gw.handle(start('turn-0001'));
    vi.advanceTimersByTime(1000);
    expect(s.interrupts).toBe(1);
  });
});

describe('permissions', () => {
  it('permission.request carries a masked summary and no raw input', () => {
    const { s, events } = setup();
    s.emit({ k: 'permission', id: 'p1', tool: 'Bash', input: { command: `echo ${KEY}`, secret: 'zzz' } });
    expect(events[0]).toMatchObject({ t: 'permission.request', id: 'p1' });
    const all = JSON.stringify(events);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('zzz');
    s.emit({ k: 'permission', id: 'p2', tool: 'Write', input: { file_path: 'C:\\a\\b\\c.txt' } });
    expect((events[1] as { summary: string }).summary).toBe('Write: c.txt');
  });

  it('a reply approves exactly once; a replay of the same id is ignored; unknown ids ignored', () => {
    const { s, gw } = setup();
    s.emit({ k: 'permission', id: 'p1', tool: 'Bash', input: {} });
    gw.handle({ t: 'permission.reply', id: 'nope', approve: true });
    expect(s.answers).toEqual([]);
    gw.handle({ t: 'permission.reply', id: 'p1', approve: true });
    gw.handle({ t: 'permission.reply', id: 'p1', approve: true });
    expect(s.answers).toEqual([{ id: 'p1', allow: true }]);
    vi.advanceTimersByTime(5000);
    expect(s.answers).toHaveLength(1);
  });

  it('timeout denies', () => {
    const { s } = setup();
    s.emit({ k: 'permission', id: 'p1', tool: 'Bash', input: {} });
    vi.advanceTimersByTime(500);
    expect(s.answers).toEqual([{ id: 'p1', allow: false }]);
  });

  it('with zero subscribers the request is denied immediately and nothing is emitted', () => {
    const { s, gw } = setup({ subscribe: false });
    s.emit({ k: 'permission', id: 'p1', tool: 'Bash', input: {} });
    expect(s.answers).toEqual([{ id: 'p1', allow: false }]);
    expect(gw.replayAfter(0)).toEqual({ ok: true, events: [] });
    gw.handle({ t: 'permission.reply', id: 'p1', approve: true });
    expect(s.answers).toHaveLength(1);
  });

  it('lost or a state change away from ready closes open permissions: no stale reply, no timeout deny', () => {
    const { s, gw } = setup();
    s.emit({ k: 'permission', id: 'p1', tool: 'Bash', input: {} });
    s.emit({ k: 'permission', id: 'p2', tool: 'Bash', input: {} });
    s.emit({ k: 'lost', turnId: 'turn-0001' });
    gw.handle({ t: 'permission.reply', id: 'p1', approve: true });
    s.setState('restarting');
    gw.handle({ t: 'permission.reply', id: 'p2', approve: true });
    vi.advanceTimersByTime(5000);
    expect(s.answers).toEqual([]);
  });
});

describe('log agreement and stop', () => {
  it('replayAfter agrees with emitted events', () => {
    const { s, gw, events } = setup();
    gw.handle(start('turn-0001'));
    s.emit({ k: 'delta', turnId: 'turn-0001', text: 'One. Two. ' });
    s.emit({ k: 'result', turnId: 'turn-0001', ok: true, interrupted: false });
    expect(gw.replayAfter(0)).toEqual({ ok: true, events });
    expect(gw.replayAfter(2)).toEqual({ ok: true, events: events.slice(2) });
    expect(gw.replayAfter(events.length + 1)).toEqual({ ok: false, reason: 'ahead' });
  });

  it('resume is ignored; stop stops the session and clears the log', async () => {
    const { s, gw } = setup();
    gw.handle({ t: 'resume', lastSeq: 0 });
    gw.handle(start('turn-0001'));
    await gw.stop();
    expect(s.stopped).toBe(1);
    expect(gw.replayAfter(0)).toMatchObject({ ok: false });
    gw.handle(start('turn-0002'));
    expect(s.sent).toHaveLength(1);
  });
});
