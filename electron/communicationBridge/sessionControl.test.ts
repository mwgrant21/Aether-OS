// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommunicationBridgeIntegration } from './mainIntegration';
import { CommunicationSessionControl } from './sessionControl';
const services: CommunicationBridgeIntegration[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });
function setup() {
  const bridge = new CommunicationBridgeIntegration({ providerFactory: () => { throw new Error('No model calls'); } });
  services.push(bridge);
  const bundle = { cleanup: vi.fn(async () => {}), completion: vi.fn(async () => 'running' as 'running' | 'exited') };
  const options = { bridge, confirm: vi.fn(async () => true), prepare: vi.fn(async () => bundle), spawn: vi.fn(), pollMs: 5 };
  return { bridge, bundle, options, control: new CommunicationSessionControl(options) };
}
describe('operator session control', () => {
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
