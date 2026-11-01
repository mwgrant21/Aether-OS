// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld }, ipcRenderer: mocks }));
import '../preload';
import { spawn } from 'node:child_process';
import { createVoiceSession } from './voiceSession';
import { registerVoiceIpc, type VoiceHubLike } from './voiceIpc';
import type { VoiceStatus } from '../../src/shared/voice/types';

const STATUS: VoiceStatus = { state: 'off', reason: null, address: null, connected: false, session: 'none', sessions: [], pairingActive: false, notice: null };

function setup(opts: { trusted?: boolean; confirm?: boolean } = {}) {
  const hub = {
    init: vi.fn(), status: vi.fn(() => STATUS), setEnabled: vi.fn(async () => STATUS),
    createPairing: vi.fn(async () => ({ ok: false as const, reason: 'not-enabled' as const })),
    revokeAll: vi.fn(async () => STATUS), revokeOne: vi.fn(async () => STATUS),
  };
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const confirm = vi.fn(async () => opts.confirm ?? true);
  registerVoiceIpc({ handle: (c: string, h: never) => { handlers.set(c, h); } } as never, hub as unknown as VoiceHubLike, () => opts.trusted ?? true, confirm);
  const call = (ch: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!({}, ...args));
  return { hub, call, confirm, handlers };
}

describe('registerVoiceIpc', () => {
  it('registers exactly the five voice channels', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(['voice:createPairing', 'voice:revokeAll', 'voice:revokeOne', 'voice:setEnabled', 'voice:status']);
  });

  it('rejects an untrusted sender on every channel without touching the hub or the dialog', async () => {
    const { hub, call, confirm } = setup({ trusted: false });
    const calls: Array<[string, unknown[]]> = [['voice:status', []], ['voice:setEnabled', [true]], ['voice:createPairing', []], ['voice:revokeAll', []], ['voice:revokeOne', ['a'.repeat(12)]]];
    for (const [ch, args] of calls) await expect(call(ch, ...args)).rejects.toThrow('NOT_AUTHORIZED');
    expect(Object.values(hub).every(f => f.mock.calls.length === 0)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments', async () => {
    const { hub, call } = setup();
    await expect(call('voice:setEnabled', 'yes')).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:setEnabled')).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:setEnabled', true, 1)).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:revokeOne', 'zz')).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:revokeOne', 'A'.repeat(12))).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:revokeOne', 'abcdef012345\n')).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:revokeOne', 'a'.repeat(12), 'x')).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:status', 1)).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:createPairing', 1)).rejects.toThrow('INVALID_INPUT');
    await expect(call('voice:revokeAll', 1)).rejects.toThrow('INVALID_INPUT');
    expect(hub.setEnabled).not.toHaveBeenCalled();
    expect(hub.revokeOne).not.toHaveBeenCalled();
  });

  it('does not enable when the native confirm is declined, and returns the current status', async () => {
    const { hub, call, confirm } = setup({ confirm: false });
    await expect(call('voice:setEnabled', true)).resolves.toBe(STATUS);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(hub.setEnabled).not.toHaveBeenCalled();
  });

  it('does not enable when the confirm throws or never resolves', async () => {
    const thrown = setup();
    thrown.confirm.mockImplementationOnce(async () => { throw new Error('dialog failed'); });
    await expect(thrown.call('voice:setEnabled', true)).rejects.toThrow('dialog failed');
    expect(thrown.hub.setEnabled).not.toHaveBeenCalled();
    const hung = setup();
    hung.confirm.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    void hung.call('voice:setEnabled', true);
    await new Promise(r => setTimeout(r, 20));
    expect(hung.hub.setEnabled).not.toHaveBeenCalled();
  });

  it('enables only after the confirm resolves, and never prompts to disable', async () => {
    const { hub, call, confirm } = setup({ confirm: true });
    let release: (v: boolean) => void = () => {};
    confirm.mockImplementationOnce(() => new Promise<boolean>(r => { release = r; }));
    const pending = call('voice:setEnabled', true);
    await new Promise(r => setTimeout(r, 0));
    expect(hub.setEnabled).not.toHaveBeenCalled();
    release(true);
    await pending;
    expect(hub.setEnabled).toHaveBeenCalledWith(true);
    confirm.mockClear();
    await call('voice:setEnabled', false);
    expect(confirm).not.toHaveBeenCalled();
    expect(hub.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('calls hub.init first and forwards the valid commands', async () => {
    const { hub, call } = setup();
    await call('voice:status'); await call('voice:createPairing'); await call('voice:revokeAll'); await call('voice:revokeOne', 'abcdef012345');
    expect(hub.init).toHaveBeenCalledTimes(4);
    expect(hub.createPairing).toHaveBeenCalledTimes(1);
    expect(hub.revokeAll).toHaveBeenCalledTimes(1);
    expect(hub.revokeOne).toHaveBeenCalledWith('abcdef012345');
  });
});

describe('voice preload and main wiring', () => {
  it('preload forwards the six voice members to their channels and unsubscribes', () => {
    const api = mocks.exposeInMainWorld.mock.calls[0][1].voice;
    expect(Object.keys(api)).toEqual(['status', 'setEnabled', 'createPairing', 'revokeAll', 'revokeOne', 'onStatus']);
    mocks.invoke.mockClear();
    api.status(); api.setEnabled(true); api.createPairing(); api.revokeAll(); api.revokeOne('abcdef012345');
    expect(mocks.invoke.mock.calls).toEqual([['voice:status'], ['voice:setEnabled', true], ['voice:createPairing'], ['voice:revokeAll'], ['voice:revokeOne', 'abcdef012345']]);
    const cb = vi.fn(), off = api.onStatus(cb);
    const call = mocks.on.mock.calls.find(c => c[0] === 'voice:statusChanged')!;
    call[1]({}, STATUS);
    expect(cb).toHaveBeenCalledWith(STATUS);
    off();
    expect(mocks.removeListener).toHaveBeenCalledWith('voice:statusChanged', call[1]);
  });

  const main = readFileSync('electron/main.ts', 'utf8');
  it('main stops the voice hub inside the quit gate callback, guarded by the private dir', () => {
    const gate = main.slice(main.indexOf('const baselineQuitGate'), main.indexOf('let lastStallCheckMs'));
    expect(gate).toContain('remoteDirReady ? voiceHub.stop().catch(');
    expect(gate).toContain('[diag] voice stop failed at quit');
  });

  const KILL_GRACE = Number(/const VOICE_KILL_GRACE_MS = (\d+);/.exec(main)?.[1]);
  it('main passes a kill grace to the voice session that fits twice inside the 1500 ms quit bound', () => {
    expect(Number.isInteger(KILL_GRACE)).toBe(true);
    expect(KILL_GRACE * 2).toBeLessThan(1500 - 300);
    const start = main.indexOf('createVoiceHub({');
    const block = main.slice(start, main.indexOf('const voiceStatusOrUnavailable', start));
    expect(block).toContain('createVoiceSession({ ...d, killGraceMs: VOICE_KILL_GRACE_MS })');
  });

  it('stop() ends stdin, then waits and kills a child that ignores EOF using exactly the main.ts grace', async () => {
    // Wall-clock latency depends on machine load, so assert the structure instead: the order of events and the
    // timer delays the session requested (via its setTimeoutFn seam), plus a generous liveness window for the death.
    const events: string[] = [];
    const delays: number[] = [];
    let recording = false;
    const session = createVoiceSession({
      killGraceMs: KILL_GRACE,
      setTimeoutFn: (fn, ms) => { if (recording) { delays.push(ms); events.push('wait'); } return setTimeout(fn, ms); },
      spawnFn: (_args, opts) => {
        const c = spawn(process.execPath, ['-e', 'process.stdin.on("data",()=>{});process.stdin.on("end",()=>{});setInterval(()=>{},1000)'], opts);
        const end = c.stdin!.end.bind(c.stdin);
        c.stdin!.end = ((...a: unknown[]) => { events.push('eof'); return (end as (...x: unknown[]) => unknown)(...a); }) as never;
        return c;
      },
    });
    session.start();
    const pid = session.pid();
    expect(pid).not.toBeNull();
    recording = true;
    await session.stop();
    // EOF first, then a full grace wait (child ignored it), then the kill path and a second grace wait.
    expect(events).toEqual(['eof', 'wait', 'wait']);
    expect(delays).toEqual([KILL_GRACE, KILL_GRACE]);
    const end = Date.now() + 5000;
    const alive = (): boolean => { try { process.kill(pid as number, 0); return true; } catch { return false; } };
    while (alive() && Date.now() < end) await new Promise(r => setTimeout(r, 25));
    expect(alive()).toBe(false);
  }, 20_000);

  it('main registers the voice IPC behind the trusted-window predicate and a native confirm', () => {
    expect(main).toContain('registerVoiceIpc(');
    const reg = main.slice(main.indexOf('registerVoiceIpc('), main.indexOf('registerVoiceIpc(') + 2200);
    expect(reg).toContain('event.sender === mainWindow.webContents');
    expect(reg).toContain('event.senderFrame === mainWindow.webContents.mainFrame');
    expect(reg).toContain('showMessageBox');
    expect(reg).toContain("buttons: ['Cancel', 'Allow voice gateway']");
    expect(reg).toContain('defaultId: 0');
    expect(reg).toContain('cancelId: 0');
    expect(reg).toContain('response === 1');
    for (const phrase of ['under your Claude subscription', 'same tool permissions', 'explicit tap on the phone', 'masked for obvious secrets', 'any device on your tailnet', 'stay paired for up to ${VOICE_TTL_DAYS} days, until you revoke them', 'turns off when Aether restarts', 'no transcript on disk']) {
      expect(reg).toContain(phrase);
    }
  });

  it('main gates voice init on the private dir and the hub block references no pty or lifecycle code', () => {
    expect(main).toContain('init: () => { if (remoteDirReady) voiceHub.init(); }');
    expect(main.match(/createVoiceHub\(/g)).toHaveLength(1);
    const start = main.indexOf('createVoiceHub({');
    const block = main.slice(start, main.indexOf('const voiceStatusOrUnavailable', start));
    expect(block).not.toMatch(/Lifecycle|pty/i);
    expect(block).toContain("join(aetherOsDir, 'voice-sessions.json')");
    const ipc = main.slice(main.indexOf('const voiceHubForIpc'), main.indexOf('registerVoiceIpc('));
    for (const m of ['setEnabled', 'createPairing', 'revokeAll', 'revokeOne']) {
      expect(ipc).toMatch(new RegExp(m + ':[^\n]*remoteQuitting [|][|] !remoteDirReady [?]'));
    }
    expect(main).toMatch(/voiceHub[.]init[(][)];.{0,160}sendToWindow[(]'voice:statusChanged', voiceHub[.]status[(][)][)]/s);
  });
});
