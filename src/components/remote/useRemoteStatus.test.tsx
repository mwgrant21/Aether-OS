// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRemoteStatus } from './useRemoteStatus';
import type { RemoteStatus } from '../../shared/remote/types';

function mkStatus(patch: Partial<RemoteStatus> = {}): RemoteStatus {
  return { state: 'on', reason: null, address: '100.1.2.3:47821', clients: 0, sessions: [], pairingActive: false, following: true, notice: null, ...patch };
}
function Probe({ out }: { out: { v: RemoteStatus | null } }) { out.v = useRemoteStatus(); return null; }
afterEach(() => { cleanup(); delete (window as { aetherElectron?: unknown }).aetherElectron; vi.restoreAllMocks(); });

describe('useRemoteStatus', () => {
  it('returns null in browser mode', () => {
    const out = { v: mkStatus() as RemoteStatus | null };
    render(<Probe out={out} />);
    expect(out.v).toBeNull();
  });
  it('reads status once, follows pushes, unsubscribes on unmount, touches no storage', async () => {
    const unsub = vi.fn();
    let push: (s: RemoteStatus) => void = () => {};
    const status = vi.fn().mockResolvedValue(mkStatus({ clients: 1 }));
    const onStatus = vi.fn((cb: (s: RemoteStatus) => void) => { push = cb; return unsub; });
    (window as unknown as { aetherElectron: unknown }).aetherElectron = { remote: { status, onStatus } };
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const out = { v: null as RemoteStatus | null };
    const view = render(<Probe out={out} />);
    await act(async () => {});
    expect(status).toHaveBeenCalledTimes(1);
    expect(out.v?.clients).toBe(1);
    act(() => push(mkStatus({ clients: 3 })));
    expect(out.v?.clients).toBe(3);
    expect(unsub).not.toHaveBeenCalled();
    view.unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it('a push that lands before status() resolves is not overwritten by the stale read', async () => {
    let resolve: (s: RemoteStatus) => void = () => {};
    let push: (s: RemoteStatus) => void = () => {};
    const status = vi.fn(() => new Promise<RemoteStatus>(r => { resolve = r; }));
    (window as unknown as { aetherElectron: unknown }).aetherElectron = { remote: { status, onStatus: (cb: (s: RemoteStatus) => void) => { push = cb; return vi.fn(); } } };
    const out = { v: null as RemoteStatus | null };
    render(<Probe out={out} />);
    act(() => push(mkStatus({ clients: 1 })));
    await act(async () => { resolve(mkStatus({ clients: 0 })); });
    expect(out.v?.clients).toBe(1);
  });
  it('unmount before status() resolves unsubscribes once and ignores the late result', async () => {
    let resolve: (s: RemoteStatus) => void = () => {};
    const unsub = vi.fn();
    const status = vi.fn(() => new Promise<RemoteStatus>(r => { resolve = r; }));
    (window as unknown as { aetherElectron: unknown }).aetherElectron = { remote: { status, onStatus: () => unsub } };
    const err = vi.spyOn(console, 'error');
    const out = { v: null as RemoteStatus | null };
    const view = render(<Probe out={out} />);
    view.unmount();
    await act(async () => { resolve(mkStatus({ clients: 2 })); });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(out.v).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });
});
