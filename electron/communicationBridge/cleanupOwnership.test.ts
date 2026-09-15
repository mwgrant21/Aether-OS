// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { spawnProviderProcess } from '../crossEngine/providers/providerProcess';
import { CodexAppServerAdapter } from '../crossEngine/providers/codexAppServer';
import { CommunicationBridgeIntegration } from './mainIntegration';
import { ExchangeController, type ExchangeClient } from './exchangeController';

// Control only the OS host and its files. Provider supervision, adapter disposal,
// exchange ownership, and the bounded main-process wait are production code.
const os = vi.hoisted(() => ({ spawn: vi.fn(), mkdtempSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: os.spawn }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(),
  mkdtempSync: os.mkdtempSync, readFileSync: os.readFileSync, writeFileSync: os.writeFileSync, rmSync: os.rmSync }));

async function flush() { for (let n = 0; n < 40; n++) await Promise.resolve(); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  for (const mock of Object.values(os)) mock.mockReset();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const directory = 'C:/controlled-supervision';
  os.mkdtempSync.mockReturnValue(directory);
  os.readFileSync.mockImplementation(() => { throw new Error('missing receipt'); });
  const host = new EventEmitter() as ChildProcessWithoutNullStreams;
  host.stdin = new PassThrough(); host.stdout = new PassThrough(); host.stderr = new PassThrough();
  const methods: string[] = [];
  host.stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk)); methods.push(request.method);
    const result = request.method === 'initialize' ? { userAgent: 'controlled host' }
      : request.method === 'account/read' ? { account: { type: 'chatgpt' } }
        : request.method === 'config/read' ? { config: { mcp_servers: {} } }
          : request.method === 'thread/start' ? { thread: { id: 'thread' } }
            : request.method === 'turn/start' ? { turn: { id: 'turn', status: 'inProgress' } } : {};
    (host.stdout as PassThrough).write(JSON.stringify({ id: request.id, result }) + '\n');
  });
  os.spawn.mockReturnValue(host);
  const spawn = vi.fn((cwd?: string) => spawnProviderProcess('controlled-provider', [], {}, cwd));
  const adapter = new CodexAppServerAdapter(spawn, undefined, '/private/workspace');
  const providerFactory = vi.fn(() => adapter), removeWorkspace = vi.fn(async () => {});
  const controllerDispose = vi.spyOn(ExchangeController.prototype, 'dispose');
  let client!: ExchangeClient;
  const service = new CommunicationBridgeIntegration({ providerFactory,
    createWorkspace: async () => '/private/workspace', removeWorkspace,
    startListener: async options => { client = options.client; return { endpoint: 'controlled-pipe', close: async () => {} }; },
  });
  await service.setEnabled(true); await service.prepareLaunch();
  expect(client.ask({ request_key: 'first', question: 'Controlled test only' })).toMatchObject({ provider_state: 'accepted' });
  await vi.runAllTicks(); await flush();
  expect(methods).toContain('turn/start');
  expect(spawn).toHaveBeenCalledWith('/private/workspace');
  return { service, client, adapter, host, directory, spawn, providerFactory, removeWorkspace, controllerDispose,
    close: (receipt = 'empty') => { os.readFileSync.mockReturnValue(receipt); host.emit('close', 0); } };
}

describe('supervised cleanup ownership through the actual provider stack', () => {
  it('keeps one cleanup pending past both deadlines and releases ownership only after late host proof', async () => {
    const f = await fixture();
    const disabling = f.service.setEnabled(false);
    await flush();
    const disposal = f.adapter.dispose();
    expect(f.adapter.dispose()).toBe(disposal);
    let settled = false;
    void disposal.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(settled).toBe(false);
    expect(f.service.snapshot().cleanup).toBe('pending');
    expect(os.readFileSync).not.toHaveBeenCalled();
    expect(os.rmSync).not.toHaveBeenCalled();
    expect(f.removeWorkspace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(await disabling).toEqual({ ok: false, code: 'SHUTDOWN_TIMEOUT' });
    expect(await f.service.setEnabled(true)).toEqual({ ok: false, code: 'SHUTTING_DOWN' });
    await expect(f.service.prepareLaunch()).rejects.toThrow('Bridge unavailable');
    expect(f.client.ask({ request_key: 'blocked', question: 'No work' })).toMatchObject({ code: 'DISABLED' });
    const observing = f.service.setEnabled(false);
    expect(f.adapter.dispose()).toBe(disposal);
    expect(f.controllerDispose).toHaveBeenCalledOnce();
    expect(f.providerFactory).toHaveBeenCalledOnce(); expect(os.spawn).toHaveBeenCalledOnce();
    expect(os.writeFileSync.mock.calls).toEqual([[join(f.directory, 'stop'), 'stop']]);
    os.readFileSync.mockReturnValue('empty'); // A receipt alone is not host-close proof.
    await flush();
    expect(settled).toBe(false); expect(f.removeWorkspace).not.toHaveBeenCalled();
    f.close(); await flush();
    expect(await observing).toEqual({ ok: true });
    expect(f.service.snapshot().cleanup).toBe('confirmed');
    expect(f.removeWorkspace.mock.calls).toEqual([['/private/workspace']]);
    expect(os.rmSync.mock.calls).toEqual([[f.directory, { recursive: true, force: true }]]);
    expect(await f.service.setEnabled(false)).toEqual({ ok: true });
    expect(await f.service.setEnabled(true)).toEqual({ ok: true });
    expect(os.writeFileSync).toHaveBeenCalledOnce(); expect(os.spawn).toHaveBeenCalledOnce();
    await f.service.dispose();
  });

  it.each(['missing receipt', 'invalid receipt', 'file removal', 'stop write'])('retains actual %s failure after late host close', async failure => {
    const f = await fixture();
    if (failure === 'stop write') os.writeFileSync.mockImplementation(() => { throw new Error('stop write denied'); });
    const disabling = f.service.setEnabled(false); await flush();
    const disposal = f.adapter.dispose();
    const rejected = disposal.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await disabling).toEqual({ ok: false, code: failure === 'stop write' ? 'CLEANUP_FAILED' : 'SHUTDOWN_TIMEOUT' });
    if (failure === 'file removal') os.rmSync.mockImplementation(() => { throw new Error('removal denied'); });
    if (failure === 'missing receipt') f.host.emit('close', 0);
    else f.close(failure === 'invalid receipt' ? 'not-empty' : 'empty');
    await flush(); expect(await rejected).toBeInstanceOf(Error);
    expect(f.adapter.dispose()).toBe(disposal);
    expect(f.service.snapshot().cleanup).toBe('failed');
    expect(await f.service.setEnabled(false)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    expect(await f.service.setEnabled(true)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    await expect(f.adapter.connect()).rejects.toThrow();
    expect(f.removeWorkspace).not.toHaveBeenCalled();
    expect(os.writeFileSync).toHaveBeenCalledOnce(); expect(os.spawn).toHaveBeenCalledOnce();
    expect(f.controllerDispose).toHaveBeenCalledOnce();
    expect(os.rmSync).toHaveBeenCalledOnce();
    await f.service.dispose();
  });
});
