// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGuiSession, trackExit, type GuiLifecycle, type GuiPty } from './guiSession';
import { GUI_CHANNELS, GUI_DYING_MAX_MS, GUI_KILL_WAIT_MS, GUI_MAX_WRITE_CHARS, GUI_SUBMIT_GAP_MS, GUI_TREE_KILL_MAX_MS } from './guiTypes';

// autoExit: kill() ends the pty at once (the common case); false = a pty that lingers until fireExit (ConPTY exit is async).
function fakePty(autoExit = true, pid?: number) {
  let data: (v: string) => void = () => {};
  let exit: () => void = () => {};
  return {
    onData: (cb: typeof data) => { data = cb; }, onExit: (cb: typeof exit) => { exit = cb; },
    kill: vi.fn(() => { if (autoExit) exit(); }), write: vi.fn(), resize: vi.fn(),
    fireData: (v: string) => data(v), fireExit: () => exit(), pid,
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
  };
  return lc;
}

function setup(over?: { spawn?: (a: unknown) => GuiPty; kill?: () => void; isDirectory?: (p: string) => boolean; newChatDir?: () => string | undefined; resumeById?: boolean; lingering?: boolean; killTree?: (pid: number) => Promise<void>; killTreeSync?: (pids: number[]) => void; pid?: (i: number) => number | undefined }) {
  const lifecycles: GuiLifecycle[] = [];
  const ptys: FP[] = [];
  const spawn = vi.fn((a: unknown) => {
    if (over?.spawn) return over.spawn(a);
    const p = fakePty(!over?.lingering, over?.pid ? over.pid(ptys.length) : over?.killTree || over?.killTreeSync ? 1000 + ptys.length : undefined);
    if (over?.kill) p.kill = vi.fn(over.kill);
    ptys.push(p); return p as unknown as GuiPty;
  });
  const sent: Array<[string, unknown]> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const log = vi.fn();
  const flags = { aliveThrows: false };
  let n = 0;
  const session = createGuiSession({
    createLifecycle: () => { const lc = fakeLifecycle(); lifecycles.push(lc); return lc; },
    spawn, resumeById: over?.resumeById ?? true,
    projectPath: (id) => (id === 'p1' ? 'C:/secret/one' : id === 'p2' ? 'C:/secret/two' : id === 'gone' ? 'C:/secret/gone' : /^q[0-9]$/.test(id) ? `C:/secret/${id}` : undefined),
    isDirectory: over?.isDirectory ?? ((p) => p !== 'C:/secret/gone'),
    newChatDir: over?.newChatDir, killTree: over?.killTree, killTreeSync: over?.killTreeSync,
    send: (c, p) => { if (flags.aliveThrows && c === GUI_CHANNELS.alive) throw new Error('alive failed'); sent.push([c, p]); },
    randomUUID: () => `sid-${++n}`,
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    log,
  });
  const fire = (i: number) => { if (!timers[i]!.cancelled) timers[i]!.fn(); };
  return { session, lifecycles, spawn, ptys, sent, timers, log, fire, flags };
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
      let cur: string | undefined = 'C:/owned/gui-chat';
      const s = setup({ newChatDir: () => cur });
      s.session.start(req('p1'));
      s.session.start(req(null));
      cur = dir;
      expect(await s.session.start(req(null))).toEqual({ ok: false, reason: 'unavailable' });
      expect(s.spawn).toHaveBeenCalledTimes(2);
      expect(s.ptys[1]!.kill).toHaveBeenCalled();
      expect(s.session.live('new')).toBe(false);
      expect(s.session.live('p1')).toBe(true); // only the requested key was stopped
      expect(s.ptys[0]!.kill).not.toHaveBeenCalled();
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
    expect(s.sent).toEqual([[GUI_CHANNELS.alive, { key: 'p1' }]]);
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
    expect(s.session.live('p1')).toBe(true);
  });
  it('restart:true with a throwing spawn ends the session and kills the old pty once', async () => {
    const made: FP[] = [];
    const s = setup({ spawn: ((calls = 0) => () => { if (++calls === 2) throw new Error('boom'); const p = fakePty(); made.push(p); return p as unknown as GuiPty; })() });
    s.session.start(req('p1'));
    expect(await s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.session.live('p1')).toBe(false);
    expect(made[0]!.kill).toHaveBeenCalledTimes(1);
  });
  it('starting a second project leaves the first live: no kill, both route independently', async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(await s.session.start(req('p2'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.ptys[0]!.kill).not.toHaveBeenCalled();
    expect(s.session.live('p1')).toBe(true);
    expect(s.session.live('p2')).toBe(true);
    expect(s.session.write('p1', 'a')).toBe(true);
    expect(s.session.write('p2', 'b')).toBe(true);
    expect(s.ptys[0]!.write.mock.calls).toEqual([['a']]);
    expect(s.ptys[1]!.write.mock.calls).toEqual([['b']]);
    s.session.resize('p2', 100, 40);
    expect(s.ptys[0]!.resize).not.toHaveBeenCalled();
    expect(s.ptys[1]!.resize).toHaveBeenCalledWith(100, 40);
    expect(s.session.submit('p1', 'hi')).toBe(true);
    expect(s.ptys[0]!.write).toHaveBeenLastCalledWith('hi\r');
    expect(s.ptys[1]!.write).toHaveBeenCalledTimes(1);
    s.sent.length = 0;
    s.ptys[0]!.fireData('one');
    s.ptys[1]!.fireData('two');
    expect(s.sent).toEqual([[GUI_CHANNELS.data, { key: 'p1', d: 'one' }], [GUI_CHANNELS.data, { key: 'p2', d: 'two' }]]);
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
    expect(await s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.session.live('p1')).toBe(false);
    expect(olds[0]!.kill).toHaveBeenCalled();
    expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(3);
  });
  it('drops the old session output and exit after a failed replacement', async () => {
    const olds: FP[] = [];
    const s = setup({ spawn: flaky([2], olds) });
    s.session.start(req('p1'));
    await s.session.start({ ...req('p1'), restart: true });
    s.sent.length = 0;
    olds[0]!.fireData('x'); // the fake kill() leaves the old pty wired, so only the gen check drops this
    olds[0]!.fireExit();
    expect(s.sent).toEqual([]);
  });
  it('keeps ids monotonic: after a failed start, a later start forwards and the old pty stays dropped', async () => {
    const made: FP[] = [];
    const s = setup({ spawn: flaky([2], made) });
    s.session.start(req('p1'));
    await s.session.start({ ...req('p1'), restart: true });
    expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    s.sent.length = 0;
    made[0]!.fireData('old');
    made[1]!.fireData('new');
    expect(s.sent).toEqual([[GUI_CHANNELS.data, { key: 'p1', d: 'new' }]]);
  });
  it('a rejected start ends the live session: kill once, nothing live, nothing forwarded, same project spawns again', async () => {
    for (const bad of [req('p1', 0, 24), { ...req('p1'), mode: 'bogus' }]) {
      const s = setup();
      s.session.start(req('p1'));
      s.sent.length = 0;
      expect((await s.session.start(bad)).ok).toBe(false);
      expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
      expect(s.session.live('p1')).toBe(false);
      expect(s.session.write('p1', 'x')).toBe(false);
      expect(s.session.submit('p1', 'x')).toBe(false);
      s.ptys[0]!.fireData('stale');
      expect(s.sent).toEqual([]);
      expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
      expect(s.spawn).toHaveBeenCalledTimes(2);
    }
  });
  it('a rejected start of another key leaves a live key alive and forwarding', async () => {
    const s = setup();
    s.session.start(req('p1'));
    for (const bad of [req('nope'), req('gone'), req('p2', 0, 24), { ...req('p2'), mode: 'bogus' }, null]) {
      expect((await s.session.start(bad)).ok).toBe(false);
    }
    expect(s.ptys[0]!.kill).not.toHaveBeenCalled();
    expect(s.session.live('p1')).toBe(true);
    s.sent.length = 0;
    s.ptys[0]!.fireData('still');
    expect(s.sent).toEqual([[GUI_CHANNELS.data, { key: 'p1', d: 'still' }]]);
  });
  it('a rejected start with nothing live does not call kill and does not throw', async () => {
    const s = setup();
    await expect(s.session.start(req('nope'))).resolves.toEqual({ ok: false, reason: 'unknown-project' });
    expect(s.lifecycles).toHaveLength(0);
  });
  it('a rejected start cancels a pending multi-line Enter', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('p1', 'a\nb');
    s.session.start(req('p1', 0, 24));
    expect(s.timers[0]!.cancelled).toBe(true);
    s.timers[0]!.fn(); // even a timer that still fires must not write
    expect(s.ptys[0]!.write).toHaveBeenCalledTimes(1);
  });
  it('kills the new pty when the alive notification throws after it was wired, and forwards nothing from it', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.sent.length = 0;
    s.flags.aliveThrows = true;
    expect(await s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(s.ptys[1]!.kill).toHaveBeenCalled();
    expect(s.session.live('p1')).toBe(false);
    s.ptys[1]!.fireData('late');
    s.ptys[1]!.fireExit();
    expect(s.sent).toEqual([]);
  });
  it('swallows a throwing kill during a rejected start, keeps the reason, and logs no path', async () => {
    const kill = vi.fn(() => { throw new Error('C:/secret/one'); });
    const s = setup({ kill });
    s.session.start(req('p1'));
    expect(await s.session.start({ ...req('p1'), cols: 0 })).toEqual({ ok: false, reason: 'bad-request' });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(s.log).toHaveBeenCalled();
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('secret');
  });
  it('forwards data, alive and exit on their channels', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.ptys[0]!.fireData('hi');
    s.ptys[0]!.fireExit();
    expect(s.sent).toEqual([[GUI_CHANNELS.alive, { key: 'p1' }], [GUI_CHANNELS.data, { key: 'p1', d: 'hi' }], [GUI_CHANNELS.exit, { key: 'p1' }]]);
  });
  it('exit clears the running project so the next same-project start spawns', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.ptys[0]!.fireExit();
    expect(s.session.live('p1')).toBe(false);
    expect(await s.session.start(req('p1'))).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });
  it('drops data from a superseded pty', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.start({ ...req('p1'), restart: true });
    s.sent.length = 0;
    s.ptys[0]!.fireData('stale');
    expect(s.sent).toEqual([]);
  });
});

describe('guiSession per-key slots', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  it('starting K2 does not kill K1', async () => {
    const s = setup();
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    expect(s.ptys[0]!.kill).not.toHaveBeenCalled();
    expect(s.session.live('p1')).toBe(true);
  });
  it('stop(K1) kills only K1, forwards nothing more from it, and leaves K2 working', async () => {
    const s = setup();
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    s.session.stop('p1');
    expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
    expect(s.ptys[1]!.kill).not.toHaveBeenCalled();
    s.sent.length = 0;
    s.ptys[0]!.fireData('late');
    s.ptys[0]!.fireExit();
    s.ptys[1]!.fireData('ok');
    expect(s.sent).toEqual([[GUI_CHANNELS.data, { key: 'p2', d: 'ok' }]]);
    expect(s.session.live('p1')).toBe(false);
    expect(s.session.write('p1', 'x')).toBe(false);
    expect(s.session.write('p2', 'x')).toBe(true);
  });
  it('stop of an unknown or non-string key is a no-op', async () => {
    const s = setup();
    await s.session.start(req('p1'));
    s.session.stop('zzz');
    s.session.stop(5);
    expect(s.ptys[0]!.kill).not.toHaveBeenCalled();
    expect(s.session.write('zzz', 'x')).toBe(false);
    expect(s.session.submit(5, 'x')).toBe(false);
  });
  it('exit of K1 clears only K1 and frees its slot', async () => {
    const s = setup();
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    s.sent.length = 0;
    s.ptys[0]!.fireExit();
    expect(s.sent).toEqual([[GUI_CHANNELS.exit, { key: 'p1' }]]);
    expect(s.session.live('p1')).toBe(false);
    expect(s.session.live('p2')).toBe(true);
  });
  it('A -> B -> A: the old A pty forwards nothing into the new A and only one A pty is live', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    s.session.stop('p1');
    const again = s.session.start(req('p1'));
    await tick();
    s.ptys[0]!.fireExit();
    expect(await again).toEqual({ ok: true, reused: false });
    s.sent.length = 0;
    s.ptys[0]!.fireData('old');
    s.ptys[2]!.fireData('new');
    expect(s.sent).toEqual([[GUI_CHANNELS.data, { key: 'p1', d: 'new' }]]);
    expect(s.ptys.filter((p) => p.kill.mock.calls.length === 0)).toHaveLength(2); // new A and B
  });
  it('resumeIds are per key and survive a slot being stopped', async () => {
    const s = setup();
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    s.session.stop('p1');
    await s.session.start({ ...req('p1'), resume: true });
    expect(s.spawn.mock.calls.at(-1)![0]).toMatchObject({ resumeId: 'sid-1' });
    await s.session.start({ ...req('p2'), restart: true, resume: true });
    expect(s.spawn.mock.calls.at(-1)![0]).toMatchObject({ resumeId: 'sid-2' });
  });
  it('dispose kills every slot, a kill that throws does not spare the others, and further work is refused', async () => {
    let n = 0;
    const s = setup({ kill: () => { if (++n === 1) throw new Error('boom'); } });
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    expect(() => s.session.dispose()).not.toThrow();
    expect(n).toBe(2);
    expect((await s.session.start(req('q1'))).ok).toBe(false);
    expect(s.session.live('p2')).toBe(false);
  });
  it('a throwing kill while stopping one slot is swallowed and leaves the other slot alone', async () => {
    let n = 0;
    const s = setup({ kill: () => { n++; throw new Error('C:/secret/one'); } });
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    expect(() => s.session.stop('p1')).not.toThrow();
    expect(n).toBe(1);
    expect(s.session.live('p2')).toBe(true);
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('secret');
  });
});

describe('guiSession live cap', () => {
  const fillFour = async (s: ReturnType<typeof setup>) => {
    for (const k of ['p1', 'p2', 'q1', 'q2']) await s.session.start(req(k));
  };
  it('refuses a 5th key with too-many-live, spawning and killing nothing', async () => {
    const s = setup();
    await fillFour(s);
    expect(await s.session.start(req('q3'))).toEqual({ ok: false, reason: 'too-many-live' });
    expect(s.spawn).toHaveBeenCalledTimes(4);
    for (const p of s.ptys) expect(p.kill).not.toHaveBeenCalled();
    expect(await s.session.start(req(null))).toEqual({ ok: false, reason: 'too-many-live' });
  });
  it('restart:true of a live key at the cap succeeds', async () => {
    const s = setup();
    await fillFour(s);
    expect(await s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: true, reused: false });
    expect(s.session.live('p1')).toBe(true);
  });
  it('a reuse of a live key at the cap is allowed', async () => {
    const s = setup();
    await fillFour(s);
    expect(await s.session.start(req('q2'))).toEqual({ ok: true, reused: true });
  });
  it('two starts issued in the same tick at 3 live: exactly one gets a slot', async () => {
    const s = setup();
    for (const k of ['p1', 'p2', 'q1']) await s.session.start(req(k));
    const results = await Promise.all([s.session.start(req('q2')), s.session.start(req('q3'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'too-many-live' }]);
    expect(s.spawn).toHaveBeenCalledTimes(4);
  });
  it('a slot freed by stop or by exit lets a new start succeed', async () => {
    const s = setup();
    await fillFour(s);
    s.session.stop('p1');
    expect((await s.session.start(req('q3'))).ok).toBe(true);
    s.ptys[1]!.fireExit();
    expect((await s.session.start(req('q4'))).ok).toBe(true);
  });
  it('the slot exists while a restart waits for the old pty, so it still counts against the cap', async () => {
    const s = setup({ lingering: true });
    await fillFour(s);
    const p = s.session.start({ ...req('p1'), restart: true });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(await s.session.start(req('q3'))).toEqual({ ok: false, reason: 'too-many-live' });
    s.ptys[0]!.fireExit();
    expect((await p).ok).toBe(true);
  });
});


describe('guiSession.write and resize', () => {
  it('writes only when live and within the cap', async () => {
    const s = setup();
    expect(s.session.write('p1', 'x')).toBe(false);
    s.session.start(req('p1'));
    expect(s.session.write('p1', 'x')).toBe(true);
    expect(s.ptys[0]!.write).toHaveBeenCalledWith('x');
    expect(s.session.write('p1', 'y'.repeat(GUI_MAX_WRITE_CHARS + 1))).toBe(false);
    expect(s.session.write('p1', 5)).toBe(false);
  });
  it('resizes only with integer dimensions', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.resize('p1', 100, 40);
    s.session.resize('p1', 0, 40);
    s.session.resize('p1', 'a', 40);
    expect(s.ptys[0]!.resize).toHaveBeenCalledTimes(1);
    expect(s.ptys[0]!.resize).toHaveBeenCalledWith(100, 40);
  });
});

describe('guiSession.resize live gate', () => {
  it('is a no-op once the session was stopped, even while the pty object lingers', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.stop('p1');
    s.session.resize('p1', 100, 40);
    expect(s.ptys[0]!.resize).not.toHaveBeenCalled();
  });
});

describe('guiSession.submit', () => {
  it('writes a single line at once with no timer', async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.submit('p1', 'hi')).toBe(true);
    expect(s.ptys[0]!.write).toHaveBeenCalledWith('hi\r');
    expect(s.timers).toHaveLength(0);
  });
  it('sends the paste block now and Enter only after the scheduled gap', async () => {
    const s = setup();
    s.session.start(req('p1'));
    expect(s.session.submit('p1', 'a\nb')).toBe(true);
    expect(s.ptys[0]!.write.mock.calls).toEqual([['\x1b[200~a\nb\x1b[201~']]);
    expect(s.timers[0]!.ms).toBe(GUI_SUBMIT_GAP_MS);
    s.fire(0);
    expect(s.ptys[0]!.write.mock.calls[1]).toEqual(['\r']);
  });
  it('refuses a second submit while the Enter is pending, then accepts one after it fires', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('p1', 'a\nb');
    expect(s.session.submit('p1', 'next')).toBe(false);
    s.fire(0);
    expect(s.session.submit('p1', 'next')).toBe(true);
  });
  it('refuses when not live, for blank text, and for non-strings', async () => {
    const s = setup();
    expect(s.session.submit('p1', 'hi')).toBe(false);
    s.session.start(req('p1'));
    expect(s.session.submit('p1', '   ')).toBe(false);
    expect(s.session.submit('p1', 7)).toBe(false);
  });
  it('drops the Enter if the pty exits between the two writes', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('p1', 'a\nb');
    s.ptys[0]!.fireExit();
    expect(s.timers[0]!.cancelled).toBe(true);
    s.timers[0]!.fn(); // even a timer that still fires must not write
    expect(s.ptys[0]!.write).toHaveBeenCalledTimes(1);
  });
  it('never writes a stale Enter into a replacement pty', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('p1', 'a\nb');
    s.session.start({ ...req('p1'), restart: true });
    expect(s.timers[0]!.cancelled).toBe(true);
    s.timers[0]!.fn(); // simulate the timer firing anyway after the new pty is live
    expect(s.ptys[1]!.write).not.toHaveBeenCalled();
    expect(s.session.submit('p1', 'ok')).toBe(true); // pending flag was cleared by the replace
  });
});

describe('guiSession.dispose', () => {
  it('cancels the pending Enter, kills, and refuses further work', async () => {
    const s = setup();
    s.session.start(req('p1'));
    s.session.submit('p1', 'a\nb');
    s.session.dispose();
    expect(s.timers[0]!.cancelled).toBe(true);
    expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
    expect((await s.session.start(req('p1'))).ok).toBe(false);
    expect(s.session.submit('p1', 'x')).toBe(false);
    expect(s.session.write('p1', 'x')).toBe(false);
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
    s.session.stop('p1');
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
    expect(s.session.live('p1')).toBe(false);
    s.ptys[0]!.fireExit();
    expect(await p).toEqual({ ok: true, reused: false });
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });
  it('an old pty that never exits is waited on for exactly GUI_KILL_WAIT_MS, then the new one spawns', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    const p = restart(s);
    await tick();
    expect(s.timers.filter((t) => t.ms === GUI_KILL_WAIT_MS)).toHaveLength(1);
    expect(s.spawn).toHaveBeenCalledTimes(1);
    s.fire(s.timers.findIndex((t) => t.ms === GUI_KILL_WAIT_MS));
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
    expect(s.timers.find((t) => t.ms === GUI_KILL_WAIT_MS)!.cancelled).toBe(true);
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
    s.session.stop('p1');
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
    s.session.stop('p1');
    const p = s.session.start(req('p1'));
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
    const p = s.session.start(req('p1', 0, 24));
    expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
    expect(s.session.live('p1')).toBe(false);
    expect(await p).toEqual({ ok: false, reason: 'bad-request' });
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

describe('guiSession dying set and process bound', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  // 3 live (p1, p2, q1) plus `dying` stopped-but-not-exited ptys (lingering ptys never exit by themselves)
  async function threeLive(dying: number) {
    const s = setup({ lingering: true });
    for (const k of ['p1', 'p2', 'q1']) await s.session.start(req(k));
    for (const k of ['q2', 'q3', 'q4'].slice(0, dying)) { await s.session.start(req(k)); s.session.stop(k); }
    return s;
  }
  it('refuses a start at 3 live + 3 dying (total 6) and accepts it at 3 live + 2 dying (total 5)', async () => {
    const s = await threeLive(3);
    expect(await s.session.start(req('q5'))).toEqual({ ok: false, reason: 'too-many-live' });
    expect(s.spawn).toHaveBeenCalledTimes(6);
    s.ptys[5]!.fireExit(); // one dying pty really exits
    expect((await s.session.start(req('q5'))).ok).toBe(true);
  });
  it('a restart of a live key is refused by the process bound too, and kills nothing when refused', async () => {
    const s = await threeLive(3);
    expect(await s.session.start({ ...req('p1'), restart: true })).toEqual({ ok: false, reason: 'too-many-live' });
    expect(s.ptys[0]!.kill).not.toHaveBeenCalled();
    expect(s.session.live('p1')).toBe(true);
  });
  it('a dying pty that never exits is dropped after GUI_DYING_MAX_MS and stops counting, without logging a path', async () => {
    const s = await threeLive(3);
    const t = s.timers.findIndex((x) => x.ms === GUI_DYING_MAX_MS);
    expect(t).toBeGreaterThanOrEqual(0);
    s.fire(t);
    expect(s.log).toHaveBeenCalledWith('gui session: pty did not exit');
    expect((await s.session.start(req('q5'))).ok).toBe(true);
  });
  it('an exit before the timeout cancels the drop timer', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    s.session.stop('p1');
    const t = s.timers.find((x) => x.ms === GUI_DYING_MAX_MS)!;
    s.ptys[0]!.fireExit();
    await tick();
    expect(t.cancelled).toBe(true);
    expect(s.log).not.toHaveBeenCalledWith('gui session: pty did not exit');
  });
  it('a same-key start waits for its own dying pty only; another key dying does not delay it', async () => {
    const s = setup({ lingering: true });
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    s.session.stop('p1');
    s.session.stop('p2');
    expect((await s.session.start(req('q1'))).ok).toBe(true); // p1/p2 dying do not delay q1
    const again = s.session.start(req('p1'));
    await tick();
    expect(s.spawn).toHaveBeenCalledTimes(3); // p1, p2, q1: p1 again is still waiting
    s.ptys[0]!.fireExit(); // p1's own pty; p2's pty is still dying
    expect(await again).toEqual({ ok: true, reused: false });
  });
});

describe('guiSession tree kill', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  function deferred() { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; }
  it('kills the tree BEFORE the pty and the pty kill waits for it', async () => {
    const order: string[] = [];
    const d = deferred();
    const s = setup({ killTree: (pid) => { order.push('tree ' + pid); return d.p; } });
    await s.session.start(req('p1'));
    s.ptys[0]!.kill.mockImplementation(() => { order.push('pty'); });
    s.session.stop('p1');
    await tick();
    expect(order).toEqual(['tree 1000']);
    d.resolve();
    await tick();
    expect(order).toEqual(['tree 1000', 'pty']);
  });
  it('replacement (restart) tree-kills the old pty once with its own pid, even on a repeated restart', async () => {
    const calls: number[] = [];
    const s = setup({ lingering: true, killTree: async (pid) => { calls.push(pid); } });
    await s.session.start(req('p1'));
    const first = s.session.start({ ...req('p1'), restart: true });
    await tick();
    const second = s.session.start({ ...req('p1'), restart: true });
    await tick();
    s.ptys[0]!.fireExit();
    await Promise.all([first, second]);
    expect(calls).toEqual([1000]);
  });
  it('does not call killTree for a pty that has already exited, and skips the pty kill if it exits during the tree kill', async () => {
    const killTree = vi.fn(async () => {});
    const s = setup({ killTree });
    await s.session.start(req('p1'));
    s.ptys[0]!.fireExit();
    s.session.stop('p1');
    expect(killTree).not.toHaveBeenCalled();
    const d = deferred();
    const s2 = setup({ lingering: true, killTree: () => d.p });
    await s2.session.start(req('p1'));
    s2.session.stop('p1');
    s2.ptys[0]!.fireExit();
    d.resolve();
    await tick();
    expect(s2.ptys[0]!.kill).not.toHaveBeenCalled();
  });
  it.each([4, 0, 1, -7, 1.5, Number.NaN, undefined, process.pid])('never tree-kills pid %s but still kills the pty', async (pid) => {
    const killTree = vi.fn(async () => {});
    const s = setup({ killTree, pid: () => pid });
    await s.session.start(req('p1'));
    s.session.stop('p1');
    expect(killTree).not.toHaveBeenCalled();
    expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
  });
  it('a rejecting, throwing or hanging killTree still reaches pty.kill(); the log carries no error text', async () => {
    for (const killTree of [() => Promise.reject(new Error('C:/secret/one')), () => { throw new Error('C:/secret/one'); }, () => new Promise<void>(() => {})]) {
      const s = setup({ lingering: true, killTree: killTree as (pid: number) => Promise<void> });
      await s.session.start(req('p1'));
      expect(() => s.session.stop('p1')).not.toThrow();
      await tick();
      const bound = s.timers.findIndex((t) => t.ms === GUI_TREE_KILL_MAX_MS);
      if (bound >= 0) s.fire(bound); // the hanging one: only the session's own bound releases it
      await tick();
      expect(s.ptys[0]!.kill).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(s.log.mock.calls)).not.toContain('secret');
    }
  });
  it('the dying entry exists before the tree-kill await, so the cap counts it from the decision', async () => {
    const d = deferred();
    const s = setup({ lingering: true, killTree: () => d.p });
    for (const k of ['p1', 'p2', 'q1', 'q2']) await s.session.start(req(k));
    s.session.stop('p1');
    s.session.stop('p2');
    s.session.stop('q1');
    expect(await s.session.start(req('q3'))).toEqual({ ok: true, reused: false }); // 1 live + 3 dying + new = fine
    expect(await s.session.start(req('q4'))).toEqual({ ok: true, reused: false });
    expect(await s.session.start(req('q5'))).toEqual({ ok: false, reason: 'too-many-live' }); // 3 live + 3 dying
  });
  it('a failed start kills the new pty through killTree too', async () => {
    const calls: number[] = [];
    const s = setup({ killTree: async (pid) => { calls.push(pid); } });
    s.flags.aliveThrows = true;
    expect(await s.session.start(req('p1'))).toEqual({ ok: false, reason: 'spawn-failed' });
    await tick();
    expect(calls).toEqual([1000]);
    expect(s.ptys[0]!.kill).toHaveBeenCalled();
  });
});

describe('guiSession dispose tree kill', () => {
  it('runs one synchronous killTreeSync with every live and dying pid, before any pty kill, then kills the ptys', async () => {
    const order: string[] = [];
    const killTreeSync = vi.fn((pids: number[]) => { order.push('tree ' + pids.join(',')); });
    const s = setup({ lingering: true, killTreeSync });
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    await s.session.start(req('q1'));
    s.session.stop('p1'); // dying, pid 1000
    s.ptys[2]!.fireExit(); // q1 gone: not included
    for (const p of s.ptys) p.kill.mockImplementation(() => { order.push('pty'); });
    s.session.dispose();
    expect(killTreeSync).toHaveBeenCalledTimes(1);
    expect(killTreeSync.mock.calls[0]![0].sort()).toEqual([1000, 1001]);
    expect(order[0]).toMatch(/^tree /);
    expect(order.slice(1)).toEqual(['pty', 'pty']);
  });
  it('swallows a throwing killTreeSync, still kills the ptys, and skips invalid pids', async () => {
    const killTreeSync = vi.fn(() => { throw new Error('C:/secret/one'); });
    const s = setup({ killTreeSync, pid: (i) => (i === 0 ? 4 : 2000 + i) });
    await s.session.start(req('p1'));
    await s.session.start(req('p2'));
    expect(() => s.session.dispose()).not.toThrow();
    expect(killTreeSync).toHaveBeenCalledWith([2001]);
    for (const p of s.ptys) expect(p.kill).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('secret');
  });
});

describe('trackExit pid', () => {
  it('reads pid once, at tracking time, and exposes it', () => {
    let reads = 0;
    const p = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), resize: vi.fn(), get pid() { reads++; return 4321; } };
    const t = trackExit(p as unknown as GuiPty);
    expect(t.pid).toBe(4321);
    t.pty.kill();
    expect(t.pid).toBe(4321);
    expect(reads).toBe(1);
  });
});
