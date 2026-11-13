// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGuiSession, trackExit, type GuiLifecycle, type GuiPty } from './guiSession';
import { GUI_CHANNELS, GUI_KILL_WAIT_MS, GUI_MAX_WRITE_CHARS, GUI_SUBMIT_GAP_MS } from './guiTypes';

// autoExit: kill() ends the pty at once (the common case); false = a pty that lingers until fireExit (ConPTY exit is async).
function fakePty(autoExit = true) {
  let data: (v: string) => void = () => {};
  let exit: () => void = () => {};
  return {
    onData: (cb: typeof data) => { data = cb; }, onExit: (cb: typeof exit) => { exit = cb; },
    kill: vi.fn(() => { if (autoExit) exit(); }), write: vi.fn(), resize: vi.fn(),
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

function setup(over?: { spawn?: (a: unknown) => GuiPty; kill?: () => void; isDirectory?: (p: string) => boolean; newChatDir?: () => string | undefined; resumeById?: boolean; lingering?: boolean }) {
  const lifecycle = fakeLifecycle();
  if (over?.kill) lifecycle.kill = over.kill;
  const ptys: FP[] = [];
  const spawn = vi.fn((a: unknown) => {
    if (over?.spawn) return over.spawn(a);
    const p = fakePty(!over?.lingering); ptys.push(p); return p as unknown as GuiPty;
  });
  const sent: Array<[string, unknown]> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const log = vi.fn();
  const flags = { aliveThrows: false };
  let n = 0;
  const session = createGuiSession({
    lifecycle, spawn, resumeById: over?.resumeById ?? true,
    projectPath: (id) => (id === 'p1' ? 'C:/secret/one' : id === 'p2' ? 'C:/secret/two' : id === 'gone' ? 'C:/secret/gone' : undefined),
    isDirectory: over?.isDirectory ?? ((p) => p !== 'C:/secret/gone'),
    newChatDir: over?.newChatDir,
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
  it('spawns once with the cwd from projectPath and a fresh session id', async () => {
    const s = setup();
    expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.spawn).toHaveBeenCalledWith({ cwd: 'C:/secret/one', cols: 80, rows: 24, sessionId: 'sid-1', mode: 'auto' });
  });
  it('uses an undefined cwd for the home-dir New chat', async () => {
    const s = setup();
    s.session.start(req(null));
    expect(s.spawn.mock.calls[0]![0]).toMatchObject({ cwd: undefined });
  });
  it('New chat spawns in the owned dir; a project keeps its own cwd', async () => {
    const s = setup({ newChatDir: () => 'C:/owned/gui-chat' });
    s.session.start(req(null));
    expect(s.spawn.mock.calls[0]![0]).toMatchObject({ cwd: 'C:/owned/gui-chat' });
    s.session.start(req('p1'));
    expect(s.spawn.mock.calls[1]![0]).toMatchObject({ cwd: 'C:/secret/one' });
  });
  it('New chat with no usable owned dir is unavailable, spawns nothing and stops the live session', async () => {
    for (const dir of [undefined, 'C:/secret/gone']) {
      const s = setup({ newChatDir: () => dir });
      s.session.start(req('p1'));
      expect(await s.session.start(req(null))).toEqual({ ok: false, reason: 'unavailable' });
      expect(s.spawn).toHaveBeenCalledTimes(1);
      expect(s.ptys[0]!.kill).toHaveBeenCalled();
      expect(s.session.live()).toBe(false);
    }
  });
  it('rejects unknown project, missing dir and bad requests without spawning', async () => {
    const s = setup();
    expect(await s.session.start(req('nope'))).toEqual({ ok: false, reason: 'unknown-project' });
    expect(await s.session.start(req('gone'))).toEqual({ ok: false, reason: 'missing-dir' });
    for (const bad of [null, 'x', {}, req('p1', 0, 24), req('p1', 80, 1001), req('p1', 1.5, 24), { projectId: 5, cols: 80, rows: 24 }]) {
      expect(await s.session.start(bad)).toEqual({ ok: false, reason: 'bad-request' });
    }
    expect(s.spawn).not.toHaveBeenCalled();
  });
  it('reuses the live session for the same project without spawning and re-sends alive', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.sent.length = 0;
    expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: true });
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.sent).toEqual([[GUI_CHANNELS.alive, undefined]]);
  });
  it('restart:true replaces a live session of the same project instead of reusing it', async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(await s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.ptys[0]!.kill).toHaveBeenCalled();
  });
  it("restart:'true' (non-boolean) still reuses the live session", async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(await s.session.start({ ...req('p1'), restart: 'true' })).toEqual({ ok: true, reused: true });
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });
  it('restart:true with no live session starts normally', async () => {
    const s = setup();
    expect(await s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.session.live()).toBe(true);
  });
  it('restart:true with a throwing spawn ends the session and kills the old pty once', async () => {
    const made: FP[] = [];
    const s = setup({ spawn: ((calls = 0) => () => { if (++calls === 2) throw new Error('boom'); const p = fakePty(); made.push(p); return p as unknown as GuiPty; })() });
    s.session.start(req('p1'));
    expect(await s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.session.live()).toBe(false);
    expect(made[0]!.kill).toHaveBeenCalledTimes(1);
  });
  it('replaces the session for a different project and kills the old pty', async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(await s.session.start(req('p2'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.ptys[0]!.kill).toHaveBeenCalled();
  });
  // spawn that throws on the listed call numbers; every pty it does create is pushed to `made`
  const flaky = (failOn: number[], made: FP[]) => {
    let calls = 0;
    return () => { if (failOn.includes(++calls)) throw new Error('boom'); const p = fakePty(); made.push(p); return p as unknown as GuiPty; };
  };
  it('ends the old session when a replacement spawn throws, so the same project spawns again', async () => {
    const olds: FP[] = [];
    const s = setup({ spawn: flaky([2], olds) });
    s.session.start(req('p1'));
    expect(await s.session.start(req('p2'))).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.session.live()).toBe(false);
    expect(olds[0]!.kill).toHaveBeenCalled();
    expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(3);
  });
  it('drops the old session output and exit after a failed replacement', async () => {
    const olds: FP[] = [];
    const s = setup({ spawn: flaky([2], olds) });
    s.session.start(req('p1'));
    s.session.start(req('p2'));
    s.sent.length = 0;
    olds[0]!.fireData('x'); // the fake kill() leaves the old pty wired, so only the gen check drops this
    olds[0]!.fireExit();
    expect(s.sent).toEqual([]);
  });
  it('keeps ids monotonic: after a failed start, a later start forwards and the old pty stays dropped', async () => {
    const made: FP[] = [];
    const s = setup({ spawn: flaky([2], made) });
    s.session.start(req('p1'));
    s.session.start(req('p2'));
    expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    s.sent.length = 0;
    made[0]!.fireData('old');
    made[1]!.fireData('new');
    expect(s.sent).toEqual([[GUI_CHANNELS.data, 'new']]);
  });
  it('a rejected start ends the live session: kill once, nothing live, nothing forwarded, same project spawns again', async () => {
    for (const bad of [req('nope'), req('gone'), req('p1', 0, 24), null]) {
      const s = setup();
      s.session.start(req('p1'));
      s.sent.length = 0;
      expect((await s.session.start(bad)).ok).toBe(false);
      expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
      expect(s.session.live()).toBe(false);
      expect(s.session.write('x')).toBe(false);
      expect(s.session.submit('x')).toBe(false);
      s.ptys[0]!.fireData('stale');
      expect(s.sent).toEqual([]);
      expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
      expect(s.spawn).toHaveBeenCalledTimes(2);
    }
  });
  it('a rejected start with nothing live does not call kill and does not throw', async () => {
    const s = setup();
    const kill = vi.spyOn(s.lifecycle, 'kill');
    await expect(s.session.start(req('nope'))).resolves.toEqual({ ok: false, reason: 'unknown-project' });
    expect(kill).not.toHaveBeenCalled();
  });
  it('a rejected start cancels a pending multi-line Enter', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    s.session.start(req('nope'));
    expect(s.timers[0]!.cancelled).toBe(true);
    s.timers[0]!.fn(); // even a timer that still fires must not write
    expect(s.ptys[0]!.write).toHaveBeenCalledTimes(1);
  });
  it('kills the new pty when the alive notification throws after it was wired, and forwards nothing from it', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.sent.length = 0;
    s.flags.aliveThrows = true;
    expect(await s.session.start(req('p2'))).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.ptys[1]!.kill).toHaveBeenCalled();
    expect(s.session.live()).toBe(false);
    s.ptys[1]!.fireData('late');
    s.ptys[1]!.fireExit();
    expect(s.sent).toEqual([]);
  });
  it('swallows a throwing kill during a rejected start, keeps the reason, and logs no path', async () => {
    const kill = vi.fn(() => { throw new Error('C:/secret/one'); });
    const s = setup({ kill });
    s.session.start(req('p1'));
    expect(await s.session.start(req('nope'))).toEqual({ ok: false, reason: 'unknown-project' });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(s.log).toHaveBeenCalled();
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('secret');
  });
  it('forwards data, alive and exit on their channels', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.ptys[0]!.fireData('hi');
    s.ptys[0]!.fireExit();
    expect(s.sent).toEqual([[GUI_CHANNELS.alive, undefined], [GUI_CHANNELS.data, 'hi'], [GUI_CHANNELS.exit, undefined]]);
  });
  it('exit clears the running project so the next same-project start spawns', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.ptys[0]!.fireExit();
    expect(s.session.live()).toBe(false);
    expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });
  it('drops data from a superseded pty', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.start(req('p2'));
    s.sent.length = 0;
    s.ptys[0]!.fireData('stale');
    expect(s.sent).toEqual([]);
  });
});

describe('guiSession.write and resize', () => {
  it('writes only when live and within the cap', async () => {
    const s = setup();
    expect(s.session.write('x')).toBe(false);
    s.session.start(req('p1'));
    expect(s.session.write('x')).toBe(true);
    expect(s.ptys[0]!.write).toHaveBeenCalledWith('x');
    expect(s.session.write('y'.repeat(GUI_MAX_WRITE_CHARS + 1))).toBe(false);
    expect(s.session.write(5)).toBe(false);
  });
  it('resizes only with integer dimensions', async () => {
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
  it('is a no-op once the session was stopped, even while the pty object lingers', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.stop();
    s.session.resize(100, 40);
    expect(s.ptys[0]!.resize).not.toHaveBeenCalled();
  });
});

describe('guiSession.submit', () => {
  it('writes a single line at once with no timer', async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.submit('hi')).toBe(true);
    expect(s.ptys[0]!.write).toHaveBeenCalledWith('hi\r');
    expect(s.timers).toHaveLength(0);
  });
  it('sends the paste block now and Enter only after the scheduled gap', async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.submit('a\nb')).toBe(true);
    expect(s.ptys[0]!.write.mock.calls).toEqual([['\x1b[200~a\nb\x1b[201~']]);
    expect(s.timers[0]!.ms).toBe(GUI_SUBMIT_GAP_MS);
    s.fire(0);
    expect(s.ptys[0]!.write.mock.calls[1]).toEqual(['\r']);
  });
  it('refuses a second submit while the Enter is pending, then accepts one after it fires', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    expect(s.session.submit('next')).toBe(false);
    s.fire(0);
    expect(s.session.submit('next')).toBe(true);
  });
  it('refuses when not live, for blank text, and for non-strings', async () => {
    const s = setup();
    expect(s.session.submit('hi')).toBe(false);
    s.session.start(req('p1'));
    expect(s.session.submit('   ')).toBe(false);
    expect(s.session.submit(7)).toBe(false);
  });
  it('drops the Enter if the pty exits between the two writes', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    s.ptys[0]!.fireExit();
    expect(s.timers[0]!.cancelled).toBe(true);
    s.timers[0]!.fn(); // even a timer that still fires must not write
    expect(s.ptys[0]!.write).toHaveBeenCalledTimes(1);
  });
  it('never writes a stale Enter into a replacement pty', async () => {
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
  it('cancels the pending Enter, kills, and refuses further work', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('a\nb');
    s.session.dispose();
    expect(s.timers[0]!.cancelled).toBe(true);
    expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
    expect((await s.session.start(req('p1'))).ok).toBe(false);
    expect(s.session.submit('x')).toBe(false);
    expect(s.session.write('x')).toBe(false);
  });
  it('is idempotent and swallows a throwing kill', async () => {
    const kill = vi.fn(() => { throw new Error('kill failed'); });
    const s = setup({ kill });
    s.session.start(req('p1'));
    expect(() => s.session.dispose()).not.toThrow();
    expect(() => s.session.dispose()).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('guiSession logging', () => {
  it('never logs a path', async () => {
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

describe('guiSession mode and resume ids', () => {
  const lastSpawn = (s: ReturnType<typeof setup>) => s.spawn.mock.calls.at(-1)![0];
  it('passes auto when mode is omitted and the explicit mode when given', async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(lastSpawn(s)).toMatchObject({ mode: 'auto' });
    s.session.start({ ...req('p1'), restart: true, mode: 'plan' });
    expect(lastSpawn(s)).toMatchObject({ mode: 'plan' });
  });
  it.each(['default', 7, {}, null])('rejects invalid mode %j without spawning or touching the map', async (mode) => {
    const s = setup();
    s.session.start(req('p1'));
    expect(await s.session.start({ ...req('p1'), restart: true, resume: true, mode })).toEqual({ ok: false, reason: 'bad-request' });
    expect(s.spawn).toHaveBeenCalledTimes(1);
    s.session.start({ ...req('p1'), restart: true, resume: true });
    expect(lastSpawn(s)).toMatchObject({ resumeId: 'sid-1' });
  });
  it('ignores a non-boolean resume', async () => {
    const s = setup();
    s.session.start({ ...req('p1'), resume: 'true' });
    expect(lastSpawn(s)).toMatchObject({ sessionId: 'sid-1' });
    expect(lastSpawn(s)).not.toHaveProperty('continueLast');
  });
  it('resume:true passes the id recorded by the fresh start, not a new random one', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.start({ ...req('p1'), restart: true, resume: true, mode: 'manual' });
    expect(lastSpawn(s)).toEqual({ cwd: 'C:/secret/one', cols: 80, rows: 24, mode: 'manual', resumeId: 'sid-1' });
  });
  it('resume:true with no known id passes continueLast and no id', async () => {
    const s = setup();
    s.session.start({ ...req(null), resume: true });
    const a = lastSpawn(s);
    expect(a).toMatchObject({ continueLast: true });
    expect(a).not.toHaveProperty('sessionId');
    expect(a).not.toHaveProperty('resumeId');
  });
  it('resumeById false passes continueLast even when an id is known', async () => {
    const s = setup({ resumeById: false });
    s.session.start(req('p1'));
    s.session.start({ ...req('p1'), restart: true, resume: true });
    expect(lastSpawn(s)).toMatchObject({ continueLast: true });
    expect(lastSpawn(s)).not.toHaveProperty('resumeId');
  });
  it('keys are separate: a project id never resumes the New chat', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.start({ ...req(null), restart: true, resume: true });
    expect(lastSpawn(s)).toMatchObject({ continueLast: true });
  });
  it('a fresh start after a resume replaces the stored id', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.start({ ...req('p1'), restart: true, resume: true });
    s.session.start({ ...req('p1'), restart: true });
    expect(lastSpawn(s)).toMatchObject({ sessionId: 'sid-2' });
    s.session.start({ ...req('p1'), restart: true, resume: true });
    expect(lastSpawn(s)).toMatchObject({ resumeId: 'sid-2' });
  });
  it('stop and exit do not clear the stored id', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.stop();
    s.ptys[0]!.fireExit();
    s.session.start({ ...req('p1'), resume: true });
    expect(lastSpawn(s)).toMatchObject({ resumeId: 'sid-1' });
  });
  it('a failed spawn records nothing', async () => {
    let first = true;
    const s = setup({ spawn: () => { if (first) { first = false; throw new Error('boom'); } return fakePty() as unknown as GuiPty; } });
    expect(await s.session.start(req('p1'))).toEqual({ ok: false, reason: 'spawn-failed' });
    s.session.start({ ...req('p1'), resume: true });
    expect(lastSpawn(s)).toMatchObject({ continueLast: true });
  });
});

describe('guiSession awaited replacement', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const restart = (s: ReturnType<typeof setup>, extra: object = {}) => s.session.start({ ...req('p1'), restart: true, ...extra });
  it('a restart does not spawn until the old pty exit has fired, then spawns once', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    const p = restart(s);
    await tick();
    expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.session.live()).toBe(false);
    s.ptys[0]!.fireExit();
    expect(await p).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });
  it('an old pty that never exits is waited on for exactly GUI_KILL_WAIT_MS, then the new one spawns', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    const p = restart(s);
    await tick();
    expect(s.timers).toHaveLength(1);
    expect(s.timers[0]!.ms).toBe(GUI_KILL_WAIT_MS);
    expect(s.spawn).toHaveBeenCalledTimes(1);
    s.fire(0);
    expect(await p).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });
  it('the wait timer is cancelled when the old pty exits first', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    const p = restart(s);
    await tick();
    s.ptys[0]!.fireExit();
    await p;
    expect(s.timers[0]!.cancelled).toBe(true);
  });
  it('a second start during the wait supersedes the first; one spawn in total after the old exit', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    const first = restart(s);
    await tick();
    const second = restart(s);
    await tick();
    s.ptys[0]!.fireExit();
    expect(await first).toEqual({ ok: false, reason: 'superseded' });
    expect(await second).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });
  it('stop() during the wait supersedes the start and nothing is spawned', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    const p = restart(s);
    await tick();
    s.session.stop();
    s.ptys[0]!.fireExit();
    expect(await p).toEqual({ ok: false, reason: 'superseded' });
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });
  it('dispose() during the wait spawns nothing', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    const p = restart(s);
    await tick();
    s.session.dispose();
    s.ptys[0]!.fireExit();
    expect((await p).ok).toBe(false);
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });
  it('a start after stop() waits for the stopped pty to exit', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    s.session.stop();
    const p = s.session.start(req('p2'));
    await tick();
    expect(s.spawn).toHaveBeenCalledTimes(1);
    s.ptys[0]!.fireExit();
    expect(await p).toEqual({ ok: true, reused: false });
  });
  it('a first start with no old pty schedules no timer', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    expect(s.timers).toHaveLength(0);
  });
  it('a rejected start still ends the live session synchronously, before its promise settles', async () => {
    const s = setup();
    await s.session.start(req('p1'));
    const p = s.session.start(req('nope'));
    expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
    expect(s.session.live()).toBe(false);
    expect(await p).toEqual({ ok: false, reason: 'unknown-project' });
  });
});

describe('trackExit', () => {
  const realPty = () => ({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), resize: vi.fn(), resume: vi.fn() });
  it('forwards resume() to the real pty', () => {
    const p = realPty();
    trackExit(p as unknown as GuiPty).pty.resume!();
    expect(p.resume).toHaveBeenCalledTimes(1);
  });
  it('registers exactly one onExit on the real pty and resolves gone on exit', async () => {
    const p = realPty();
    const t = trackExit(p as unknown as GuiPty);
    const cb = vi.fn();
    t.pty.onExit(cb);
    expect(p.onExit).toHaveBeenCalledTimes(1);
    expect(t.isGone()).toBe(false);
    (p.onExit.mock.calls[0]![0] as () => void)();
    await t.gone;
    expect(t.isGone()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('tolerates a pty without resume()', () => {
    const { resume: _r, ...p } = realPty();
    expect(() => trackExit(p as unknown as GuiPty).pty.resume!()).not.toThrow();
  });
});
