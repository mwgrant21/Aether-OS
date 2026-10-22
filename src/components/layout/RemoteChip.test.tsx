// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RemoteChip } from './RemoteChip';
import type { RemoteStatus } from '../../shared/remote/types';

function mkStatus(patch: Partial<RemoteStatus> = {}): RemoteStatus {
  return { state: 'on', reason: null, address: '100.1.2.3:47821', clients: 0, sessions: [], pairingActive: false, following: true, notice: null, ...patch };
}
const store = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('../../state/store', () => ({ useAetherStore: () => store }));
vi.mock('../shared/useColors', () => ({ useColors: () => ({ warn: '#f90', panelInset: '#111' }) }));

function install(initial: RemoteStatus) {
  let push: (s: RemoteStatus) => void = () => {};
  const unsub = vi.fn();
  const status = vi.fn().mockResolvedValue(initial);
  (window as unknown as { aetherElectron: unknown }).aetherElectron = {
    remote: { status, onStatus: (cb: (s: RemoteStatus) => void) => { push = cb; return unsub; } },
  };
  return { push: (s: RemoteStatus) => act(() => push(s)), unsub, status };
}
afterEach(() => { cleanup(); store.dispatch.mockClear(); delete (window as { aetherElectron?: unknown }).aetherElectron; vi.restoreAllMocks(); });

describe('RemoteChip', () => {
  it('is hidden at 0 clients and when the bridge is absent', async () => {
    render(<RemoteChip />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    install(mkStatus({ state: 'on', clients: 0 }));
    render(<RemoteChip />);
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('appears on a push of 1 client and disappears at 0 without a refresh', async () => {
    const h = install(mkStatus());
    render(<RemoteChip />);
    await act(async () => {});
    h.push(mkStatus({ clients: 1 }));
    expect(screen.getByRole('button').textContent).toContain('PHONE CONNECTED');
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Phone connected, read-only chat view');
    h.push(mkStatus({ clients: 0 }));
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows the count for 2', async () => {
    install(mkStatus({ clients: 2 }));
    render(<RemoteChip />);
    await act(async () => {});
    expect(screen.getByRole('button').textContent).toContain('PHONE - 2 connected');
  });
  it('click opens Settings', async () => {
    install(mkStatus({ clients: 1 }));
    render(<RemoteChip />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button'));
    expect(store.dispatch).toHaveBeenCalledWith({ type: 'SET_ACTIVE_TAB', tab: 'Settings' });
  });
  it('announces 0 -> 1 and 1 -> 0 in a polite live region', async () => {
    const h = install(mkStatus());
    render(<RemoteChip />);
    await act(async () => {});
    const region = () => document.querySelector('[aria-live="polite"]')!;
    expect(region().textContent).toBe('');
    h.push(mkStatus({ clients: 1 }));
    expect(region().textContent).toBe('Phone connected');
    h.push(mkStatus({ clients: 2 }));
    expect(region().textContent).toBe('Phone connected');
    h.push(mkStatus({ clients: 0 }));
    expect(region().textContent).toBe('Phone disconnected');
  });
  it('unsubscribes on unmount and leaves storage alone', async () => {
    const h = install(mkStatus({ clients: 1 }));
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(<RemoteChip />);
    await act(async () => {});
    expect(h.status).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(h.unsub).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it('keeps the same live-region element across 0 -> 1 -> 0', async () => {
    const h = install(mkStatus());
    render(<RemoteChip />);
    await act(async () => {});
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBeNull();
    h.push(mkStatus({ clients: 1 }));
    expect(document.querySelector('[aria-live="polite"]')).toBe(region);
    h.push(mkStatus({ clients: 0 }));
    expect(document.querySelector('[aria-live="polite"]')).toBe(region);
  });
  it('still shows the chip on a push after a rejected status()', async () => {
    let push: (s: RemoteStatus) => void = () => {};
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      remote: { status: vi.fn().mockRejectedValue(new Error('x')), onStatus: (cb: (s: RemoteStatus) => void) => { push = cb; return vi.fn(); } },
    };
    render(<RemoteChip />);
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
    act(() => push(mkStatus({ clients: 1 })));
    expect(screen.getByRole('button')).toBeTruthy();
  });
});
