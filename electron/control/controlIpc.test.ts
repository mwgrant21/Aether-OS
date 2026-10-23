// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { registerControlIpc, type ControlHubLike } from './controlIpc';
import type { ControlStatus } from '../../src/shared/remote/types';

const STATUS: ControlStatus = { state: 'off', reason: null, address: null, connected: 0, devices: [], pairingActive: false, reenableAtLaunch: false, notice: null };

function setup(opts: { trusted?: boolean; confirmEnable?: boolean; confirmReenable?: boolean } = {}) {
  const hub = {
    init: vi.fn(), status: vi.fn(() => STATUS), setEnabled: vi.fn(async () => STATUS), setReenableAtLaunch: vi.fn(async () => STATUS),
    createPairing: vi.fn(async () => ({ ok: false as const, reason: 'not-enabled' as const })),
    revokeAll: vi.fn(async () => STATUS), revokeOne: vi.fn(async () => STATUS),
  };
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const confirmEnable = vi.fn(async () => opts.confirmEnable ?? true);
  const confirmReenable = vi.fn(async () => opts.confirmReenable ?? true);
  registerControlIpc({ handle: (c: string, h: never) => { handlers.set(c, h); } } as never, hub as unknown as ControlHubLike, () => opts.trusted ?? true, confirmEnable, confirmReenable);
  const call = (ch: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!({}, ...args));
  return { hub, call, confirmEnable, confirmReenable, handlers };
}

describe('registerControlIpc', () => {
  it('registers exactly the six control channels', () => {
    expect([...setup().handlers.keys()].sort()).toEqual([
      'control:createPairing', 'control:revokeAll', 'control:revokeOne', 'control:setEnabled', 'control:setReenableAtLaunch', 'control:status',
    ]);
  });

  it('rejects an untrusted sender on every channel without touching the hub or either dialog', async () => {
    const { hub, call, confirmEnable, confirmReenable, handlers } = setup({ trusted: false });
    for (const ch of handlers.keys()) {
      const args = ch === 'control:revokeOne' ? ['a'.repeat(12)] : ch.endsWith('Enabled') || ch.endsWith('Launch') ? [true] : [];
      await expect(call(ch, ...args)).rejects.toThrow('NOT_AUTHORIZED');
    }
    expect(Object.values(hub).every(f => f.mock.calls.length === 0)).toBe(true);
    expect(confirmEnable).not.toHaveBeenCalled();
    expect(confirmReenable).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments', async () => {
    const { hub, call } = setup();
    for (const ch of ['control:setEnabled', 'control:setReenableAtLaunch']) {
      await expect(call(ch, 'yes')).rejects.toThrow('INVALID_INPUT');
      await expect(call(ch)).rejects.toThrow('INVALID_INPUT');
      await expect(call(ch, true, 1)).rejects.toThrow('INVALID_INPUT');
    }
    await expect(call('control:revokeOne', 'zz')).rejects.toThrow('INVALID_INPUT');
    await expect(call('control:revokeOne', 'a'.repeat(64))).rejects.toThrow('INVALID_INPUT');
    await expect(call('control:revokeOne', 'A'.repeat(12))).rejects.toThrow('INVALID_INPUT');
    await expect(call('control:revokeOne', 'a'.repeat(12), 'x')).rejects.toThrow('INVALID_INPUT');
    for (const ch of ['control:status', 'control:createPairing', 'control:revokeAll']) await expect(call(ch, 1)).rejects.toThrow('INVALID_INPUT');
    expect(hub.setEnabled).not.toHaveBeenCalled();
    expect(hub.setReenableAtLaunch).not.toHaveBeenCalled();
    expect(hub.revokeOne).not.toHaveBeenCalled();
  });

  it('a declined enable confirm returns the current status without calling the hub', async () => {
    const { hub, call, confirmEnable } = setup({ confirmEnable: false });
    await expect(call('control:setEnabled', true)).resolves.toBe(STATUS);
    expect(confirmEnable).toHaveBeenCalledTimes(1);
    expect(hub.setEnabled).not.toHaveBeenCalled();
  });

  it('a declined re-enable confirm returns the current status without calling the hub', async () => {
    const { hub, call, confirmReenable } = setup({ confirmReenable: false });
    await expect(call('control:setReenableAtLaunch', true)).resolves.toBe(STATUS);
    expect(confirmReenable).toHaveBeenCalledTimes(1);
    expect(hub.setReenableAtLaunch).not.toHaveBeenCalled();
  });

  it('confirms before turning ON and never prompts for OFF', async () => {
    const { hub, call, confirmEnable, confirmReenable } = setup();
    await call('control:setEnabled', true);
    await call('control:setReenableAtLaunch', true);
    expect(hub.setEnabled).toHaveBeenCalledWith(true);
    expect(hub.setReenableAtLaunch).toHaveBeenCalledWith(true);
    confirmEnable.mockClear();
    confirmReenable.mockClear();
    await call('control:setEnabled', false);
    await call('control:setReenableAtLaunch', false);
    expect(confirmEnable).not.toHaveBeenCalled();
    expect(confirmReenable).not.toHaveBeenCalled();
    expect(hub.setEnabled).toHaveBeenLastCalledWith(false);
    expect(hub.setReenableAtLaunch).toHaveBeenLastCalledWith(false);
  });

  it('the enable confirm is not used for the re-enable setting', async () => {
    const { call, confirmEnable } = setup();
    await call('control:setReenableAtLaunch', true);
    expect(confirmEnable).not.toHaveBeenCalled();
  });

  it('calls hub.init first and forwards the valid commands', async () => {
    const { hub, call } = setup();
    await call('control:status'); await call('control:createPairing'); await call('control:revokeAll'); await call('control:revokeOne', 'abcdef012345');
    expect(hub.init).toHaveBeenCalledTimes(4);
    expect(hub.createPairing).toHaveBeenCalledTimes(1);
    expect(hub.revokeAll).toHaveBeenCalledTimes(1);
    expect(hub.revokeOne).toHaveBeenCalledWith('abcdef012345');
  });
});
