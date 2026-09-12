// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommunicationBridgeIntegration, type CommunicationBridgeOptions } from './mainIntegration';
import { connectPipeClient, startPipeServer, type PipeServerOptions } from './pipeServer';
import type { ProviderAdapter, TurnResult } from '../crossEngine/providers/contract';
import type { CommunicationStatusV1 } from '../../src/shared/communicationTypes';
import { ExchangeController } from './exchangeController';

function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const services: CommunicationBridgeIntegration[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); });
function fixture(options: CommunicationBridgeOptions = {}) {
  const provider: ProviderAdapter = {
    id: 'fake', capabilities: vi.fn(), connect: vi.fn(async () => {}),
    health: vi.fn(async () => ({ ready: true, authMode: 'subscription' as const, version: null, detail: '' })),
    newSession: vi.fn(async () => 'session'), sendTurn: vi.fn(() => new Promise<TurnResult>(() => {})),
    cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
  };
  const factory = vi.fn(() => provider);
  const service = new CommunicationBridgeIntegration({ providerFactory: factory,
    createWorkspace: async () => '/private/empty', removeWorkspace: async () => {},
    shutdownMs: 500, ...options });
  services.push(service); return { service, provider, factory };
}
async function waitFor(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { timeout: 1500, interval: 10 }); }

describe('main-owned communication integration', () => {
  it('owns deferred launch resources through disable and revokes before their cleanup', async () => {
    const created = deferred<void>(), removed = vi.fn();
    const { service, factory } = fixture({ startListener: async () => ({ endpoint: 'fake', close: async () => {} }) });
    await service.setEnabled(true); const launch = await service.prepareLaunch();
    expect(service.currentLaunchId()).toBe(launch.launchId);
    const cleanup = vi.fn(async () => { await created.promise; removed(); });
    service.attachLaunchCleanup(launch.launchId, cleanup);
    service.attachLaunchCleanup(launch.launchId, cleanup);
    const disabling = service.setEnabled(false);
    expect(service.currentLaunchId()).toBeUndefined();
    expect(service.snapshot().cleanup).toBe('pending');
    expect(await service.setEnabled(true)).toEqual({ ok: false, code: 'SHUTTING_DOWN' });
    expect(removed).not.toHaveBeenCalled(); created.resolve();
    expect(await disabling).toEqual({ ok: true });
    expect(cleanup).toHaveBeenCalledOnce(); expect(removed).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
  });
  it('cleans a late stale attachment and retains its failure without touching a replacement launch', async () => {
    const gate = deferred<void>();
    const { service } = fixture({ startListener: async () => ({ endpoint: 'fake', close: async () => {} }) });
    await service.setEnabled(true); const first = await service.prepareLaunch();
    await service.notifyClaudeExit(first.launchId); const second = await service.prepareLaunch();
    const cleanup = vi.fn(async () => { await gate.promise; throw new Error('private path'); });
    service.attachLaunchCleanup(first.launchId, cleanup);
    expect(service.currentLaunchId()).toBe(second.launchId);
    expect(service.snapshot().cleanup).toBe('pending');
    const disabling = service.setEnabled(false); gate.resolve();
    expect(await disabling).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(service.snapshot())).not.toContain('private path');
  });
  it('waits for resource ownership after listener cleanup rejects', async () => {
    const resource = deferred<void>();
    const { service } = fixture({ shutdownMs: 30,
      startListener: async () => ({ endpoint: 'fake', close: async () => { throw new Error('private'); } }) });
    await service.setEnabled(true); const launch = await service.prepareLaunch();
    const cleanup = vi.fn(() => resource.promise);
    service.attachLaunchCleanup(launch.launchId, cleanup);
    expect(await service.setEnabled(false)).toEqual({ ok: false, code: 'SHUTDOWN_TIMEOUT' });
    expect(await service.setEnabled(true)).toEqual({ ok: false, code: 'SHUTTING_DOWN' });
    resource.resolve();
    expect(await service.setEnabled(false)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('scopes grants to the confirmed launch and prevents replay without starting a provider', async () => {
    const { service, factory } = fixture({ startListener: async () => ({ endpoint: 'fake', close: async () => {} }) });
    expect(service.snapshot().remainingCredits).toBeUndefined();
    await service.setEnabled(true); const first = await service.prepareLaunch();
    expect(service.snapshot().remainingCredits).toBe(3);
    expect(service.grantCreditsForLaunch(first.launchId, 'confirmation')).toBe(true);
    expect(service.snapshot().remainingCredits).toBe(6);
    expect(service.grantCreditsForLaunch(first.launchId, 'confirmation')).toBe(false);
    expect(service.snapshot().remainingCredits).toBe(6);
    await service.notifyClaudeExit(first.launchId); const second = await service.prepareLaunch();
    expect(service.grantCreditsForLaunch(first.launchId, 'stale')).toBe(false);
    expect(service.snapshot().remainingCredits).toBe(3);
    expect(service.currentLaunchId()).toBe(second.launchId);
    await service.setEnabled(false);
    expect(service.grantCreditsForLaunch(second.launchId, 'after-disable')).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
  it('boots without Settings, disabled with no listener or provider work', async () => {
    const startListener = vi.fn(startPipeServer);
    const { service, factory } = fixture({ startListener });
    expect(service.snapshot()).toEqual({ enabled: false, readiness: 'disabled', cleanup: 'confirmed', metadata: [] });
    await expect(service.prepareLaunch()).rejects.toThrow('Bridge unavailable');
    expect(startListener).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  });
  it('awaits a real listener and requires authenticated discovery before ready', async () => {
    const { service } = fixture(); await service.setEnabled(true);
    const manifest = await service.prepareLaunch();
    expect(Buffer.from(manifest.capability, 'base64url')).toHaveLength(32);
    expect(service.snapshot().readiness).toBe('waiting');
    const client = await connectPipeClient(manifest);
    expect(service.snapshot().readiness).toBe('authenticated');
    client.markToolsListed(); await waitFor(() => service.snapshot().readiness === 'ready');
    const snapshot = JSON.stringify(service.snapshot());
    expect(snapshot).not.toContain(manifest.capability); expect(snapshot).not.toContain(manifest.endpoint);
    client.close(); await waitFor(() => service.snapshot().readiness === 'disconnected');
    await expect(connectPipeClient(manifest)).rejects.toThrow('Bridge unavailable');
  });
  it('disable erases payloads and revokes requests before asynchronous cleanup', async () => {
    const gate = deferred<void>(), snapshots: unknown[] = [];
    const { service, provider } = fixture({ onSnapshot: s => snapshots.push(s) });
    vi.mocked(provider.dispose).mockImplementation(() => gate.promise);
    await service.setEnabled(true); const manifest = await service.prepareLaunch();
    const client = await connectPipeClient(manifest);
    const accepted = await client.ask({ request_key: 'one', question: 'private question', context: 'private context' }) as CommunicationStatusV1;
    await waitFor(() => vi.mocked(provider.sendTurn).mock.calls.length === 1);
    expect(service.readPayload(accepted.exchange_id)?.question).toBe('private question');
    expect(provider.newSession).toHaveBeenCalledWith({ cwd: '/private/empty' });
    expect(JSON.stringify(snapshots)).not.toContain('private question');
    const disabled = service.setEnabled(false);
    expect(service.readPayload(accepted.exchange_id)).toBeUndefined();
    expect(service.snapshot()).toMatchObject({ enabled: false, metadata: [], cleanup: 'pending' });
    await expect(client.ask({ request_key: 'two', question: 'no' })).rejects.toThrow();
    await expect(connectPipeClient(manifest)).rejects.toThrow();
    gate.resolve(); expect(await disabled).toEqual({ ok: true });
    expect(service.snapshot().cleanup).toBe('confirmed');
  });
  it('retains safe cleanup failure after erasing all payloads, and refuses reactivation', async () => {
    const { service, provider } = fixture();
    vi.mocked(provider.dispose).mockRejectedValue(new Error('private diagnostic'));
    await service.setEnabled(true); const client = await connectPipeClient(await service.prepareLaunch());
    const accepted = await client.ask({ request_key: 'one', question: 'private question' }) as CommunicationStatusV1;
    await waitFor(() => vi.mocked(provider.sendTurn).mock.calls.length === 1);
    expect(await service.setEnabled(false)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    expect(service.readPayload(accepted.exchange_id)).toBeUndefined();
    expect(service.snapshot()).toMatchObject({ metadata: [], cleanup: 'failed' });
    expect(JSON.stringify(service.snapshot())).not.toContain('private');
    expect(await service.setEnabled(true)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    expect(await service.dispose()).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
  });
  it('bounds a hung cleanup and never labels timeout as confirmed exit', async () => {
    const gate = deferred<void>(); const { service, provider } = fixture({ shutdownMs: 30 });
    vi.mocked(provider.dispose).mockImplementation(() => gate.promise);
    await service.setEnabled(true); const client = await connectPipeClient(await service.prepareLaunch());
    await client.ask({ request_key: 'one', question: 'Question' });
    await waitFor(() => vi.mocked(provider.sendTurn).mock.calls.length === 1);
    expect(await service.dispose()).toEqual({ ok: false, code: 'SHUTDOWN_TIMEOUT' });
    expect(service.snapshot()).toMatchObject({ enabled: false, metadata: [], cleanup: 'pending' });
    gate.resolve();
  });
  it('distinguishes in-flight disable, successful disable, and final disposal', async () => {
    const closing = deferred<void>();
    const { service } = fixture({ startListener: async () => ({ endpoint: 'fake', close: () => closing.promise }) });
    await service.setEnabled(true); await service.prepareLaunch();
    const disabling = service.setEnabled(false);
    expect(await service.setEnabled(true)).toEqual({ ok: false, code: 'SHUTTING_DOWN' });
    closing.resolve(); expect(await disabling).toEqual({ ok: true });
    expect(await service.setEnabled(true)).toEqual({ ok: true });
    expect(await service.dispose()).toEqual({ ok: true });
    expect(await service.setEnabled(true)).toEqual({ ok: false, code: 'DISPOSED' });
  });
  it.each(['success', 'rejection'])('re-observes one timed-out cleanup through late %s', async outcome => {
    const closing = deferred<void>();
    const close = vi.fn(async () => { await closing.promise; if (outcome === 'rejection') throw new Error('private'); });
    const controllerDispose = vi.spyOn(ExchangeController.prototype, 'dispose');
    let facade: PipeServerOptions['client'] | undefined;
    const { service } = fixture({ shutdownMs: 50, startListener: async options => {
      facade = options.client; return { endpoint: 'fake', close };
    } });
    await service.setEnabled(true); await service.prepareLaunch();
    vi.useFakeTimers();
    try {
      const first = service.dispose();
      await vi.advanceTimersByTimeAsync(50);
      expect(await first).toEqual({ ok: false, code: 'SHUTDOWN_TIMEOUT' });
      expect(service.snapshot().cleanup).toBe('pending');
      expect(await service.setEnabled(true)).toEqual({ ok: false, code: 'SHUTTING_DOWN' });
      await expect(service.prepareLaunch()).rejects.toThrow('Bridge unavailable');
      expect(facade!.ask({ request_key: 'revoked', question: 'No work' })).toMatchObject({ code: 'DISABLED' });
      const second = service.dispose();
      await vi.advanceTimersByTimeAsync(50);
      expect(await second).toEqual({ ok: false, code: 'SHUTDOWN_TIMEOUT' });
      expect(close).toHaveBeenCalledTimes(1);
      expect(controllerDispose).toHaveBeenCalledTimes(1);
      const observing = service.dispose();
      closing.resolve();
      await vi.advanceTimersByTimeAsync(0);
      // Late completion must update authority without a new request or snapshot subscriber.
      expect(service.snapshot().cleanup).toBe(outcome === 'success' ? 'confirmed' : 'failed');
      expect(await observing).toEqual(outcome === 'success' ? { ok: true } : { ok: false, code: 'CLEANUP_FAILED' });
      expect(await service.dispose()).toEqual(await observing);
      expect(await service.setEnabled(true)).toEqual({ ok: false, code: outcome === 'success' ? 'DISPOSED' : 'CLEANUP_FAILED' });
      expect(close).toHaveBeenCalledTimes(1);
      expect(controllerDispose).toHaveBeenCalledTimes(1);
    } finally { closing.resolve(); vi.useRealTimers(); controllerDispose.mockRestore(); }
  });
  it.each(['before', 'after'])('preserves cleanup failure when payload is cleared %s cleanup settles', async when => {
    const gate = deferred<void>(); const { service, provider } = fixture();
    vi.mocked(provider.dispose).mockImplementation(async () => { await gate.promise; throw new Error('private failure'); });
    await service.setEnabled(true); const client = await connectPipeClient(await service.prepareLaunch());
    const accepted = await client.ask({ request_key: 'one', question: 'private question' }) as CommunicationStatusV1;
    await waitFor(() => vi.mocked(provider.sendTurn).mock.calls.length === 1);
    service.cancel(accepted.exchange_id);
    if (when === 'before') { service.clear(accepted.exchange_id); expect(service.snapshot().cleanup).toBe('pending'); }
    gate.resolve(); await waitFor(() => service.snapshot().cleanup === 'failed');
    service.clear(accepted.exchange_id);
    expect(service.snapshot()).toMatchObject({ cleanup: 'failed', metadata: [] });
    expect(await service.setEnabled(true)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    await expect(service.prepareLaunch()).rejects.toThrow('Bridge unavailable');
  });
  it('does not let an earlier helper close mark a pending disable clean', async () => {
    const gate = deferred<void>(); const { service, provider } = fixture();
    vi.mocked(provider.dispose).mockImplementation(() => gate.promise);
    await service.setEnabled(true); const manifest = await service.prepareLaunch(); const client = await connectPipeClient(manifest);
    await client.ask({ request_key: 'one', question: 'Question' });
    await waitFor(() => vi.mocked(provider.sendTurn).mock.calls.length === 1);
    const exiting = service.notifyClaudeExit(manifest.launchId), disabling = service.setEnabled(false);
    expect(await exiting).toEqual({ ok: true });
    expect(service.snapshot().cleanup).toBe('pending');
    gate.resolve(); expect(await disabling).toEqual({ ok: true });
  });
  it('latches failed cleanup without a snapshot reader or subscriber', async () => {
    const { service, provider } = fixture();
    vi.mocked(provider.dispose).mockRejectedValue(new Error('cleanup failed'));
    await service.setEnabled(true); const client = await connectPipeClient(await service.prepareLaunch());
    const accepted = await client.ask({ request_key: 'one', question: 'Question' }) as CommunicationStatusV1;
    await waitFor(() => vi.mocked(provider.sendTurn).mock.calls.length === 1);
    service.clear(accepted.exchange_id);
    await waitFor(() => vi.mocked(provider.dispose).mock.calls.length === 1);
    // Flush the rejection and controller-finally continuations, without reading snapshot.
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(await service.setEnabled(true)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
  });
  it('sanitizes synchronous listener startup failure and revokes its facade', async () => {
    let captured: PipeServerOptions | undefined;
    const { service } = fixture({ startListener: options => { captured = options; throw new Error('secret'); } });
    await service.setEnabled(true); await expect(service.prepareLaunch()).rejects.toThrow('Bridge unavailable');
    expect(service.snapshot().readiness).toBe('disconnected');
    expect(captured!.client.ask({ request_key: 'one', question: 'Question' })).toMatchObject({ code: 'NOT_CONNECTED' });
  });
  it('Claude exit cancels active work and old exit callbacks cannot revoke a new launch', async () => {
    const callbacks: PipeServerOptions[] = [];
    const { service, provider } = fixture({ startListener: opts => { callbacks.push(opts); return startPipeServer(opts); } });
    await service.setEnabled(true); const first = await service.prepareLaunch();
    const client = await connectPipeClient(first);
    await client.ask({ request_key: 'one', question: 'Question' });
    await waitFor(() => vi.mocked(provider.sendTurn).mock.calls.length === 1);
    expect(await service.notifyClaudeExit(first.launchId)).toEqual({ ok: true });
    await waitFor(() => vi.mocked(provider.dispose).mock.calls.length === 1);
    const second = await service.prepareLaunch(); const nextClient = await connectPipeClient(second);
    expect(second.capability).not.toBe(first.capability);
    callbacks[0].onDisconnect?.(); callbacks[0].onAuthenticated?.(); callbacks[0].onToolsListed?.();
    await service.notifyClaudeExit(first.launchId);
    expect(service.snapshot().readiness).toBe('authenticated');
    expect(await nextClient.ask({ request_key: 'new', question: 'Question' })).toHaveProperty('exchange_id');
    nextClient.close();
  });
  it('closes a listener that becomes ready after disable without returning a usable manifest', async () => {
    const gate = deferred<void>(), entered = deferred<void>();
    let endpoint = '', capability = '';
    const { service } = fixture({ startListener: async options => {
      const listener = await startPipeServer(options); endpoint = listener.endpoint; capability = options.capability;
      entered.resolve(); await gate.promise; return listener;
    } });
    await service.setEnabled(true); const preparing = service.prepareLaunch();
    const rejected = expect(preparing).rejects.toThrow('Bridge unavailable');
    await entered.promise; const disabled = service.setEnabled(false);
    // Even while close waits for startup, the bound facade has lost its authority.
    const client = await connectPipeClient({ endpoint, capability });
    expect(await client.ask({ request_key: 'late', question: 'Question' })).toMatchObject({ code: 'DISABLED' });
    gate.resolve(); await rejected; expect(await disabled).toEqual({ ok: true });
    await expect(connectPipeClient({ endpoint, capability })).rejects.toThrow();
  });
  it('serializes concurrent prepares and revokes the previous listener', async () => {
    const { service } = fixture(); await service.setEnabled(true);
    const [first, second] = await Promise.all([service.prepareLaunch(), service.prepareLaunch()]);
    await expect(connectPipeClient(first)).rejects.toThrow();
    const client = await connectPipeClient(second); expect(service.snapshot().readiness).toBe('authenticated'); client.close();
  });
  it('surfaces listener close failure without leaking raw diagnostics', async () => {
    const { service } = fixture({ startListener: async () => ({ endpoint: 'fake', close: async () => { throw new Error('secret'); } }) });
    await service.setEnabled(true); await service.prepareLaunch();
    expect(await service.setEnabled(false)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    expect(service.snapshot().cleanup).toBe('failed');
    await expect(service.prepareLaunch()).rejects.toThrow('Bridge unavailable');
  });
});
