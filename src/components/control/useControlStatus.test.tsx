// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useControlStatus } from './useControlStatus';
import type { ControlStatus } from '../../shared/remote/types';

function mkStatus(patch: Partial<ControlStatus> = {}): ControlStatus {
  return { state: 'on', reason: null, address: '100.1.2.3:47821', connected: 0, devices: [], pairingActive: false, reenableAtLaunch: false, notice: null, ...patch };
}
function Probe({ out }: { out: { v: ControlStatus | null } }) { out.v = useControlStatus(); return null; }
function bridge(control: unknown) { (window as unknown as { aetherElectron: unknown }).aetherElectron = { control }; }
afterEach(() => { cleanup(); delete (window as { aetherElectron?: unknown }).aetherElectron; vi.restoreAllMocks(); });

describe('useControlStatus', () => {
  it('returns null in browser mode', () => {
    const out = { v: mkStatus() as ControlStatus | null };
    render(<Probe out={out} />);
    expect(out.v).toBeNull();
  });
  it('reads status once, follows pushes, unsubscribes on unmount, touches no storage', async () => {
    const unsub = vi.fn();
    let push: (s: ControlStatus) => void = () => {};
    const status = vi.fn().mockResolvedValue(mkStatus({ connected: 1 }));
    bridge({ status, onStatus: (cb: (s: ControlStatus) => void) => { push = cb; return unsub; } });
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const out = { v: null as ControlStatus | null };
    const view = render(<Probe out={out} />);
    await act(async () => {});
    expect(status).toHaveBeenCalledTimes(1);
    expect(out.v?.connected).toBe(1);
    act(() => push(mkStatus({ connected: 2 })));
    expect(out.v?.connected).toBe(2);
    expect(unsub).not.toHaveBeenCalled();
    view.unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it('a push that lands before status() resolves is not overwritten by the stale read', async () => {
    let resolve: (s: ControlStatus) => void = () => {};
    let push: (s: ControlStatus) => void = () => {};
    const status = vi.fn(() => new Promise<ControlStatus>(r => { resolve = r; }));
    bridge({ status, onStatus: (cb: (s: ControlStatus) => void) => { push = cb; return vi.fn(); } });
    const out = { v: null as ControlStatus | null };
    render(<Probe out={out} />);
    act(() => push(mkStatus({ connected: 1 })));
    await act(async () => { resolve(mkStatus({ connected: 0 })); });
    expect(out.v?.connected).toBe(1);
  });
  it('unmount before status() resolves unsubscribes once and ignores the late result', async () => {
    let resolve: (s: ControlStatus) => void = () => {};
    const unsub = vi.fn();
    const status = vi.fn(() => new Promise<ControlStatus>(r => { resolve = r; }));
    bridge({ status, onStatus: () => unsub });
    const err = vi.spyOn(console, 'error');
    const out = { v: null as ControlStatus | null };
    const view = render(<Probe out={out} />);
    view.unmount();
    await act(async () => { resolve(mkStatus({ connected: 2 })); });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(out.v).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });
  it('swallows a rejected status() and still follows pushes', async () => {
    let push: (s: ControlStatus) => void = () => {};
    bridge({ status: vi.fn().mockRejectedValue(new Error('x')), onStatus: (cb: (s: ControlStatus) => void) => { push = cb; return vi.fn(); } });
    const out = { v: null as ControlStatus | null };
    render(<Probe out={out} />);
    await act(async () => {});
    expect(out.v).toBeNull();
    act(() => push(mkStatus({ connected: 1 })));
    expect(out.v?.connected).toBe(1);
  });
});
