// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ControlChip } from './ControlChip';
import type { ControlStatus } from '../../shared/remote/types';

function mkStatus(patch: Partial<ControlStatus> = {}): ControlStatus {
  return { state: 'on', reason: null, address: '100.1.2.3:47821', connected: 0, devices: [], pairingActive: false, reenableAtLaunch: false, notice: null, ...patch };
}
const store = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('../../state/store', () => ({ useAetherStore: () => store }));
vi.mock('../shared/useColors', () => ({ useColors: () => ({ danger: '#ff6666', warn: '#ff9900', bgBase: '#222222', panelInset: '#111111' }) }));

function install(initial: ControlStatus) {
  let push: (s: ControlStatus) => void = () => {};
  const unsub = vi.fn();
  const status = vi.fn().mockResolvedValue(initial);
  (window as unknown as { aetherElectron: unknown }).aetherElectron = {
    control: { status, onStatus: (cb: (s: ControlStatus) => void) => { push = cb; return unsub; } },
  };
  return { push: (s: ControlStatus) => act(() => push(s)), unsub, status };
}
afterEach(() => { cleanup(); store.dispatch.mockClear(); delete (window as { aetherElectron?: unknown }).aetherElectron; vi.restoreAllMocks(); });

describe('ControlChip', () => {
  it('is hidden at 0 connected and when the bridge is absent', async () => {
    render(<ControlChip />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    install(mkStatus({ state: 'on', connected: 0 }));
    render(<ControlChip />);
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('appears on a push of 1 with the exact label and disappears at 0; never says PHONE CONNECTED', async () => {
    const h = install(mkStatus());
    render(<ControlChip />);
    await act(async () => {});
    h.push(mkStatus({ connected: 1 }));
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('PHONE CONTROL - connected');
    expect(btn.textContent).not.toContain('PHONE CONNECTED');
    expect(btn.getAttribute('aria-label')).not.toContain('PHONE CONNECTED');
    h.push(mkStatus({ connected: 0 }));
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows the count for 2 and uses the danger colour', async () => {
    install(mkStatus({ connected: 2 }));
    render(<ControlChip />);
    await act(async () => {});
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.textContent).toBe('PHONE CONTROL - 2 connected');
    expect(btn.style.color).toBe('rgb(255, 102, 102)');
    expect(btn.style.borderColor).toBe('rgb(255, 102, 102)');
    expect(btn.style.background).toBe('rgb(34, 34, 34)');
  });
  it('click opens Settings', async () => {
    install(mkStatus({ connected: 1 }));
    render(<ControlChip />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button'));
    expect(store.dispatch).toHaveBeenCalledWith({ type: 'SET_ACTIVE_TAB', tab: 'Settings' });
  });
  it('announces 0 -> 1 and 1 -> 0 in a polite live region that stays the same element', async () => {
    const h = install(mkStatus());
    render(<ControlChip />);
    await act(async () => {});
    const region = document.querySelector('[aria-live="polite"]')!;
    expect(region.textContent).toBe('');
    h.push(mkStatus({ connected: 1 }));
    expect(document.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toBe('Phone control connected');
    h.push(mkStatus({ connected: 2 }));
    expect(region.textContent).toBe('Phone control connected');
    h.push(mkStatus({ connected: 0 }));
    expect(document.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toBe('Phone control disconnected');
  });
  it('unsubscribes on unmount and leaves storage alone', async () => {
    const h = install(mkStatus({ connected: 1 }));
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(<ControlChip />);
    await act(async () => {});
    expect(h.status).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(h.unsub).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it('a rejected status() is swallowed and a later push still shows the chip', async () => {
    let push: (s: ControlStatus) => void = () => {};
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      control: { status: vi.fn().mockRejectedValue(new Error('x')), onStatus: (cb: (s: ControlStatus) => void) => { push = cb; return vi.fn(); } },
    };
    render(<ControlChip />);
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
    act(() => push(mkStatus({ connected: 1 })));
    expect(screen.getByRole('button')).toBeTruthy();
  });
  it('a late pull after a push does not hide the chip', async () => {
    let resolve: (s: ControlStatus) => void = () => {};
    let push: (s: ControlStatus) => void = () => {};
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      control: { status: () => new Promise<ControlStatus>(r => { resolve = r; }), onStatus: (cb: (s: ControlStatus) => void) => { push = cb; return vi.fn(); } },
    };
    render(<ControlChip />);
    act(() => push(mkStatus({ connected: 1 })));
    await act(async () => { resolve(mkStatus({ connected: 0 })); });
    expect(screen.getByRole('button')).toBeTruthy();
  });
});
