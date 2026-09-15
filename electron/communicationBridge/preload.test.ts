import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld }, ipcRenderer: mocks }));
import '../preload';
describe('communication Electron wiring', () => {
  it('preload forwards only renderer controls and unsubscribes snapshots', () => {
    const api = mocks.exposeInMainWorld.mock.calls[0][1].communication;
    expect(Object.keys(api)).toEqual(['grantMore', 'startSession', 'snapshot', 'setEnabled', 'readPayload', 'cancel', 'clear', 'onSnapshot']);
    api.snapshot(); api.setEnabled(false); api.readPayload('id'); api.cancel('id'); api.clear('id');
    expect(mocks.invoke.mock.calls).toEqual([['communication:snapshot'], ['communication:setEnabled', false], ['communication:readPayload', 'id'], ['communication:cancel', 'id'], ['communication:clear', 'id']]);
    const callback = vi.fn(), off = api.onSnapshot(callback);
    const [channel, listener] = mocks.on.mock.calls[0];
    const snapshot = { enabled: false, metadata: [] };
    listener({}, snapshot); expect(callback).toHaveBeenCalledWith(snapshot);
    off(); expect(mocks.removeListener).toHaveBeenCalledWith(channel, listener);
    api.startSession(); api.grantMore('confirm-id');
    expect(mocks.invoke).toHaveBeenCalledWith('communication:startSession');
    expect(mocks.invoke).toHaveBeenCalledWith('communication:grantMore', 'confirm-id');
  });
  it('main constructs the service before window startup and gates quit before teardown', () => {
    const source = readFileSync('electron/main.ts', 'utf8');
    expect(source.indexOf('new CommunicationBridgeIntegration')).toBeLessThan(source.indexOf('app.whenReady()'));
    expect(source).toContain('event.sender === mainWindow.webContents');
    expect(source).toContain('event.senderFrame === mainWindow.webContents.mainFrame');
    expect(source).toMatch(/before-quit', event => \{\s*if \(!communicationQuitGate\(event\)\) return;\s*isQuitting = true/);
    expect(source).toMatch(/win.on\('close', \(event\) => \{\s*if \(!isQuitting && process.platform !== 'darwin'\) \{\s*event.preventDefault\(\);\s*app.quit\(\)/);
  });
});
