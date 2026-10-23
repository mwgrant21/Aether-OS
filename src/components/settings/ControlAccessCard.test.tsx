// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ControlAccessCard } from './ControlAccessCard';
import type { ControlPairingResult, ControlStatus, RemoteSessionInfo } from '../../shared/remote/types';

function mkStatus(patch: Partial<ControlStatus> = {}): ControlStatus {
  return { state: 'on', reason: null, address: '100.1.2.3:47821', connected: 1, devices: [], pairingActive: false, reenableAtLaunch: false, notice: null, ...patch };
}
function mkDevice(ref: string, patch: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo {
  return { ref, createdAtMs: Date.now() - 3600_000, expiresAtMs: Date.now() + 86400_000 * 20, lastSeenMs: Date.now() - 120_000, peer: '100.94.15.125', ...patch };
}
const okPairing = (ttlMs = 90_000): ControlPairingResult => ({ ok: true, uri: 'aethermobile://pair?host=100.1.2.3&port=47821&code=ABCD-1234', code: 'ABCD-1234', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', expiresAtMs: Date.now() + ttlMs });

interface Opts {
  status?: ControlStatus;
  setEnabled?: ControlStatus;
  setReenableAtLaunch?: ControlStatus;
  pairing?: ControlPairingResult;
}
function install(o: Opts = {}) {
  let push: (s: ControlStatus) => void = () => {};
  const control = {
    status: vi.fn().mockResolvedValue(o.status ?? mkStatus()),
    setEnabled: vi.fn().mockResolvedValue(o.setEnabled ?? mkStatus()),
    setReenableAtLaunch: vi.fn().mockResolvedValue(o.setReenableAtLaunch ?? mkStatus()),
    createPairing: vi.fn().mockResolvedValue(o.pairing ?? okPairing()),
    revokeAll: vi.fn().mockResolvedValue(mkStatus()),
    revokeOne: vi.fn().mockResolvedValue(mkStatus()),
    onStatus: vi.fn((cb: (s: ControlStatus) => void) => { push = cb; return vi.fn(); }),
  };
  (window as unknown as { aetherElectron: unknown }).aetherElectron = { control };
  return { control, push: (s: ControlStatus) => push(s) };
}
const settle = () => act(async () => {});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete (window as { aetherElectron?: unknown }).aetherElectron;
  vi.restoreAllMocks();
});

async function pairFlow(o: Opts = {}) {
  const h = install(o);
  render(<ControlAccessCard />);
  await settle();
  fireEvent.click(screen.getByText('PAIR AN APP'));
  await settle();
  return h;
}

describe('ControlAccessCard', () => {
  it('shows a no-bridge message in browser mode', () => {
    render(<ControlAccessCard />);
    expect(screen.getByText('Available in the desktop app')).toBeTruthy();
  });

  it('off state shows ENABLE, no pair button or launch toggle, but the paired list', async () => {
    install({ status: mkStatus({ state: 'off', address: null, connected: 0, devices: [mkDevice('abcdef123456')] }) });
    render(<ControlAccessCard />);
    await settle();
    expect(screen.getByText('PHONE CONTROL (TYPING + APPROVALS)')).toBeTruthy();
    expect(screen.getByText('ENABLE')).toBeTruthy();
    expect(screen.queryByText('PAIR AN APP')).toBeNull();
    expect(screen.queryByText('RE-ENABLE AT LAUNCH')).toBeNull();
    expect(screen.getByText(/id abcdef/)).toBeTruthy();
    expect(screen.getByTestId('control-status-line').textContent).toBe('off');
    expect(screen.getByText(/equivalent to your keyboard/)).toBeTruthy();
  });

  it('enable calls setEnabled(true) and renders the readback, not the request', async () => {
    const { control } = install({
      status: mkStatus({ state: 'off', address: null }),
      setEnabled: mkStatus({ state: 'unavailable', reason: 'no-tailnet-address', address: null }),
    });
    render(<ControlAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('ENABLE'));
    await settle();
    expect(control.setEnabled).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('control-status-line').textContent).toContain('Tailscale address not found');
    expect(screen.queryByText('PAIR AN APP')).toBeNull();
  });

  it('on state shows address and app count; DISABLE calls setEnabled(false)', async () => {
    const { control } = install({ status: mkStatus({ connected: 2 }), setEnabled: mkStatus({ state: 'off', address: null }) });
    render(<ControlAccessCard />);
    await settle();
    expect(screen.getByTestId('control-status-line').textContent).toBe('on - 100.1.2.3:47821 - 2 apps connected');
    fireEvent.click(screen.getByText('DISABLE'));
    await settle();
    expect(control.setEnabled).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('control-status-line').textContent).toBe('off');
  });

  it('re-enable toggle shows the persisted state only while on and calls setReenableAtLaunch', async () => {
    const { control } = install({ status: mkStatus({ reenableAtLaunch: false }), setReenableAtLaunch: mkStatus({ reenableAtLaunch: true }) });
    render(<ControlAccessCard />);
    await settle();
    const box = screen.getByLabelText('RE-ENABLE AT LAUNCH') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await settle();
    expect(control.setReenableAtLaunch).toHaveBeenCalledWith(true);
    expect((screen.getByLabelText('RE-ENABLE AT LAUNCH') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Disabling phone control clears this setting/)).toBeTruthy();
  });

  it('pairing shows QR image, code, countdown and the confirm hint, never a link', async () => {
    const { control } = await pairFlow();
    expect(control.createPairing).toHaveBeenCalled();
    const img = screen.getByAltText('Pairing QR code') as HTMLImageElement;
    expect(img.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    expect(screen.getByText(/Expires in 01:/)).toBeTruthy();
    expect(screen.getByText(/asked to confirm on this PC/)).toBeTruthy();
    expect(document.querySelector('a')).toBeNull();
    expect(document.body.textContent).not.toContain('aethermobile://');
  });

  it('says a new phone REPLACES the paired one only when one exists', async () => {
    install({ status: mkStatus({ devices: [mkDevice('abcdef123456')] }) });
    render(<ControlAccessCard />);
    await settle();
    expect(screen.getAllByText(/REPLACES the currently paired/).length).toBeGreaterThan(0);
    cleanup();
    install({ status: mkStatus() });
    render(<ControlAccessCard />);
    await settle();
    expect(screen.queryByText(/REPLACES/)).toBeNull();
  });

  it('the code and QR clear at expiry', async () => {
    vi.useFakeTimers();
    await pairFlow({ pairing: okPairing(3_000) });
    expect(screen.getByAltText('Pairing QR code')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(screen.queryByAltText('Pairing QR code')).toBeNull();
    expect(screen.queryByText('ABCD-1234')).toBeNull();
  });

  it('the code and QR are cleared when the state leaves on', async () => {
    const { push } = await pairFlow();
    expect(screen.getByAltText('Pairing QR code')).toBeTruthy();
    act(() => push(mkStatus({ state: 'off', address: null })));
    await settle();
    expect(screen.queryByAltText('Pairing QR code')).toBeNull();
    expect(screen.queryByText('ABCD-1234')).toBeNull();
  });

  it('a createPairing result that lands after the state left on is dropped', async () => {
    let resolve: (r: ControlPairingResult) => void = () => {};
    const h = install();
    h.control.createPairing.mockReturnValue(new Promise<ControlPairingResult>(r => { resolve = r; }));
    render(<ControlAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('PAIR AN APP'));
    act(() => h.push(mkStatus({ state: 'off', address: null })));
    await settle();
    await act(async () => { resolve(okPairing()); });
    expect(screen.queryByAltText('Pairing QR code')).toBeNull();
    expect(screen.queryByText('ABCD-1234')).toBeNull();
  });

  it('a createPairing result issued before an off/on cycle is dropped', async () => {
    let resolve: (r: ControlPairingResult) => void = () => {};
    const h = install();
    h.control.createPairing.mockReturnValue(new Promise<ControlPairingResult>(r => { resolve = r; }));
    render(<ControlAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('PAIR AN APP'));
    act(() => h.push(mkStatus({ state: 'off', address: null })));
    await settle();
    act(() => h.push(mkStatus()));
    await settle();
    await act(async () => { resolve(okPairing()); });
    expect(screen.queryByAltText('Pairing QR code')).toBeNull();
    expect(screen.queryByText('ABCD-1234')).toBeNull();
  });

  it('Done clears the code', async () => {
    await pairFlow();
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByAltText('Pairing QR code')).toBeNull();
  });

  it('lists devices with peer and ticks last seen live', async () => {
    vi.useFakeTimers();
    install({ status: mkStatus({ devices: [mkDevice('abcdef123456', { lastSeenMs: Date.now() })] }) });
    render(<ControlAccessCard />);
    await settle();
    expect(screen.getByText(/100\.94\.15\.125/)).toBeTruthy();
    expect(screen.getByText(/last seen just now/)).toBeTruthy();
    expect(screen.getByText(/20 d left/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(125_000); });
    expect(screen.getByText(/last seen 2 min ago/)).toBeTruthy();
  });

  it('per-row REVOKE and REVOKE ALL APPS call the matching API and adopt the readback', async () => {
    const { control } = install({ status: mkStatus({ devices: [mkDevice('abcdef123456')] }) });
    render(<ControlAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('REVOKE'));
    await settle();
    expect(control.revokeOne).toHaveBeenCalledWith('abcdef123456');
    expect(screen.getByText('No apps paired')).toBeTruthy();
    cleanup();
    const h2 = install({ status: mkStatus({ devices: [mkDevice('abcdef123456')] }) });
    render(<ControlAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('REVOKE ALL APPS'));
    await settle();
    expect(h2.control.revokeAll).toHaveBeenCalled();
  });

  it('shows status.notice as an alert near the revoke buttons', async () => {
    install({ status: mkStatus({ notice: 'Revoke not saved to disk yet', devices: [mkDevice('abcdef123456')] }) });
    render(<ControlAccessCard />);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Revoke not saved to disk yet');
  });

  it('a failed call shows a message', async () => {
    const { control } = install({ status: mkStatus({ state: 'off', address: null }) });
    control.setEnabled.mockRejectedValue(new Error('boom'));
    render(<ControlAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('ENABLE'));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Could not change phone control.');
  });
});
