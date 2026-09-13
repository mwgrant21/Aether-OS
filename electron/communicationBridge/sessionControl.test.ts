// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommunicationBridgeIntegration } from './mainIntegration';
import { CommunicationSessionControl } from './sessionControl';
const services: CommunicationBridgeIntegration[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });
function setup() {
  const bridge = new CommunicationBridgeIntegration({ providerFactory: () => { throw new Error('No model calls'); } });
  services.push(bridge);
  const bundle = { cleanup: vi.fn(async () => {}), completion: vi.fn(async () => 'running' as 'unknown' | 'starting' | 'running' | 'exited' | 'failed') };
  const options = { bridge, confirm: vi.fn(async () => true), prepare: vi.fn(async () => bundle), spawn: vi.fn(), pollMs: 5 };
  return { bridge, bundle, options, control: new CommunicationSessionControl(options) };
}
describe('operator session control', () => {
  it('keeps helper loss independent from client exit and samples before removing receipts', async () => {
    const { bridge, bundle, control } = setup(); await bridge.setEnabled(true);
    await control.start(); const id = bridge.currentLaunchId()!;
    await bridge.notifyClaudeExit(id);
    expect(bundle.completion).toHaveBeenCalled();
    expect(bundle.completion.mock.invocationCallOrder[0]).toBeLessThan(bundle.cleanup.mock.invocationCallOrder[0]);
    expect(bridge.snapshot().sessionStatus).toMatchObject({ client: 'running', connected: false });
    bundle.completion.mockResolvedValue('exited');
    await vi.waitFor(() => expect(bridge.snapshot().sessionStatus.client).toBe('exited'));
    expect(bridge.currentLaunchId()).toBeUndefined();
  });
  it.each(['failed', 'read-error', 'spawn-error'])('never publishes client exited for %s', async failure => {
    const { bridge, bundle, options, control } = setup(); await bridge.setEnabled(true);
    if (failure === 'spawn-error') options.spawn.mockImplementation(() => { throw new Error('SPAWN_FAILED'); });
    else if (failure === 'read-error') bundle.completion.mockRejectedValue(new Error('unreadable'));
    else bundle.completion.mockResolvedValue('failed');
    await control.start();
    await vi.waitFor(() => expect(bridge.snapshot().sessionStatus.client).toBe(failure === 'read-error' ? 'unknown' : 'failed'));
    expect(bridge.snapshot().sessionStatus.connected).toBe(false);
  });
  it.each(['replace', 'disable'])('ignores delayed completion after %s', async action => {
    const { bridge, bundle, control } = setup(); await bridge.setEnabled(true); await control.start();
    let release!: (state: 'exited') => void;
    bundle.completion.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeDefined());
    const transition = action === 'replace' ? bridge.prepareLaunch() : bridge.setEnabled(false);
    await Promise.resolve(); await Promise.resolve();
    release('exited'); await transition;
    expect(bridge.snapshot().sessionStatus.client).toBe(action === 'replace' ? 'starting' : 'unknown');
  });
  it('bounds stuck status reads without retaining credentials or claiming failure/exit', async () => {
    const { bridge, bundle, options } = setup(); await bridge.setEnabled(true);
    const control = new CommunicationSessionControl({ ...options, statusReadMs: 20 });
    bundle.completion.mockImplementation(() => new Promise(() => {}));
    await control.start(); const id = bridge.currentLaunchId()!;
    expect(await bridge.notifyClaudeExit(id)).toEqual({ ok: true });
    expect(bundle.cleanup).toHaveBeenCalledOnce();
    expect(bridge.snapshot().sessionStatus).toMatchObject({ client: 'unknown', connected: false });
  });
  it('retains a failed rollback of partially created launch files', async () => {
    const { bridge, options, control } = setup(); await bridge.setEnabled(true);
    options.prepare.mockRejectedValue(new Error('LAUNCH_CONFIG_CLEANUP_FAILED'));
    expect(await control.start()).toEqual({ ok: false, code: 'LAUNCH_CONFIG_CLEANUP_FAILED' });
    expect(bridge.snapshot().cleanup).toBe('failed');
    expect(await bridge.setEnabled(true)).toEqual({ ok: false, code: 'CLEANUP_FAILED' });
    expect(options.spawn).not.toHaveBeenCalled();
  });
  it('does not start an exit poll after a synchronous spawn exit', async () => {
    const { bridge, bundle, options, control } = setup();
    await bridge.setEnabled(true);
    options.spawn.mockImplementation((_bundle, exited) => exited());
    const timer = vi.spyOn(globalThis, 'setInterval');
    try {
      expect(await control.start()).toEqual({ ok: false, code: 'LAUNCH_FAILED' });
      expect(timer).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(bundle.cleanup).toHaveBeenCalledTimes(1));
    } finally { timer.mockRestore(); }
  });
  it('does not start disabled or cancelled sessions', async () => {
    const { bridge, options, control } = setup();
    expect(await control.start()).toEqual({ ok: false, code: 'DISABLED' });
    await bridge.setEnabled(true); options.confirm.mockResolvedValue(false);
    expect(await control.start()).toEqual({ ok: false, code: 'CANCELLED' });
    expect(options.prepare).not.toHaveBeenCalled(); expect(options.spawn).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent intent and observes real Claude exit while shell remains', async () => {
    const { bridge, options, bundle, control } = setup(); await bridge.setEnabled(true);
    const first = control.start();
    expect(await control.start()).toEqual({ ok: false, code: 'BUSY' });
    expect(await first).toEqual({ ok: true }); expect(options.spawn).toHaveBeenCalledTimes(1);
    expect(bridge.currentLaunchId()).toBeDefined(); bundle.completion.mockResolvedValue('exited');
    await vi.waitFor(() => expect(bridge.currentLaunchId()).toBeUndefined());
    await vi.waitFor(() => expect(bundle.cleanup).toHaveBeenCalledTimes(1));
  });
  it('owns files created after disable and never spawns from them', async () => {
    const { bridge, bundle, control, options } = setup(); await bridge.setEnabled(true);
    let resolve!: (value: typeof bundle) => void;
    options.prepare.mockImplementation(() => new Promise(done => { resolve = done; }));
    const starting = control.start(); await vi.waitFor(() => expect(options.prepare).toHaveBeenCalled());
    const stopping = bridge.setEnabled(false); resolve(bundle);
    expect(await starting).toEqual({ ok: false, code: 'REVOKED' });
    expect(await stopping).toEqual({ ok: true }); expect(options.spawn).not.toHaveBeenCalled();
    expect(bundle.cleanup).toHaveBeenCalledTimes(1);
  });
  it('revokes failed preparation without replacing the old terminal', async () => {
    const { bridge, options, control } = setup(); await bridge.setEnabled(true);
    options.prepare.mockRejectedValue(new Error('MCP_NAME_COLLISION'));
    expect(await control.start()).toEqual({ ok: false, code: 'MCP_NAME_COLLISION' });
    expect(options.spawn).not.toHaveBeenCalled(); expect(bridge.currentLaunchId()).toBeUndefined();
  });
});
