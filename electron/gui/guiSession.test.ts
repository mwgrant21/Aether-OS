// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGuiSession, type GuiLifecycle, type GuiPty } from './guiSession';
import { GUI_CHANNELS, GUI_MAX_WRITE_CHARS, GUI_SUBMIT_GAP_MS } from './guiTypes';

function fakePty() {
  let data: (v: string) => void = () => {};
  let exit: () => void = () => {};
  return {
    onData: (cb: typeof data) => { data = cb; }, onExit: (cb: typeof exit) => { exit = cb; },
    kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    fireData: (v: string) => data(v), fireExit: () => exit(),
  };
}
type FP = ReturnType<typeof fakePty>;

// Mimics PtyLifecycle: spawn new first, then kill old; write goes to the active pty. kill() leaves current non-null until the pty's own exit fires (as the real one), so live() must rely on the session's alive flag.
function fakeLifecycle() {
  let active: FP | null = null;
  const lc: GuiLifecycle = {
    get current() { return active; },
    start(spawn, h) {
      const pty = spawn() as unknown as FP;
      active?.kill();
      active = pty;
      pty.onData((x) => { if (active === pty) h.onData(x); });
      pty.onExit(() => { if (active !== pty) return; active = null; h.onExit(); });
      h.onAlive();
      return pty;
    },
    write: (i) => { active?.write(i); },
    resize: (c, r) => { active?.resize(c, r); },
    kill: () => { active?.kill(); },
  };
  return lc;
}

function setup(over?: { spawn?: (a: unknown) => GuiPty; kill?: () => void; isDirectory?: (p: string) => boolean }) {
  const lifecycle = fakeLifecycle();
  if (over?.kill) lifecycle.kill = over.kill;
  const ptys: FP[] = [];
  const spawn = vi.fn((a: unknown) => {
    if (over?.spawn) return over.spawn(a);
    const p = fakePty(); ptys.push(p); return p as unknown as GuiPty;
  });
  const sent: Array<[string, unknown]> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const log = vi.fn();
  const flags = { aliveThrows: false };
  let n = 0;
  const session = createGuiSession({
    lifecycle, spawn,
    projectPath: (id) => (id === 'p1' ? 'C:/secret/one' : id === 'p2' ? 'C:/secret/two' : id === 'gone' ? 'C:/secret/gone' : undefined),
    isDirectory: over?.isDirectory ?? ((p) => p !== 'C:/secret/gone'),
    send: (c, p) => { if (flags.aliveThrows && c === GUI_CHANNELS.alive) throw new Error('alive failed'); sent.push([c, p]); },
    randomUUID: () => `sid-${++n}`,
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    log,
  });
  const fire = (i: number) => { if (!timers[i]!.cancelled) timers[i]!.fn(); };
  return { session, lifecycle, spawn, ptys, sent, timers, log, fire, flags };
}
const req = (projectId: string | null, cols = 80, rows = 24) => ({ projectId, cols, rows });

describe('guiSession.start', () => {
  it('spawns once with the cwd from projectPath and a fresh session id', () => {
    const s = setup();
    expect(s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.spawn).toHaveBeenCalledWith({ cwd: 'C:/secret/one', cols: 80, rows: 24, sessionId: 'sid-1' });
  });
  it('uses an undefined cwd for the home-dir New chat', () => {
    const s = setup();
    s.session.start(req(null));
    expect(s.spawn.mock.calls[0]![0]).toMatchObject({ cwd: undefined });
  });
  it('rejects unknown project, missing dir and bad requests without spawning', () => {
    const s = setup();
    expect(s.session.start(req('nope'))).toEqual({ ok: false, reason: 'unknown-project' });
    expect(s.session.start(req('gone'))).toEqual({ ok: false, reason: 'missing-dir' });
    for (const bad of [null, 'x', {}, req('p1', 0, 24), req('p1', 80, 1001), req('p1', 1.5, 24), { projectId: 5, cols: 80, rows: 24 }]) {
      expect(s.session.start(bad)).toEqual({ ok: false, reason: 'bad-request' });
    }
    expect(s.spawn).not.toHaveBeenCalled();
  });
  it('reuses the live session for the same project without spawning and re-sends alive', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.sent.length = 0;
    expect(s.session.start(req('p1'))).toEqual({ ok: true, reused: true });
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.sent).toEqual([[GUI_CHANNELS.alive, undefined]]);
  });
  it('restart:true replaces a live session of the same project instead of reusing it', () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.ptys[0]!.kill).toHaveBeenCalled();
  });
  it("restart:'true' (non-boolean) still reuses the live session", () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.start({ ...req('p1'), restart: 'true' })).toEqual({ ok: true, reused: true });
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });
  it('restart:true with no live session starts normally', () => {
    const s = setup();
    expect(s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.session.live()).toBe(true);
  });
  it('restart:true with a throwing spawn ends the session and kills the old pty once', () => {
    const made: FP[] = [];
    const s = setup({ spawn: ((calls = 0) => () => { if (++calls === 2) throw new Error('boom'); const p = fakePty(); made.push(p); return p as unknown as GuiPty; })() });
    s.session.start(req('p1'));
    expect(s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.session.live()).toBe(false);
    expect(made[0]!.kill).toHaveBeenCalledTimes(1);
  });
  it('replaces the session for a different project and kills the old pty', () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.start(req('p2'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.ptys[0]!.kill).toHaveBeenCalled();
  });
  // spawn that throws on the listed call numbers; every pty it does create is pushed to `made`
  const flaky = (failOn: number[], made: FP[]) => {
    let calls = 0;
    return () => { if (failOn.includes(++calls)) throw new Error('boom'); const p = fakePty(); made.push(p); return p as unknown as GuiPty; };
  };
  it('ends the old session when a replacement spawn throws, so the same project spawns again', () => {
    const olds: FP[] = [];
    const s = setup({ spawn: flaky([2], olds) });
    s.session.start(req('p1'));
    expect(s.session.start(req('p2'))).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.session.live()).toBe(false);
    expect(olds[0]!.kill).toHaveBeenCalled();
    expect(s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(3);
  });
  it('drops the old session output and exit after a failed replacement', () => {
    const olds: FP[] = [];
    const s = setup({ spawn: flaky([2], olds) });
    s.session.start(req('p1'));
    s.session.start(req('p2'));
    s.sent.length = 0;
    olds[0]!.fireData('x'); // the fake kill() leaves the old pty wired, so only the gen check drops this
    olds[0]!.fireExit();
    expect(s.sent).toEqual([]);
  });
  it('keeps ids monotonic: after a failed start, a later start forwards and the old pty stays dropped', () => {
    const made: FP[] = [];
    const s = setup({ spawn: flaky([2], made) });
    s.session.start(req('p1'));
    s.session.start(req('p2'));
    expect(s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    s.sent.length = 0;
    made[0]!.fireData('old');
    made[1]!.fireData('new');
    expect(s.sent).toEqual([[GUI_CHANNELS.data, 'new']]);
  });
  it('a rejected start ends the live session: kill once, nothing live, nothing forwarded, same project spawns again', () => {
    for (const bad of [req('nope'), req('gone'), req('p1', 0, 24), null]) {
      const s = setup();
      s.session.start(req('p1'));
      s.sent.length = 0;
      expect(s.session.start(bad).ok).toBe(false);
      expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
      expect(s.session.live()).toBe(false);
      expect(s.session.write('x')).toBe(false);
      expect(s.session.submit('x')).toBe(false);
      s.ptys[0]!.fireData('stale');
      expect(s.sent).toEqual([]);
      expect(s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
      expect(s.spawn).toHaveBeenCalledTimes(2);
    }
  });
  it('a rejected start with nothing live does not call kill and does not throw', () => {
    const s = setup();
    const kill = vi.spyOn(s.lifecycle, 'kill');
    expect(() => s.session.start(req('nope'))).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });
  it('a rejected start cancels a pending multi-line Enter', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    s.session.start(req('nope'));
    expect(s.timers[0]!.cancelled).toBe(true);
    s.timers[0]!.fn(); // even a timer that still fires must not write
    expect(s.ptys[0]!.write).toHaveBeenCalledTimes(1);
  });
  it('kills the new pty when the alive notification throws after it was wired, and forwards nothing from it', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.sent.length = 0;
    s.flags.aliveThrows = true;
    expect(s.session.start(req('p2'))).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.ptys[1]!.kill).toHaveBeenCalled();
    expect(s.session.live()).toBe(false);
    s.ptys[1]!.fireData('late');
    s.ptys[1]!.fireExit();
    expect(s.sent).toEqual([]);
  });
  it('swallows a throwing kill during a rejected start, keeps the reason, and logs no path', () => {
    const kill = vi.fn(() => { throw new Error('C:/secret/one'); });
    const s = setup({ kill });
    s.session.start(req('p1'));
    expect(s.session.start(req('nope'))).toEqual({ ok: false, reason: 'unknown-project' });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(s.log).toHaveBeenCalled();
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('secret');
  });
  it('forwards data, alive and exit on their channels', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.ptys[0]!.fireData('hi');
    s.ptys[0]!.fireExit();
    expect(s.sent).toEqual([[GUI_CHANNELS.alive, undefined], [GUI_CHANNELS.data, 'hi'], [GUI_CHANNELS.exit, undefined]]);
  });
  it('exit clears the running project so the next same-project start spawns', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.ptys[0]!.fireExit();
    expect(s.session.live()).toBe(false);
    expect(s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });
  it('drops data from a superseded pty', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.start(req('p2'));
    s.sent.length = 0;
    s.ptys[0]!.fireData('stale');
    expect(s.sent).toEqual([]);
  });
});

describe('guiSession.write and resize', () => {
  it('writes only when live and within the cap', () => {
    const s = setup();
    expect(s.session.write('x')).toBe(false);
    s.session.start(req('p1'));
    expect(s.session.write('x')).toBe(true);
    expect(s.ptys[0]!.write).toHaveBeenCalledWith('x');
    expect(s.session.write('y'.repeat(GUI_MAX_WRITE_CHARS + 1))).toBe(false);
    expect(s.session.write(5)).toBe(false);
  });
  it('resizes only with integer dimensions', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.resize(100, 40);
    s.session.resize(0, 40);
    s.session.resize('a', 40);
    expect(s.ptys[0]!.resize).toHaveBeenCalledTimes(1);
    expect(s.ptys[0]!.resize).toHaveBeenCalledWith(100, 40);
  });
});

describe('guiSession.resize live gate', () => {
  it('is a no-op once the session was stopped, even while the pty object lingers', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.stop();
    s.session.resize(100, 40);
    expect(s.ptys[0]!.resize).not.toHaveBeenCalled();
  });
});

describe('guiSession.submit', () => {
  it('writes a single line at once with no timer', () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.submit('hi')).toBe(true);
    expect(s.ptys[0]!.write).toHaveBeenCalledWith('hi\r');
    expect(s.timers).toHaveLength(0);
  });
  it('sends the paste block now and Enter only after the scheduled gap', () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.submit('a\nb')).toBe(true);
    expect(s.ptys[0]!.write.mock.calls).toEqual([['\x1b[200~a\nb\x1b[201~']]);
    expect(s.timers[0]!.ms).toBe(GUI_SUBMIT_GAP_MS);
    s.fire(0);
    expect(s.ptys[0]!.write.mock.calls[1]).toEqual(['\r']);
  });
  it('refuses a second submit while the Enter is pending, then accepts one after it fires', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    expect(s.session.submit('next')).toBe(false);
    s.fire(0);
    expect(s.session.submit('next')).toBe(true);
  });
  it('refuses when not live, for blank text, and for non-strings', () => {
    const s = setup();
    expect(s.session.submit('hi')).toBe(false);
    s.session.start(req('p1'));
    expect(s.session.submit('   ')).toBe(false);
    expect(s.session.submit(7)).toBe(false);
  });
  it('drops the Enter if the pty exits between the two writes', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    s.ptys[0]!.fireExit();
    expect(s.timers[0]!.cancelled).toBe(true);
    s.timers[0]!.fn(); // even a timer that still fires must not write
    expect(s.ptys[0]!.write).toHaveBeenCalledTimes(1);
  });
  it('never writes a stale Enter into a replacement pty', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    s.session.start(req('p2'));
    expect(s.timers[0]!.cancelled).toBe(true);
    s.timers[0]!.fn(); // simulate the timer firing anyway after the new pty is live
    expect(s.ptys[1]!.write).not.toHaveBeenCalled();
    expect(s.session.submit('ok')).toBe(true); // pending flag was cleared by the replace
  });
});

describe('guiSession.dispose', () => {
  it('cancels the pending Enter, kills, and refuses further work', () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    s.session.dispose();
    expect(s.timers[0]!.cancelled).toBe(true);
    expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
    expect(s.session.start(req('p1')).ok).toBe(false);
    expect(s.session.submit('x')).toBe(false);
    expect(s.session.write('x')).toBe(false);
  });
  it('is idempotent and swallows a throwing kill', () => {
    const kill = vi.fn(() => { throw new Error('kill failed'); });
    const s = setup({ kill });
    s.session.start(req('p1'));
    expect(() => s.session.dispose()).not.toThrow();
    expect(() => s.session.dispose()).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('guiSession logging', () => {
  it('never logs a path', () => {
    let calls = 0;
    const s = setup({
      spawn: () => { if (++calls === 1) throw new Error('C:/secret/one'); return fakePty() as unknown as GuiPty; },
      kill: () => { throw new Error('C:/secret/one'); },
    });
    s.session.start(req('p1'));
    s.session.dispose();
    expect(s.log).toHaveBeenCalled();
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('secret');
  });
});
