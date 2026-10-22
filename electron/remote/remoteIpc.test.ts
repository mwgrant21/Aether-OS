// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld }, ipcRenderer: mocks }));
import '../preload';
import { registerRemoteIpc, type RemoteHubLike } from './remoteIpc';
import type { RemoteStatus } from '../../src/shared/remote/types';

const STATUS: RemoteStatus = { state: 'off', reason: null, address: null, clients: 0, sessions: [], pairingActive: false, following: false, notice: null };

function setup(opts: { trusted?: boolean; confirm?: boolean } = {}) {
  const hub = {
    init: vi.fn(), status: vi.fn(() => STATUS), setEnabled: vi.fn(async () => STATUS),
    createPairing: vi.fn(async () => ({ ok: false as const, reason: 'not-enabled' as const })),
    revokeAll: vi.fn(async () => STATUS), revokeOne: vi.fn(async () => STATUS),
  };
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const confirm = vi.fn(async () => opts.confirm ?? true);
  registerRemoteIpc({ handle: (c: string, h: never) => { handlers.set(c, h); } } as never, hub as unknown as RemoteHubLike, () => opts.trusted ?? true, confirm);
  const call = (ch: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!({}, ...args));
  return { hub, call, confirm, handlers };
}

describe('registerRemoteIpc', () => {
  it('registers exactly the five remote channels', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(['remote:createPairing', 'remote:revokeAll', 'remote:revokeOne', 'remote:setEnabled', 'remote:status']);
  });

  it('rejects an untrusted sender on every channel without touching the hub or the dialog', async () => {
    const { hub, call, confirm } = setup({ trusted: false });
    const calls: Array<[string, unknown[]]> = [['remote:status', []], ['remote:setEnabled', [true]], ['remote:createPairing', []], ['remote:revokeAll', []], ['remote:revokeOne', ['a'.repeat(12)]]];
    for (const [ch, args] of calls) await expect(call(ch, ...args)).rejects.toThrow('NOT_AUTHORIZED');
    expect(Object.values(hub).every(f => f.mock.calls.length === 0)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments', async () => {
    const { hub, call } = setup();
    await expect(call('remote:setEnabled', 'yes')).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:setEnabled')).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:setEnabled', true, 1)).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:revokeOne', 'zz')).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:revokeOne', 'a'.repeat(64))).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:revokeOne', 'A'.repeat(12))).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:revokeOne', 'a'.repeat(12), 'x')).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:status', 1)).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:createPairing', 1)).rejects.toThrow('INVALID_INPUT');
    await expect(call('remote:revokeAll', 1)).rejects.toThrow('INVALID_INPUT');
    expect(hub.setEnabled).not.toHaveBeenCalled();
    expect(hub.revokeOne).not.toHaveBeenCalled();
  });

  it('does not enable when the native confirm is declined, and returns the current status', async () => {
    const { hub, call, confirm } = setup({ confirm: false });
    await expect(call('remote:setEnabled', true)).resolves.toBe(STATUS);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(hub.setEnabled).not.toHaveBeenCalled();
  });

  it('enables after the confirm is accepted, and never prompts to disable', async () => {
    const { hub, call, confirm } = setup({ confirm: true });
    await call('remote:setEnabled', true);
    expect(hub.setEnabled).toHaveBeenCalledWith(true);
    confirm.mockClear();
    await call('remote:setEnabled', false);
    expect(confirm).not.toHaveBeenCalled();
    expect(hub.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('calls hub.init first and forwards the valid commands', async () => {
    const { hub, call } = setup();
    await call('remote:status'); await call('remote:createPairing'); await call('remote:revokeAll'); await call('remote:revokeOne', 'abcdef012345');
    expect(hub.init).toHaveBeenCalledTimes(4);
    expect(hub.createPairing).toHaveBeenCalledTimes(1);
    expect(hub.revokeAll).toHaveBeenCalledTimes(1);
    expect(hub.revokeOne).toHaveBeenCalledWith('abcdef012345');
  });
});

describe('remote preload and main wiring', () => {
  it('preload forwards the six remote members to their channels and unsubscribes', () => {
    const api = mocks.exposeInMainWorld.mock.calls[0][1].remote;
    expect(Object.keys(api)).toEqual(['status', 'setEnabled', 'createPairing', 'revokeAll', 'revokeOne', 'onStatus']);
    mocks.invoke.mockClear();
    api.status(); api.setEnabled(true); api.createPairing(); api.revokeAll(); api.revokeOne('abcdef012345');
    expect(mocks.invoke.mock.calls).toEqual([['remote:status'], ['remote:setEnabled', true], ['remote:createPairing'], ['remote:revokeAll'], ['remote:revokeOne', 'abcdef012345']]);
    const cb = vi.fn(), off = api.onStatus(cb);
    const call = mocks.on.mock.calls.find(c => c[0] === 'remote:statusChanged')!;
    call[1]({}, STATUS);
    expect(cb).toHaveBeenCalledWith(STATUS);
    off();
    expect(mocks.removeListener).toHaveBeenCalledWith('remote:statusChanged', call[1]);
  });

  const main = readFileSync('electron/main.ts', 'utf8');
  it('main inits the hub only after the private dir, from one hub created at start', () => {
    expect(main).toContain('void privateDirReady.then(() => remoteHub.init());');
    expect(main.indexOf('ensurePrivateDir(aetherOsDir)')).toBeLessThan(main.indexOf('void privateDirReady.then(() => remoteHub.init());'));
    expect(main.match(/createRemoteHub\(/g)).toHaveLength(1);
  });

  it('main stops the hub inside the held first quit, before isQuitting is set, and logs a failed flush', () => {
    const gate = main.slice(main.indexOf('const baselineQuitGate'), main.indexOf('let lastStallCheckMs'));
    expect(gate).toContain('remoteHub.stop()');
    expect(gate).toContain('remoteHub.status().notice');
    expect(gate).toContain('remote session store not saved at quit');
    expect(main.indexOf('const baselineQuitGate')).toBeLessThan(main.indexOf("app.on('before-quit'"));
  });

  it('the createRemoteHub block references no pty or lifecycle code and the dialog guards enabling', () => {
    const start = main.indexOf('createRemoteHub({');
    const block = main.slice(start, main.indexOf('registerRemoteIpc(', start));
    expect(block).not.toMatch(/Lifecycle|pty/i);
    const reg = main.slice(main.indexOf('registerRemoteIpc('), main.indexOf('registerRemoteIpc(') + 1800);
    expect(reg).toContain('event.sender === mainWindow.webContents');
    expect(reg).toContain('event.senderFrame === mainWindow.webContents.mainFrame');
    expect(reg).toContain('showMessageBox');
    expect(reg).toContain('response === 1');
    expect(reg).toContain('defaultId: 0');
  });
});
